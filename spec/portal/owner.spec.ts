import { afterEach, describe, expect, it } from 'vitest';

import { createTaskStore } from '../../src/a2a/task-store';
import { newTaskId } from '../../src/contracts';
import { DEMO_CARDIOLOGIST } from '../../src/demo-idp/users';
import { PATIENT_ID, pathOf } from '../identity/support';

import {
  ISSUER,
  XSS_NAME,
  formFields,
  grantCount,
  linkTo,
  mintToken,
  pendingConnectionId,
  portalHarness,
  redeem,
  ageAuthTime,
  signedIn,
} from './support';

import type { Browser, PortalHarness } from './support';

/** ids the state-changing routes act on */
interface Ids {
  connection: string;
  grant: string;
}

/** the choices a confirm form posts for a connection */
const CHOICE = {
  encounter: 'new',
  newEncounterReason: 'Cardiology review (SYNTHETIC)',
  newEncounterDays: '7',
  categories: 'cardiac',
  baseline: 'on',
  maxSensitivity: 'routine',
  validityHours: '24',
};

let harness: PortalHarness | undefined;

afterEach(async () => {
  await harness?.app.close();
  harness = undefined;
});

/**
 * sets up an owner, a cardiologist and a pending connection between them
 * @returns the harness, both browsers and the confirm page path
 */
async function pendingFlow(): Promise<{
  h: PortalHarness;
  owner: Browser;
  clinician: Browser;
  confirmPath: string;
}> {
  const h = await portalHarness();

  harness = h;

  const owner = await signedIn(h, 'owner', 'owner');
  const clinician = await signedIn(h, 'clinician', 'cardiologist');

  await redeem(clinician, await mintToken(owner));

  return {
    h,
    owner,
    clinician,
    confirmPath: `/owner/confirm/${pendingConnectionId(h.db)}`,
  };
}

/**
 * posts the confirm form of a confirm page
 * @param owner the owner's browser
 * @param path the confirm page path
 * @param extra fields to replace
 * @returns the response
 */
async function postConfirm(
  owner: Browser,
  path: string,
  extra: Record<string, string> = {},
): ReturnType<Browser['request']> {
  const page = await owner.request('GET', path);

  return owner.request('POST', path, {
    ...formFields(page, path),
    ...CHOICE,
    ...extra,
  });
}

/**
 * returns every row a portal POST could change, to prove a refused POST changed none
 * @param h the harness
 * @returns a comparable snapshot
 */
function snapshot(h: PortalHarness): string {
  return JSON.stringify(
    [
      'SELECT id, status FROM invitations ORDER BY id',
      'SELECT id, status FROM connections ORDER BY id',
      'SELECT id, version, revoked_at FROM grants ORDER BY id, version',
      'SELECT id, status FROM scope_requests ORDER BY id',
      'SELECT id FROM encounters ORDER BY id',
      'SELECT COUNT(*) AS n FROM sync_runs',
    ].map((sql) => h.db.prepare(sql).all()),
  );
}

describe('owner portal and step-up confirm page (D3)', () => {
  it('should show the health address and a scannable share QR to the owner', async () => {
    harness = await portalHarness();

    const owner = await signedIn(harness, 'owner', 'owner');
    const landing = await owner.request('GET', '/portal');
    const dashboard = await owner.request('GET', '/owner');
    const shared = await owner.request(
      'POST',
      '/owner/invitations',
      formFields(dashboard, '/owner/invitations'),
    );

    expect(pathOf(String(landing.headers.location))).toBe('/owner');
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.body).toContain('http://medissy.test');
    expect(shared.statusCode).toBe(200);
    expect(shared.headers['cache-control']).toBe('no-store');
    expect(shared.body).toMatch(
      /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/,
    );
    expect(shared.body).toMatch(
      /http:\/\/medissy\.test\/connect#[A-Za-z0-9_-]{43}/,
    );
  });

  it('should create a grant only when the confirm page is posted', async () => {
    const { h, owner, clinician, confirmPath } = await pendingFlow();
    const dashboard = await owner.request('GET', '/owner');
    const page = await owner.request(
      'GET',
      linkTo(dashboard, '/owner/confirm/'),
    );
    const before = grantCount(h.db);
    const posted = await postConfirm(owner, confirmPath);

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(DEMO_CARDIOLOGIST.subject);
    expect(page.body).toContain(ISSUER);
    expect(before).toBe(0);
    expect(clinician.cookies.size).toBeGreaterThan(0);
    expect(posted.statusCode).toBe(303);
    expect(grantCount(h.db)).toBe(1);
    expect(
      h.db
        .prepare(
          'SELECT grantee_subject, categories, allow_baseline FROM grants',
        )
        .get(),
    ).toEqual({
      grantee_subject: DEMO_CARDIOLOGIST.subject,
      categories: '["cardiac"]',
      allow_baseline: 1,
    });
  });

  it.each([
    { who: 'owner', path: () => '/owner/invitations' },
    { who: 'owner', path: (ids: Ids) => `/owner/grants/${ids.grant}/revoke` },
    { who: 'owner', path: () => '/owner/sync' },
    { who: 'owner', path: (ids: Ids) => `/owner/confirm/${ids.connection}` },
    {
      who: 'owner',
      path: (ids: Ids) => `/owner/confirm/${ids.connection}/decline`,
    },
    { who: 'clinician', path: () => '/clinician/scope-requests' },
    { who: 'clinician', path: () => '/connect' },
  ] as const)(
    'should refuse a $who POST with a forged or missing CSRF token and change nothing (#%#)',
    async ({ who, path }) => {
      const { h, owner, clinician, confirmPath } = await pendingFlow();

      // a live grant to revoke, a decided connection and an open invitation
      await postConfirm(owner, confirmPath);

      const token = await mintToken(owner);
      const ids: Ids = {
        connection: confirmPath.split('/').at(-1) ?? '',
        grant: String(h.db.prepare('SELECT id FROM grants').get()?.id),
      };
      const browser = who === 'owner' ? owner : clinician;
      const fields = {
        ...CHOICE,
        token,
        encounterId: 'enc-x',
        reason: 'forged',
        desiredDays: '7',
        requestId: 'forged-1',
      };
      const before = snapshot(h);
      const forged = await browser.request('POST', path(ids), {
        ...fields,
        _csrf: 'forged',
      });
      const missing = await browser.request('POST', path(ids), fields);

      expect([forged.statusCode, missing.statusCode]).toEqual([403, 403]);
      expect(snapshot(h)).toBe(before);
    },
  );

  it('should refuse the confirm POST without a valid CSRF token', async () => {
    const { h, owner, confirmPath } = await pendingFlow();

    const posted = await owner.request('POST', confirmPath, {
      ...CHOICE,
      _csrf: 'forged',
    });

    expect(posted.statusCode).toBe(403);
    expect(grantCount(h.db)).toBe(0);
  });

  it('should refuse an auth_time older than five minutes, then accept the POST after a fresh owner sign-in', async () => {
    const { h, owner, confirmPath } = await pendingFlow();

    ageAuthTime(h, owner, 301);

    const stale = await postConfirm(owner, confirmPath);

    expect(stale.statusCode).toBe(401);
    expect(stale.body).toContain('/auth/owner/sign-in');
    expect(grantCount(h.db)).toBe(0);

    await owner.signIn('owner', 'owner');

    const back = await owner.request('GET', '/portal');
    const fresh = await postConfirm(
      owner,
      pathOf(String(back.headers.location)),
    );

    expect(pathOf(String(back.headers.location))).toBe(confirmPath);
    expect(fresh.statusCode).toBe(303);
    expect(grantCount(h.db)).toBe(1);
  });

  it.each([
    {
      label: '31 s ahead of the server clock',
      seconds: -31,
      status: 401,
      grants: 0,
    },
    {
      label: '29 s ahead (within the clock skew)',
      seconds: -29,
      status: 303,
      grants: 1,
    },
    {
      label: 'just under five minutes old',
      seconds: 290,
      status: 303,
      grants: 1,
    },
  ])(
    'should treat an auth_time $label as fresh only within 0-5 min plus 30 s skew',
    async ({ seconds, status, grants }) => {
      const { h, owner, confirmPath } = await pendingFlow();

      ageAuthTime(h, owner, seconds);

      const posted = await postConfirm(owner, confirmPath);

      expect(posted.statusCode).toBe(status);
      expect(grantCount(h.db)).toBe(grants);
    },
  );

  it('should keep clinician sessions out of owner routes and owner sessions out of clinician routes', async () => {
    const { owner, clinician, confirmPath } = await pendingFlow();

    const responses = await Promise.all([
      clinician.request('GET', '/owner'),
      clinician.request('GET', confirmPath),
      clinician.request('POST', confirmPath, CHOICE),
      owner.request('GET', '/clinician'),
    ]);

    expect(responses.map((res) => res.statusCode)).toEqual([
      401, 401, 401, 401,
    ]);
  });

  it('should decline a pending connection without creating a grant', async () => {
    const { h, owner, confirmPath } = await pendingFlow();
    const page = await owner.request('GET', confirmPath);
    const declined = await owner.request(
      'POST',
      `${confirmPath}/decline`,
      formFields(page, `${confirmPath}/decline`),
    );

    expect(declined.statusCode).toBe(303);
    expect(grantCount(h.db)).toBe(0);
    expect(h.db.prepare('SELECT status FROM connections').get()).toEqual({
      status: 'declined',
    });
  });

  it('should log requests that never signed in as content-free day counts, including expired ones not purged yet', async () => {
    harness = await portalHarness();

    const store = createTaskStore(harness.db);
    const now = harness.clock.now();
    const unbound = (
      messageId: string,
      span: { createdAt: string; expiresAt: string },
      skill?: 'submit-record',
    ): void => {
      store.create({
        id: newTaskId(),
        contextId: 'ctx-unsigned',
        patientId: PATIENT_ID,
        originMessageId: messageId,
        status: {
          state: 'TASK_STATE_AUTH_REQUIRED',
          parts: [],
          timestamp: span.createdAt,
        },
        metadata: {
          requestId: `${messageId}-req`,
          ...(skill ? { skill } : {}),
        },
        ...span,
      });
    };
    const lapsed = {
      createdAt: '2026-01-10T08:00:00.000Z',
      expiresAt: '2026-01-10T09:00:00.000Z',
    };

    unbound('msg-purged', lapsed);
    store.purgeAbandoned(now);
    unbound('msg-expired', lapsed);
    unbound('msg-handback', lapsed, 'submit-record');
    unbound('msg-waiting', {
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    });

    const owner = await signedIn(harness, 'owner', 'owner');
    const dashboard = await owner.request('GET', '/owner');

    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.body).toContain('Requests that never signed in');
    expect(dashboard.body).toContain('Waiting for a sign-in now: 1.');
    expect(dashboard.body).toContain(
      '<tr><td>2026-01-10</td><td>Request for records</td><td>2</td></tr><tr><td>2026-01-10</td><td>Record hand-back</td><td>1</td></tr>',
    );
    expect(dashboard.body).not.toMatch(/msg-(purged|expired|handback|waiting)/);
    expect(dashboard.body).not.toContain('ctx-unsigned');
  });

  it('should revoke a grant from the dashboard', async () => {
    const { h, owner, confirmPath } = await pendingFlow();

    await postConfirm(owner, confirmPath);

    const grantId = String(h.db.prepare('SELECT id FROM grants').get()?.id);
    const dashboard = await owner.request('GET', '/owner');
    const action = `/owner/grants/${grantId}/revoke`;
    const revoked = await owner.request(
      'POST',
      action,
      formFields(dashboard, action),
    );

    expect(revoked.statusCode).toBe(303);
    expect(
      h.db
        .prepare('SELECT revoked_at IS NOT NULL AS revoked FROM current_grants')
        .get(),
    ).toEqual({ revoked: 1 });
  });

  it('should render stated names inert and label every page SYNTHETIC DEMO', async () => {
    const { owner, clinician, confirmPath } = await pendingFlow();

    const pages = await Promise.all([
      owner.request('GET', '/owner'),
      owner.request('GET', confirmPath),
      clinician.request('GET', '/clinician'),
      clinician.request('GET', '/connect'),
      clinician.request('GET', '/'),
      owner.request('GET', '/clinician'),
    ]);

    for (const page of pages) {
      expect(page.body).toContain('SYNTHETIC DEMO');
      expect(page.body).not.toContain(XSS_NAME);
      expect(page.headers['content-security-policy']).toMatch(
        /default-src 'none'/,
      );
    }

    expect(pages[1].body).toContain('&lt;script&gt;');
  });

  it('should show NOT CONFIGURED for a Box sync when no ingestion is wired, and run the wired one otherwise', async () => {
    harness = await portalHarness();

    const owner = await signedIn(harness, 'owner', 'owner');
    const dashboard = await owner.request('GET', '/owner');
    const unwired = await owner.request(
      'POST',
      '/owner/sync',
      formFields(dashboard, '/owner/sync'),
    );

    await harness.app.close();
    harness = await portalHarness({ withSync: true });

    const wiredOwner = await signedIn(harness, 'owner', 'owner');
    const wiredDashboard = await wiredOwner.request('GET', '/owner');
    const wired = await wiredOwner.request(
      'POST',
      '/owner/sync',
      formFields(wiredDashboard, '/owner/sync'),
    );

    expect(unwired.body).toContain('NOT CONFIGURED');
    expect(wired.statusCode).toBe(200);
    expect(harness.sync).toHaveBeenCalledTimes(1);
  });

  it('should never log or store the invitation token', async () => {
    harness = await portalHarness();

    const owner = await signedIn(harness, 'owner', 'owner');
    const clinician = await signedIn(harness, 'clinician', 'cardiologist');
    const token = await mintToken(owner);

    await redeem(clinician, token);

    const stored = JSON.stringify([
      harness.db.prepare('SELECT * FROM invitations').all(),
      harness.db.prepare('SELECT * FROM connections').all(),
      harness.db.prepare('SELECT * FROM audit_events').all(),
    ]);

    expect(harness.log.mock.calls).toEqual([
      [{ event: 'invitation.created', outcome: 'success' }],
      [{ event: 'invitation.redeemed', outcome: 'success' }],
    ]);
    expect(stored).not.toContain(token);
  });
});
