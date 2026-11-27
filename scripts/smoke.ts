/* eslint-disable no-console, max-lines-per-function -- an operator CLI */
/**
 * deployment smoke checks against any Medissy origin: Agent Card, health,
 * Host guard, proxy-trust sanity and wake timing (A13 measurement hooks);
 * A01 (Box listing through the Sprites connector) runs only with `--box`
 * and Box settings present, and only means anything inside the Sprite
 *
 * usage: pnpm smoke <origin> [--idle <seconds>] [--box] [--env-file <path>]
 * exit code: 0 when no check FAILs (NOT RUN, INFO and MEASURED do not fail)
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { connectorConfigFromEnv, createConnectorAdapter } from '../src/box/connector';

import { loadEnvFile, parseCommonArgs, parseOrigin } from './lib/env';
import { a2a, check, Redactor, StepRunner } from './lib/support';

import type { Env } from './lib/env';

const HTTP_OK = 200;
const HTTP_MISDIRECTED = 421;
const WARM_SAMPLES = 3;
const MS_PER_SECOND = 1000;
const FOREIGN_HOST = 'smoke-foreign-host.invalid';
const PLACEHOLDER = 'replace-me';
/** strings that must never appear on the public Agent Card */
export const CARD_FORBIDDEN = ['Morgan', 'Testwell', '7b1f4c2e-5d3a-4e8b-9a61-2c0d8f4e1a35', 'MEDISSY-CANARY'];

/**
 * sends one raw GET with chosen headers (fetch cannot override Host)
 * @param origin the origin to connect to
 * @param path the path
 * @param headers extra headers, e.g. a foreign Host
 * @returns the status and Location
 */
export async function rawGet(
  origin: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; location?: string }> {
  const url = new URL(path, origin);
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const req = send(
      { host: url.hostname, port: url.port || undefined, path: url.pathname, method: 'GET', servername: url.hostname, headers },
      (res) => {
        res.resume();
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, ...(res.headers.location ? { location: res.headers.location } : {}) }),
        );
      },
    );

    req.on('error', reject);
    req.end();
  });
}

/**
 * explains how the origin treats a spoofed `X-Forwarded-Host`
 * @param status the status of a request carrying one
 * @param https whether the origin is https (behind the Sprite proxy)
 * @returns a one-line interpretation
 */
export function forwardedHostVerdict(status: number, https: boolean): string {
  if (status === HTTP_MISDIRECTED) {
    return 'forwarded Host is trusted (TRUST_PROXY=1) and the Host guard refused the spoofed value (421)';
  }

  return https
    ? `HTTP ${status}: the proxy replaced the spoofed X-Forwarded-Host, or proxy trust is off; check TRUST_PROXY=1 in the service env`
    : `HTTP ${status}: proxy trust is off, as expected for a local http origin (TRUST_PROXY=0)`;
}

/**
 * computes the median of some numbers
 * @param values the samples
 * @returns the median, or NaN for none
 */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2 ? (sorted[mid] ?? Number.NaN) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * checks whether the Box connector settings are present (not placeholders)
 * @param env the environment
 * @returns true when both gateway settings are set
 */
export function boxConfigured(env: Env): boolean {
  return [env.BOX_GATEWAY_CONNECTION_ID, env.BOX_ALLOWED_FOLDER_ID].every((value) => Boolean(value) && value !== PLACEHOLDER);
}

/**
 * lists the names of environment variables that look like Box credentials (A01: none may exist)
 * @param env the environment
 * @returns suspicious names, never values
 */
export function boxSecretNames(env: Env): string[] {
  return Object.keys(env).filter((name) => /BOX/i.test(name) && /SECRET|TOKEN|CLIENT|PASSWORD|PRIVATE/i.test(name));
}

/**
 * times one GET of `/healthz`
 * @param origin the origin
 * @returns elapsed milliseconds
 */
async function timeHealth(origin: string): Promise<number> {
  const started = performance.now();
  const res = await fetch(new URL('/healthz', origin));

  await res.text();
  check(res.status === HTTP_OK, `/healthz answered HTTP ${res.status}`);

  return performance.now() - started;
}

/**
 * runs the smoke checks
 * @param origin the origin
 * @param options idle wait, Box check and environment
 * @param options.idleSeconds seconds to stay idle before a second wake measurement
 * @param options.box whether to list the Box folder through the connector
 * @param options.env the environment
 * @param print receives each line
 * @returns the runner
 */
export async function runSmoke(
  origin: string,
  options: { idleSeconds?: number; box: boolean; env: Env },
  print: (line: string) => void,
): Promise<StepRunner> {
  const runner = new StepRunner(new Redactor(), print);
  const https = origin.startsWith('https:');
  const independent = { independent: true };
  const firstMs = await timeHealth(origin).catch(() => undefined);

  await runner.step({ id: 'S1', title: 'Agent Card valid, no patient data', acceptance: ['A03'] }, async () => {
    const card = await a2a(origin, ['card', origin]);
    const raw = await (await fetch(new URL('/.well-known/agent-card.json', origin))).text();

    check(card.state === 'card', `the A2A client refused the card (${card.state})`);
    check(card.agent?.endpoint.startsWith(origin), 'the card endpoint is not on this origin');
    check(!CARD_FORBIDDEN.some((item) => raw.includes(item)), 'the public card carries patient data');

    return `skills: ${(card.agent?.skills ?? []).map((skill) => skill.id).join(', ')}`;
  }, independent);

  await runner.step({ id: 'S2', title: 'health', acceptance: ['A13'] }, async () => {
    const res = await fetch(new URL('/healthz', origin));
    const body = (await res.json()) as { status?: string; synthetic?: boolean };

    check(res.status === HTTP_OK && body.status === 'ok' && body.synthetic === true, 'unexpected /healthz answer');

    return '{status: ok, synthetic: true}';
  }, independent);

  await runner.step({ id: 'S3', title: 'Host guard', acceptance: ['A14'] }, async () => {
    const foreign = await rawGet(origin, '/.well-known/agent-card.json', { host: FOREIGN_HOST });
    const health = await rawGet(origin, '/healthz', { host: FOREIGN_HOST });

    if (https && foreign.status !== HTTP_MISDIRECTED) {
      return `NOT CHECKABLE through the proxy: a foreign Host got HTTP ${foreign.status} (the Sprite proxy routes by Host)`;
    }

    check(foreign.status === HTTP_MISDIRECTED, `a foreign Host got HTTP ${foreign.status}, expected 421`);
    check(health.status === HTTP_OK, `/healthz for a foreign Host got HTTP ${health.status}, expected 200`);

    return 'foreign Host 421; /healthz exempt (200)';
  }, independent);

  await runner.step({ id: 'S4', title: 'TRUST_PROXY sanity', acceptance: ['A14'] }, async () => {
    const signIn = await rawGet(origin, '/auth/owner/sign-in', { host: new URL(origin).host });
    const spoofed = await rawGet(origin, '/.well-known/agent-card.json', {
      'host': new URL(origin).host,
      'x-forwarded-host': FOREIGN_HOST,
    });

    check(
      signIn.location?.startsWith(`${origin}/demo-idp/auth`),
      'the owner sign-in redirect is not built for this public origin (MEDISSY_PUBLIC_URL mismatch?)',
    );

    return `redirects use ${origin}; ${forwardedHostVerdict(spoofed.status, https)}${
      https ? '; an https origin that boots at all has TRUST_PROXY=1 (boot refuses otherwise)' : ''
    }`;
  }, independent);

  const warm: number[] = [];

  for (let index = 0; index < WARM_SAMPLES; index += 1) {
    warm.push(await timeHealth(origin).catch(() => Number.NaN));
  }

  runner.record({
    id: 'S5',
    title: 'wake timing (measurement only, no SLA)',
    acceptance: ['A13'],
    status: 'MEASURED',
    detail: `first /healthz ${firstMs?.toFixed(0) ?? 'failed'} ms; warm median ${median(warm).toFixed(0)} ms over ${WARM_SAMPLES}`,
  });

  if (options.idleSeconds) {
    print(`idle for ${options.idleSeconds} s before measuring a wake ...`);
    await new Promise((resolve) => setTimeout(resolve, options.idleSeconds! * MS_PER_SECOND));

    const afterIdle = await timeHealth(origin).catch(() => undefined);

    runner.record({
      id: 'S6',
      title: `wake after ${options.idleSeconds} s idle`,
      acceptance: ['A13'],
      status: 'MEASURED',
      detail: `first /healthz after idle ${afterIdle?.toFixed(0) ?? 'failed'} ms`,
    });
  }

  if (!options.box || !boxConfigured(options.env)) {
    runner.record({
      id: 'S7',
      title: 'Box listing via the Sprites connector',
      acceptance: ['A01'],
      status: 'NOT RUN',
      detail: options.box ? 'BOX_GATEWAY_CONNECTION_ID / BOX_ALLOWED_FOLDER_ID not set' : 'pass --box inside the Sprite',
    });
  } else {
    await runner.step({ id: 'S7', title: 'Box listing via the Sprites connector', acceptance: ['A01'] }, async () => {
      const secrets = boxSecretNames(options.env);

      check(secrets.length === 0, `Box credential-like variables present: ${secrets.join(', ')}`);

      const listing = await createConnectorAdapter({ ...connectorConfigFromEnv(options.env), fetch }).list();

      return `${listing.entries.length} file(s) listed${listing.truncated ? ' (truncated)' : ''}; no Box credential in the environment`;
    }, independent);
  }

  return runner;
}

if (import.meta.main) {
  try {
    const { envFile, rest } = parseCommonArgs(process.argv.slice(2));

    loadEnvFile(process.env, envFile.path, envFile.explicit);

    const origin = parseOrigin(rest.find((arg) => !arg.startsWith('--')));
    const idleIndex = rest.indexOf('--idle');
    const idleSeconds = idleIndex >= 0 ? Number(rest[idleIndex + 1]) : undefined;

    console.log(`Medissy smoke against ${origin}`);

    const runner = await runSmoke(origin, { idleSeconds, box: rest.includes('--box'), env: process.env }, (line) =>
      console.log(line),
    );

    process.exitCode = runner.failed ? 1 : 0;
  } catch (error) {
    console.error(`smoke failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  }
}

/* eslint-enable no-console, max-lines-per-function */
