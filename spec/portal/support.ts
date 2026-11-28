import { vi } from 'vitest';

import { DEMO_CARDIOLOGIST } from '../../src/demo-idp/users';
import { createPortalSetup } from '../../src/portal';
import {
  Browser,
  createHarness,
  PUBLIC_URL,
  testClock,
  vaultWithPatient,
} from '../identity/support';

import type { DatabaseSync } from 'node:sqlite';

import type { LightMyRequestResponse } from 'fastify';

import type { SelectorClient } from '../../src/disclosure/selector';
import type { PortalSession } from '../../src/identity';
import type { SharingLogEntry } from '../../src/sharing';
import type { Harness, TestClock } from '../identity/support';

/** the issuer clinicians sign in at: the synthetic Northgate Health institution */
export const ISSUER = `${PUBLIC_URL}/institution-idp`;
export const XSS_NAME = '<script>alert("name")</script>';
export const XSS_REASON = '<img src=x onerror=alert(1)>';

/** the app, the vault, the clock and a spy on the sharing log */
export interface PortalHarness extends Harness {
  log: ReturnType<typeof vi.fn<(entry: SharingLogEntry) => void>>;
  sync: ReturnType<typeof vi.fn> | undefined;
}

/**
 * builds the demo identity plus the portal
 * @param options a selector client for disclosure and an optional sync port
 * @param options.selectorClient the relevance model (unused by re-checks)
 * @param options.withSync whether an owner-triggered sync is wired
 * @returns the app with the demo identity and the portal mounted
 */
export async function portalHarness(
  options: { selectorClient?: SelectorClient; withSync?: boolean } = {},
): Promise<PortalHarness> {
  const clock: TestClock = testClock();
  const log = vi.fn<(entry: SharingLogEntry) => void>();
  const sync = options.withSync
    ? vi.fn(async () => ({ status: 'succeeded', imported: 3 }))
    : undefined;
  const db = vaultWithPatient();
  const harness = await createHarness({
    clock,
    db,
    setup: (demo) => [
      createPortalSetup({
        identity: demo.identity,
        db,
        publicOrigin: PUBLIC_URL,
        now: clock.now,
        logger: { info: log },
        selectorClient: options.selectorClient,
        ...(sync ? { sync } : {}),
      }),
    ],
  });

  return { ...harness, log, sync };
}

/**
 * unescapes the entities the pages use
 * @param value escaped attribute text
 * @returns the plain text
 */
function unescape(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&#61;', '=')
    .replaceAll('&#96;', '`')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

/**
 * lists the hidden inputs of the form posting to `action`
 * @param page the response that contains the form
 * @param action the form's action path
 * @returns the hidden field values by name
 */
export function formFields(
  page: LightMyRequestResponse,
  action: string,
): Record<string, string> {
  const forms = page.body.split('<form').slice(1);
  const form = forms.find((chunk) =>
    unescape(/action="([^"]*)"/.exec(chunk)?.[1] ?? '').endsWith(action),
  );

  if (!form) {
    throw new Error(`no form posting to ${action}`);
  }

  const fields: Record<string, string> = {};

  for (const match of form
    .split('</form>')[0]!
    .matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)) {
    fields[match[1] ?? ''] = unescape(match[2] ?? '');
  }

  return fields;
}

/**
 * returns the first link in a page whose path starts with a prefix
 * @param page the response whose links are searched
 * @param prefix the path prefix
 * @returns the path
 */
export function linkTo(page: LightMyRequestResponse, prefix: string): string {
  const match = [...page.body.matchAll(/href="([^"]+)"/g)]
    .map((item) => unescape(item[1] ?? ''))
    .find((href) => href.startsWith(prefix));

  if (!match) {
    throw new Error(`no link to ${prefix}`);
  }

  return match;
}

/**
 * signs a browser in
 * @param harness the app
 * @param kind owner or clinician
 * @param account the demo account key
 * @returns the signed-in browser
 */
export async function signedIn(
  harness: Harness,
  kind: 'owner' | 'clinician',
  account: string,
): Promise<Browser> {
  const browser = new Browser(harness.app);

  await browser.signIn(kind, account);

  return browser;
}

/** the owner session cookie (Secure, so `__Host-` prefixed) */
export const OWNER_COOKIE = '__Host-medissy-owner';

/**
 * returns the owner browser's current session
 * @param harness the app
 * @param owner the owner's browser
 * @returns the session, or null
 */
export function ownerSession(
  harness: Harness,
  owner: Browser,
): PortalSession | null {
  return harness.demo.identity.sessions.find(
    'owner',
    owner.cookies.get(OWNER_COOKIE) ?? '',
  );
}

/**
 * moves the owner session's verified `auth_time` into the past; the demo
 * issuer stamps `auth_time` from the real clock, so tests age it here rather
 * than through the test clock
 * @param harness the app
 * @param owner the owner's browser
 * @param seconds how far back
 */
export function ageAuthTime(
  harness: Harness,
  owner: Browser,
  seconds: number,
): void {
  const session = ownerSession(harness, owner);

  if (!session?.authTime) {
    throw new Error('expected an owner session with auth_time');
  }

  session.authTime = new Date(harness.clock.now().getTime() - seconds * 1000);
}

/**
 * mints an invitation as the owner and returns its token
 * @param owner the owner's browser
 * @returns the token from the QR URL's fragment
 */
export async function mintToken(owner: Browser): Promise<string> {
  const dashboard = await owner.request('GET', '/owner');
  const page = await owner.request(
    'POST',
    '/owner/invitations',
    formFields(dashboard, '/owner/invitations'),
  );
  const url = /(http:\/\/medissy\.test\/connect#[A-Za-z0-9_-]{43})/.exec(
    page.body,
  )?.[1];

  if (!url) {
    throw new Error('no invitation URL on the page');
  }

  return new URL(url).hash.slice(1);
}

/**
 * redeems a token in the clinician portal with hostile stated labels
 * @param clinician the clinician's browser
 * @param token the invitation token
 * @returns the response
 */
export async function redeem(
  clinician: Browser,
  token: string,
): Promise<LightMyRequestResponse> {
  const page = await clinician.request('GET', '/connect');

  return clinician.request('POST', '/connect', {
    ...formFields(page, '/connect'),
    token,
    statedName: XSS_NAME,
    statedOrganization: 'Northgate',
    statedRole: 'cardiologist',
  });
}

/**
 * returns the id of the cardiologist's pending connection
 * @param db the vault
 * @returns the id of the single pending connection
 */
export function pendingConnectionId(db: DatabaseSync): string {
  const row = db
    .prepare(
      `SELECT id FROM connections WHERE requester_subject = ? AND status = 'pending'`,
    )
    .get(DEMO_CARDIOLOGIST.subject);

  return String(row?.id);
}

/**
 * counts grant rows
 * @param db the vault
 * @returns how many grants the vault holds
 */
export function grantCount(db: DatabaseSync): number {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM grants').get()?.n);
}

export { Browser };
