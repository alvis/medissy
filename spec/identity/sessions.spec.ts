import { afterEach, describe, expect, it } from 'vitest';

import { DEMO_OWNER } from '../../src/demo-idp/users';

import { Browser, createHarness, pathOf, TEST_PASSPHRASES } from './support';

import type { LightMyRequestResponse } from 'fastify';

import type { Harness } from './support';

const OWNER_COOKIE = '__Host-medissy-owner';
const CLINICIAN_COOKIE = '__Host-medissy-clinician';

/**
 * builds a harness with guarded test routes standing in for portal pages
 * @returns the app with the guarded routes mounted
 */
async function portalHarness(): Promise<Harness> {
  return createHarness({
    setup: ({ identity }) => [
      async (app) => {
        for (const [kind, guard] of [
          ['owner', identity.requireOwner],
          ['clinician', identity.requireClinician],
        ] as const) {
          app.get(
            `/test/${kind}`,
            { preHandler: guard },
            async (request, reply) => ({
              subject: request.portalSession?.principal.subject,
              roles: request.portalSession?.principal.roles,
              registered: request.portalSession?.clinician !== null,
              csrf: request.portalSession
                ? identity.csrfToken(reply, request.portalSession)
                : null,
            }),
          );
          app.post(`/test/${kind}`, { preHandler: guard }, async () => ({
            changed: true,
          }));
        }
      },
    ],
  });
}

/**
 * returns the CSRF token a guarded GET hands out
 * @param browser the cookie jar that holds the sessions
 * @param kind which session
 * @returns the token
 */
async function csrfFor(
  browser: Browser,
  kind: 'owner' | 'clinician',
): Promise<string> {
  const res = await browser.request('GET', `/test/${kind}`);

  return res.json<{ csrf: string }>().csrf;
}

/**
 * finds a Set-Cookie header by cookie name
 * @param res the response
 * @param name which cookie to find in the response
 * @returns the raw header
 */
function setCookie(res: LightMyRequestResponse, name: string): string {
  const header = [res.headers['set-cookie'] ?? []]
    .flat()
    .find((value) => String(value).startsWith(`${name}=`));

  return String(header ?? '');
}

describe('owner and clinician sessions (A14)', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.app.close();
    harness = undefined;
  });

  it('signs the owner in with a short-lived HttpOnly, Secure, SameSite=Lax host cookie', async () => {
    harness = await portalHarness();
    const browser = new Browser(harness.app);
    const callback = await browser.signIn('owner', 'owner');

    expect(callback.statusCode).toBe(303);
    expect(pathOf(String(callback.headers.location))).toBe('/portal');

    const cookie = setCookie(callback, OWNER_COOKIE);

    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(Number(/Max-Age=(\d+)/i.exec(cookie)?.[1])).toBeLessThanOrEqual(900);

    const page = await browser.request('GET', '/test/owner');

    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({ subject: DEMO_OWNER.subject });
  });

  it('refuses a clinician account at the owner sign-in: the patient issuer does not hold it', async () => {
    harness = await portalHarness();
    const callback = await new Browser(harness.app).signIn(
      'owner',
      'cardiologist',
    );

    expect(callback.statusCode).toBe(401);
    expect(callback.body).toContain('do not match');
    expect(setCookie(callback, OWNER_COOKIE)).toBe('');
  });

  it('signs a clinician in at the institution and the owner at the patient issuer, whatever the caller asks', async () => {
    harness = await portalHarness();
    const browser = new Browser(harness.app);
    const clinician = await browser.request(
      'GET',
      '/auth/clinician/sign-in?issuer=http://medissy.test/demo-idp',
    );
    const owner = await browser.request(
      'GET',
      '/auth/owner/sign-in?issuer=http://medissy.test/institution-idp',
    );

    expect(String(clinician.headers.location)).toMatch(
      /^http:\/\/medissy\.test\/institution-idp\/auth\?/,
    );
    expect(String(owner.headers.location)).toMatch(
      /^http:\/\/medissy\.test\/demo-idp\/auth\?/,
    );
  });

  it('signs in a verified but unregistered clinician without registry roles', async () => {
    harness = await portalHarness();
    const browser = new Browser(harness.app);
    const callback = await browser.signIn('clinician', 'unknown-clinician');

    expect(pathOf(String(callback.headers.location))).toBe('/clinician');

    const page = await browser.request('GET', '/test/clinician');

    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({ roles: [], registered: false });
  });

  it('rejects a state-changing request without a CSRF token', async () => {
    harness = await portalHarness();
    const browser = new Browser(harness.app);

    await browser.signIn('owner', 'owner');

    const res = await browser.request('POST', '/test/owner', {});

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'FST_CSRF_INVALID_TOKEN' });
  });

  it('accepts the session-bound CSRF token', async () => {
    harness = await portalHarness();
    const browser = new Browser(harness.app);

    await browser.signIn('owner', 'owner');
    const csrf = await csrfFor(browser, 'owner');
    const res = await browser.request('POST', '/test/owner', { _csrf: csrf });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ changed: true });
  });

  it('rejects a CSRF token minted for the other session', async () => {
    harness = await portalHarness();
    const browser = new Browser(harness.app);

    await browser.signIn('owner', 'owner');
    await browser.signIn('clinician', 'cardiologist');
    const clinicianCsrf = await csrfFor(browser, 'clinician');
    const res = await browser.request('POST', '/test/owner', {
      _csrf: clinicianCsrf,
    });

    expect(res.statusCode).toBe(403);
  });

  it('never accepts an owner session as a clinician session', async () => {
    harness = await portalHarness();
    const browser = new Browser(harness.app);

    await browser.signIn('owner', 'owner');
    const ownerId = browser.cookies.get(OWNER_COOKIE) ?? '';

    browser.cookies.delete(OWNER_COOKIE);
    browser.cookies.set(CLINICIAN_COOKIE, ownerId);

    expect((await browser.request('GET', '/test/clinician')).statusCode).toBe(
      401,
    );
  });

  it('never accepts a clinician session as an owner session', async () => {
    harness = await portalHarness();
    const browser = new Browser(harness.app);

    await browser.signIn('clinician', 'cardiologist');
    const clinicianId = browser.cookies.get(CLINICIAN_COOKIE) ?? '';

    browser.cookies.delete(CLINICIAN_COOKIE);
    browser.cookies.set(OWNER_COOKIE, clinicianId);

    const res = await browser.request('GET', '/test/owner');

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: 'sign_in_required',
      signIn: '/auth/owner/sign-in',
    });
  });

  it('never lets the owner session outlive its access token', async () => {
    harness = await portalHarness();
    const browser = new Browser(harness.app);

    // the session TTL is 900 s, but the demo access token lives 600 s
    await browser.signIn('owner', 'owner');
    harness.clock.advance(598);
    expect((await browser.request('GET', '/test/owner')).statusCode).toBe(200);

    harness.clock.advance(2);
    expect((await browser.request('GET', '/test/owner')).statusCode).toBe(401);
  });

  it('rejects a callback whose state this browser did not start, and a replay', async () => {
    harness = await portalHarness();
    const victim = new Browser(harness.app);
    const login = await victim.follow(
      await victim.request('GET', '/auth/owner/sign-in'),
    );
    const csrf = /name="_csrf" value="([^"]+)"/.exec(login.body)?.[1] ?? '';
    const chosen = await victim.request(
      'POST',
      /action="([^"]+)"/.exec(login.body)?.[1] ?? '',
      {
        _csrf: csrf,
        passphrase: TEST_PASSPHRASES.owner ?? '',
        account: 'owner',
      },
    );
    let res = chosen;

    while (
      res.headers.location &&
      !String(res.headers.location).includes('/auth/callback')
    ) {
      res = await victim.request('GET', String(res.headers.location));
    }

    const callbackUrl = String(res.headers.location);
    const attacker = new Browser(harness.app);

    expect((await attacker.request('GET', callbackUrl)).statusCode).toBe(400);

    const first = await victim.request('GET', callbackUrl);

    expect(first.statusCode).toBe(303);

    const replay = await victim.request('GET', callbackUrl);

    expect(replay.statusCode).toBe(400);
  });

  it('signs out only with a valid CSRF token and then forgets the session', async () => {
    harness = await portalHarness();
    const browser = new Browser(harness.app);

    await browser.signIn('owner', 'owner');
    const csrf = await csrfFor(browser, 'owner');

    expect(
      (await browser.request('POST', '/auth/owner/sign-out', {})).statusCode,
    ).toBe(403);

    const id = browser.cookies.get(OWNER_COOKIE) ?? '';
    const out = await browser.request('POST', '/auth/owner/sign-out', {
      _csrf: csrf,
    });

    expect(out.statusCode).toBe(303);
    expect(browser.cookies.has(OWNER_COOKIE)).toBe(false);

    browser.cookies.set(OWNER_COOKIE, id);
    expect((await browser.request('GET', '/test/owner')).statusCode).toBe(401);
  });

  it('drops the owner session once the vault owner no longer matches', async () => {
    harness = await portalHarness();
    const browser = new Browser(harness.app);

    await browser.signIn('owner', 'owner');
    harness.db.exec('PRAGMA foreign_keys = OFF');
    harness.db
      .prepare("UPDATE patient SET owner_subject = 'someone-else'")
      .run();

    expect((await browser.request('GET', '/test/owner')).statusCode).toBe(401);
  });
});
