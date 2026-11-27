/* eslint-disable no-console, max-lines, max-lines-per-function -- an operator CLI that scripts the eight-step journey */
/**
 * the eight-step journey of docs/JOURNEY.md, scripted end to end against any
 * Medissy origin (local `pnpm dev` or the Sprite); every A2A call goes
 * through the generic client skill; every person's action goes through the
 * real issuer and portal forms with that persona's passphrase: the owner at
 * `/demo-idp`, the cardiologist at the Northgate Health institution
 * `/institution-idp` (ADR-9)
 *
 * usage: pnpm journey <origin> [--env-file <path>]
 * needs DEMO_IDP_SECRET_OWNER and DEMO_IDP_SECRET_CARDIOLOGIST (plaintext,
 * matching the server); passphrases, cookies, task ids, user codes and the
 * share link are registered with the redactor and never printed;
 * step 7 (record hand-back, ADR-10) is NOT RUN when the card says record
 * submission is not available in this deployment;
 * exit code: 0 when no step fails, 1 otherwise
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DISCLOSURE_MEDIA_TYPE,
  disclosureResultSchema,
  SKILL_SUBMIT_RECORD,
  SUBMISSION_MEDIA_TYPE,
  submissionResultSchema,
} from '../src/contracts';
import { DEMO_CARDIOLOGIST } from '../src/demo-idp/users';

import { loadEnvFile, parseCommonArgs, parseOrigin, personaPassphrase } from './lib/env';
import { FIXTURES_ROOT } from './seed';
import { a2a, approveDevice, Browser, check, formIn, portalSignIn, Redactor, StepRunner } from './lib/support';

import type { Env } from './lib/env';
import type { Envelope } from './lib/support';

const WAIT_SECONDS = '90';
const HTTP_SEE_OTHER = 303;
const HTTP_CLIENT_ERROR = 400;
const HTTP_SERVER_ERROR = 500;
const CANARY = (JSON.parse(readFileSync(join(FIXTURES_ROOT, 'manifest.json'), 'utf8')) as { canary: string }).canary;
/** the synthetic question the cardiologist's agent sends */
export const QUESTION = 'SYNTHETIC journey: current cardiac medications and allergies?';
/** the synthetic note the cardiologist's agent hands back (ADR-10) */
export const HAND_BACK = {
  skill: SKILL_SUBMIT_RECORD,
  document: {
    title: 'SYNTHETIC journey cardiology note',
    text: 'SYNTHETIC: reviewed in clinic; continue current medication; follow up in six weeks.',
  },
  category: 'cardiac',
} as const;
/** how the card marks a skill this deployment has not configured */
const NOT_AVAILABLE = 'Not available in this deployment';

/**
 * lists the cards (`<div class="card">…</div>`) of a portal page
 * @param html the page
 * @returns each card's markup
 */
function cards(html: string): string[] {
  return html.split('<div class="card">').slice(1);
}

/**
 * finds the pending connection a requester asked for, from the owner dashboard
 * @param html the dashboard
 * @param subject the requester's subject
 * @returns the connection id, or undefined
 */
export function findPendingConnection(html: string, subject: string): string | undefined {
  const card = cards(html).find(
    (item) => item.includes('Connection request') && item.includes(subject) && !item.includes('lapsed'),
  );

  return card ? /href="\/owner\/confirm\/([^"]+)"/.exec(card)?.[1] : undefined;
}

/**
 * finds the newest active grant for a grantee, from the owner dashboard
 * @param html the dashboard
 * @param subject the grantee's subject
 * @returns the grant id and encounter id, or undefined
 */
export function findActiveGrant(html: string, subject: string): { grantId: string; encounterId: string } | undefined {
  const matches = cards(html).flatMap((item) => {
    const grantId = /action="\/owner\/grants\/([^"/]+)\/revoke"/.exec(item)?.[1];
    const encounterId = /encounter (\S+) · version/.exec(item)?.[1];

    return item.includes(subject) && item.includes('<strong>active</strong>') && grantId && encounterId
      ? [{ grantId, encounterId }]
      : [];
  });

  return matches.at(-1);
}

/**
 * lists the encounters a clinician may ask about, from `/clinician`
 * @param html the clinician page
 * @returns encounter ids
 */
export function encounterOptions(html: string): string[] {
  const select = /<select name="encounterId">([\s\S]*?)<\/select>/.exec(html)?.[1] ?? '';

  return [...select.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1] ?? '');
}

/**
 * lists the record ids a disclosure envelope names
 * @param envelope the envelope
 * @returns unique record ids
 */
export function releasedRecordIds(envelope: Envelope): string[] {
  return [...new Set([...JSON.stringify(envelope.data ?? []).matchAll(/"recordId":"([^"]+)"/g)].map((m) => m[1] ?? ''))];
}

/**
 * requires an AUTH_REQUIRED answer carrying a sign-in, and registers its secrets
 * @param envelope the send envelope
 * @param redactor the redactor
 * @returns the task id and sign-in
 */
function authRequired(envelope: Envelope, redactor: Redactor): { taskId: string; signin: NonNullable<Envelope['signin']> } {
  redactor.add(envelope.taskId, envelope.signin?.userCode);
  check(envelope.state === 'auth-required', `expected auth-required, got ${envelope.state}`);
  check(envelope.taskId && envelope.signin, 'expected a task id and a sign-in link with a user code');
  check(!/access_token|device_code|refresh_token/i.test(JSON.stringify(envelope)), 'a token reached the agent');

  return { taskId: envelope.taskId, signin: envelope.signin };
}

/**
 * runs step 7 (ADR-10): the cardiologist's agent hands a record back, the
 * cardiologist approves the sign-in, the agent gets the filing receipt and
 * the owner sees it with a Remove on /owner; NOT RUN when the card says the
 * deployment has no secure store configured
 * @param context the origin, the runner, the redactor, the owner's signed-in
 * browser and the cardiologist's passphrase
 * @param context.origin the Medissy origin
 * @param context.runner records the step
 * @param context.redactor scrubs task ids and user codes
 * @param context.owner the owner's signed-in portal browser
 * @param context.cardioPass the cardiologist's passphrase
 */
async function handBack(context: {
  origin: string;
  runner: StepRunner;
  redactor: Redactor;
  owner: Browser;
  cardioPass: string;
}): Promise<void> {
  const { origin, runner, redactor, owner, cardioPass } = context;
  const step = { id: '7', title: "cardiologist's agent hands a record back", acceptance: ['A02', 'A03', 'A07'] };
  const card = runner.failed ? undefined : await a2a(origin, ['card', origin]);
  const skill = card?.agent?.skills.find((entry) => entry.id === SKILL_SUBMIT_RECORD) as { description?: string } | undefined;

  if (skill?.description?.includes(NOT_AVAILABLE)) {
    runner.record({ ...step, status: 'NOT RUN', detail: 'record hand-back is not configured on this origin' });

    return;
  }

  await runner.step(step, async () => {
    check(skill, 'the card lists no submit-record skill');

    const sent = authRequired(await a2a(origin, ['send', origin, '--data', JSON.stringify(HAND_BACK)]), redactor);

    await approveDevice(new Browser(origin, redactor), sent.signin, 'cardiologist', cardioPass);

    const done = await a2a(origin, ['wait', origin, sent.taskId, '--timeout', WAIT_SECONDS]);
    const part = done.data?.find((entry) => entry.mediaType === SUBMISSION_MEDIA_TYPE);
    const receipt = submissionResultSchema.safeParse(part?.data);

    check(done.state === 'completed', `expected completed, got ${done.state}`);
    check(receipt.success, 'no schema-valid filing receipt');

    const dashboard = (await owner.open('/owner')).body;

    check(dashboard.includes(receipt.data.filedName), 'the owner does not see the filed record on /owner');
    check(dashboard.includes('/remove"'), 'the owner has no Remove for the filed record');

    return `filed as ${receipt.data.filedName} (${receipt.data.category}); owner sees the receipt with Remove`;
  });
}

/**
 * runs the journey and prints one line per step
 * @param origin the Medissy origin
 * @param env the environment holding the persona passphrases
 * @param print receives each line
 * @returns the runner with every result
 */
export async function runJourney(origin: string, env: Env, print: (line: string) => void): Promise<StepRunner> {
  const redactor = new Redactor();
  const runner = new StepRunner(redactor, print);
  const ownerPass = personaPassphrase(env, 'owner');
  const cardioPass = personaPassphrase(env, 'cardiologist');
  const owner = new Browser(origin, redactor);
  const clinician = new Browser(origin, redactor);
  const state: { shareUrl?: string; clinicalTask?: string; grantId?: string; encounterId?: string; signin?: NonNullable<Envelope['signin']> } = {};

  redactor.add(ownerPass, cardioPass);

  await runner.step({ id: '1', title: "owner's share-code QR over A2A", acceptance: ['A03', 'A02'] }, async () => {
    const card = await a2a(origin, ['card', origin]);

    check(card.state === 'card', `the Agent Card did not validate (${card.state}: ${card.text})`);
    check(card.agent?.skills.some((skill) => skill.id === 'share-code'), 'the card lists no share-code skill');

    const sent = authRequired(await a2a(origin, ['send', origin, '--data', '{"skill":"share-code"}']), redactor);

    await approveDevice(new Browser(origin, redactor), sent.signin, 'owner', ownerPass);

    const done = await a2a(origin, ['wait', origin, sent.taskId, '--timeout', WAIT_SECONDS]);
    const share = done.data?.map((part) => part.data as { url?: unknown }).find((data) => typeof data.url === 'string');

    redactor.add(typeof share?.url === 'string' ? share.url : undefined);
    check(done.state === 'completed', `expected completed, got ${done.state}`);
    check(typeof share?.url === 'string' && share.url.startsWith(`${origin}/connect#`), 'no share link for this origin');
    check(
      done.images?.some((image) => image.mediaType === 'image/png') === true,
      'no PNG QR image in the completed artifact',
    );
    state.shareUrl = share.url;

    return 'QR (png) and single-use share link returned to the owner agent';
  });

  await runner.step({ id: '2', title: 'clinician redeems the share link', acceptance: ['A02', 'A03'] }, async () => {
    const sent = authRequired(
      await a2a(origin, ['send', origin, '--data', JSON.stringify({ skill: 'redeem-invitation', code: state.shareUrl })]),
      redactor,
    );

    await approveDevice(new Browser(origin, redactor), sent.signin, 'cardiologist', cardioPass);

    const done = await a2a(origin, ['wait', origin, sent.taskId, '--timeout', WAIT_SECONDS]);

    check(done.state === 'completed', `expected completed, got ${done.state}`);
    check(done.text.includes('pending patient confirmation'), 'expected "pending patient confirmation"');
    check(done.html === undefined && done.data === undefined, 'a pending connection returned data');

    return 'pending patient confirmation, no data';
  });

  await runner.step({ id: '3', title: 'owner confirms through step-up', acceptance: ['A07', 'A14'] }, async () => {
    await portalSignIn(owner, 'owner', 'owner', ownerPass);

    const dashboard = await owner.open('/owner');
    const connectionId = findPendingConnection(dashboard.body, DEMO_CARDIOLOGIST.subject);

    check(connectionId, 'no pending connection from the cardiologist on /owner (stale state? run pnpm cleanup)');

    const action = `/owner/confirm/${connectionId}`;
    const confirm = await owner.open(action);
    const form = formIn(confirm.body, action);
    const forged = await owner.request('POST', action, { encounter: 'new', categories: 'cardiac' });

    check(
      forged.status >= HTTP_CLIENT_ERROR && forged.status < HTTP_SERVER_ERROR,
      `a confirm POST without the CSRF token answered HTTP ${forged.status}`,
    );

    const posted = await owner.request('POST', action, {
      ...form.hidden,
      encounter: 'new',
      newEncounterReason: 'SYNTHETIC journey run',
      newEncounterDays: '1',
      baseline: 'on',
      categories: ['cardiac'],
      maxSensitivity: 'routine',
      validityHours: '1',
    });

    check(posted.status === HTTP_SEE_OTHER && posted.location?.endsWith('/owner'), `confirm answered HTTP ${posted.status}`);

    const grant = findActiveGrant((await owner.open('/owner')).body, DEMO_CARDIOLOGIST.subject);

    check(grant, 'no active grant for the cardiologist after confirming');
    Object.assign(state, grant);

    return `fresh login (prompt=login), forged POST refused, grant created for encounter ${grant.encounterId} (cardiac + baseline, 1 h)`;
  });

  await runner.step({ id: '4', title: 'clinical request reaches AUTH_REQUIRED', acceptance: ['A02', 'A03'] }, async () => {
    await portalSignIn(clinician, 'clinician', 'cardiologist', cardioPass);

    const encounters = encounterOptions((await clinician.open('/clinician')).body);

    check(encounters.includes(state.encounterId ?? ''), 'the encounter is not offered on /clinician');

    const sent = authRequired(
      await a2a(origin, [
        'send',
        origin,
        '--data',
        JSON.stringify({ skill: 'clinical-evidence-request', encounterId: state.encounterId, question: QUESTION }),
      ]),
      redactor,
    );

    state.clinicalTask = sent.taskId;
    state.signin = sent.signin;

    return 'encounter read from /clinician; AUTH_REQUIRED with sign-in link and user code, no token';
  });

  await runner.step({ id: '5', title: 'device sign-in approved at /institution-idp', acceptance: ['A02'] }, async () => {
    check(state.signin, 'no sign-in to approve');
    check(
      state.signin.verificationUri.startsWith(`${origin}/institution-idp/`),
      'the clinician sign-in is not at the trusted institution',
    );
    await approveDevice(new Browser(origin, redactor), state.signin, 'cardiologist', cardioPass);

    return 'user code typed, confirmed and approved as cardiologist at the institution';
  });

  await runner.step({ id: '6', title: 'completed evidence comes back', acceptance: ['A03', 'A06'] }, async () => {
    const done = await a2a(origin, ['wait', origin, state.clinicalTask ?? '', '--timeout', WAIT_SECONDS]);
    const result = done.data?.find((part) => part.mediaType === DISCLOSURE_MEDIA_TYPE);

    check(done.state === 'completed', `expected completed, got ${done.state}`);
    check(done.html !== undefined, 'no HTML card');
    check(result && disclosureResultSchema.safeParse(result.data).success, 'no schema-valid DisclosureResult');
    check(JSON.stringify(result.data).includes('"resourceType":"Bundle"'), 'no FHIR Bundle');
    check(!JSON.stringify(done).includes(CANARY), 'the restricted canary leaked');

    const ids = releasedRecordIds(done);

    return `schema-valid DisclosureResult + FHIR Bundle + HTML card; no canary; ${ids.length} record id(s): ${ids.join(', ')}`;
  });

  await handBack({ origin, runner, redactor, owner, cardioPass });

  await runner.step({ id: '8', title: 'owner revokes; next poll has no artifacts', acceptance: ['A07', 'A08'] }, async () => {
    const action = `/owner/grants/${state.grantId ?? ''}/revoke`;
    const form = formIn((await owner.open('/owner')).body, action);
    const revoked = await owner.request('POST', action, form.hidden);

    check(revoked.status === HTTP_SEE_OTHER, `revoke answered HTTP ${revoked.status}`);

    const after = await a2a(origin, ['get', origin, state.clinicalTask ?? '']);

    check(after.state === 'completed', `expected completed, got ${after.state}`);
    check(after.html === undefined && releasedRecordIds(after).length === 0, 'artifacts are still served');
    check(after.text.includes('Access ended'), 'expected "Access ended"');

    return 'grant revoked; GetTask now COMPLETED with no artifacts ("Access ended")';
  });

  return runner;
}

if (import.meta.main) {
  try {
    const { envFile, rest } = parseCommonArgs(process.argv.slice(2));

    loadEnvFile(process.env, envFile.path, envFile.explicit);

    const origin = parseOrigin(rest[0]);

    console.log(`Medissy journey against ${origin} (SYNTHETIC data only)`);

    const started = performance.now();
    const runner = await runJourney(origin, process.env, (line) => console.log(line));
    const passed = runner.results.filter((result) => result.status === 'PASS').length;

    console.log(`${runner.failed ? 'FAIL' : 'PASS'}: ${passed}/${runner.results.length} steps in ${((performance.now() - started) / 1000).toFixed(1)} s`);
    process.exitCode = runner.failed ? 1 : 0;
  } catch (error) {
    console.error(`journey failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  }
}

/* eslint-enable no-console, max-lines, max-lines-per-function */
