import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEMO_CARDIOLOGIST } from '../../src/demo-idp/users';
import { disclose } from '../../src/disclosure';
import { CONNECT_SCRIPT } from '../../src/portal/clinician';
import { scriptHashOf } from '../../src/portal/layout';
import { escapeHtml } from '../../src/widgets/html';
import { answer, fakeModel, released } from '../disclosure/support';
import { PATIENT_ID } from '../identity/support';
import { fixtureRecords, insertRecord } from '../policy/support';

import {
  ISSUER,
  XSS_REASON,
  formFields,
  grantCount,
  mintToken,
  pendingConnectionId,
  portalHarness,
  redeem,
  signedIn,
} from './support';

import type { PipelineOutcome } from '../../src/disclosure';

import type { Browser, PortalHarness } from './support';

/** a model that selects every candidate it is shown */
const everything = fakeModel((request) =>
  answer(
    [
      ...(request.messages[0]?.content ?? '').matchAll(/"recordId":"([^"]+)"/g),
    ].map((match) => match[1] ?? ''),
  ),
);

let harness: PortalHarness | undefined;

afterEach(async () => {
  await harness?.app.close();
  harness = undefined;
});

/**
 * sets up a cardiologist the owner confirmed through the portal for cardiac records
 * in a new encounter, with the synthetic fixtures imported
 * @returns the harness, both browsers and the new encounter id
 */
async function confirmedFlow(): Promise<{
  h: PortalHarness;
  owner: Browser;
  clinician: Browser;
  encounterId: string;
}> {
  const h = await portalHarness({ selectorClient: everything.client });

  harness = h;

  const owner = await signedIn(h, 'owner', 'owner');
  const clinician = await signedIn(h, 'clinician', 'cardiologist');

  await redeem(clinician, await mintToken(owner));

  const path = `/owner/confirm/${pendingConnectionId(h.db)}`;
  const page = await owner.request('GET', path);

  await owner.request('POST', path, {
    ...formFields(page, path),
    encounter: 'new',
    newEncounterDays: '7',
    categories: 'cardiac',
    baseline: 'on',
    maxSensitivity: 'routine',
    validityHours: '24',
  });

  for (const record of fixtureRecords) {
    insertRecord(h.db, record);
  }

  const grant = h.db.prepare('SELECT encounter_id FROM grants').get();

  return { h, owner, clinician, encounterId: String(grant?.encounter_id) };
}

/**
 * asks for evidence as the cardiologist, as the A2A engine would
 * @param h the harness
 * @param encounterId the encounter the clinician asks evidence for
 * @returns the outcome
 */
async function discloseToCardiologist(
  h: PortalHarness,
  encounterId: string,
): Promise<PipelineOutcome> {
  return disclose(
    {
      db: h.db,
      clock: h.clock.now,
      selectorClient: everything.client,
      logger: { info: vi.fn(), error: vi.fn() },
    },
    {
      principal: {
        issuer: ISSUER,
        subject: DEMO_CARDIOLOGIST.subject,
        audience: ['http://medissy.test'],
        scopes: ['medissy:request'],
        roles: [],
      },
      patientId: PATIENT_ID,
      request: {
        requestId: 'req-portal-1',
        encounterId,
        purpose: 'direct-treatment',
        question: 'Summarise the rhythm history (SYNTHETIC).',
      },
    },
  );
}

describe('clinician portal', () => {
  it('should show released evidence, re-checked by policy, and nothing once the grant is revoked', async () => {
    const { h, owner, clinician, encounterId } = await confirmedFlow();
    const labels = released(
      await discloseToCardiologist(h, encounterId),
    ).result.evidence.map((item) => escapeHtml(item.label));
    const before = await clinician.request('GET', '/clinician');
    const grantId = String(h.db.prepare('SELECT id FROM grants').get()?.id);
    const dashboard = await owner.request('GET', '/owner');
    const action = `/owner/grants/${grantId}/revoke`;

    await owner.request('POST', action, formFields(dashboard, action));

    const after = await clinician.request('GET', '/clinician');

    expect(labels.length).toBeGreaterThan(0);
    expect(before.statusCode).toBe(200);
    expect(before.body).toContain('req-portal-1');
    expect(before.body).toContain('confirmed');

    for (const label of labels) {
      expect(before.body).toContain(label);
      expect(after.body).not.toContain(label);
    }

    expect(after.body).toContain('No longer available');
  });

  it('should end the connection with its last grant: a scope request is then refused (403), and a new invitation reconnects', async () => {
    const { h, owner, clinician, encounterId } = await confirmedFlow();
    const portal = await clinician.request('GET', '/clinician');
    const grantId = String(h.db.prepare('SELECT id FROM grants').get()?.id);
    const dashboard = await owner.request('GET', '/owner');
    const action = `/owner/grants/${grantId}/revoke`;

    await owner.request('POST', action, formFields(dashboard, action));

    const asked = await clinician.request('POST', '/clinician/scope-requests', {
      ...formFields(portal, '/clinician/scope-requests'),
      encounterId,
      categories: 'musculoskeletal',
      reason: XSS_REASON,
      desiredDays: '7',
    });
    const statuses = (): unknown[] =>
      h.db
        .prepare('SELECT status FROM connections ORDER BY created_at, id')
        .all();

    expect(asked.statusCode).toBe(403);
    expect(
      h.db.prepare('SELECT COUNT(*) AS n FROM scope_requests').get(),
    ).toEqual({ n: 0 });
    expect(statuses()).toEqual([{ status: 'ended' }]);

    h.clock.advance(1);
    await redeem(clinician, await mintToken(owner));

    expect(statuses()).toEqual([{ status: 'ended' }, { status: 'pending' }]);
  });

  it('should send a scope request the owner sees inert and approves only on the confirm page', async () => {
    const { h, owner, clinician, encounterId } = await confirmedFlow();
    const portal = await clinician.request('GET', '/clinician');
    const asked = await clinician.request('POST', '/clinician/scope-requests', {
      ...formFields(portal, '/clinician/scope-requests'),
      encounterId,
      categories: 'musculoskeletal',
      reason: XSS_REASON,
      desiredDays: '7',
    });
    const dashboard = await owner.request('GET', '/owner');
    const scopeId = String(
      h.db.prepare('SELECT id FROM scope_requests').get()?.id,
    );
    const path = `/owner/confirm/${scopeId}`;
    const page = await owner.request('GET', path);
    const before = grantCount(h.db);
    const approved = await owner.request('POST', path, {
      ...formFields(page, path),
      categories: 'musculoskeletal',
      maxSensitivity: 'routine',
      validityHours: 'requested',
    });
    const status = await clinician.request('GET', '/clinician');

    expect(asked.statusCode).toBe(303);
    expect(before).toBe(1);

    for (const shown of [dashboard, page]) {
      expect(shown.body).not.toContain(XSS_REASON);
      expect(shown.body).toContain('&lt;img src&#61;x');
    }

    expect(approved.statusCode).toBe(303);
    expect(
      h.db
        .prepare(
          `SELECT categories, allow_baseline, source FROM current_grants WHERE scope_request_id = ?`,
        )
        .get(scopeId),
    ).toEqual({
      categories: '["musculoskeletal"]',
      allow_baseline: 0,
      source: 'scope-request',
    });
    expect(status.body).toMatch(
      /musculoskeletal in [^<]+: <strong>approved<\/strong>/,
    );
  });

  it('should move the fragment token into the form with a hash-pinned script', async () => {
    harness = await portalHarness();

    const clinician = await signedIn(harness, 'clinician', 'cardiologist');
    const page = await clinician.request('GET', '/connect');

    expect(page.statusCode).toBe(200);
    expect(page.headers['content-security-policy']).toContain(
      `script-src 'sha256-${scriptHashOf(CONNECT_SCRIPT)}'`,
    );
    expect(page.body).toContain(`<script>${CONNECT_SCRIPT}</script>`);
    expect(page.body).toContain('name="token"');
  });

  it('should refuse an unknown share code with a generic page and no connection', async () => {
    harness = await portalHarness();

    const clinician = await signedIn(harness, 'clinician', 'cardiologist');
    const refused = await redeem(clinician, 'A'.repeat(43));

    expect(refused.statusCode).toBe(404);
    expect(refused.body).toContain('This invitation is not available');
    expect(
      harness.db.prepare('SELECT COUNT(*) AS n FROM connections').get(),
    ).toEqual({ n: 0 });
  });

  it('should send a signed-out visitor to a labelled sign-in page', async () => {
    harness = await portalHarness();

    const page = await harness.app.inject({
      method: 'GET',
      url: '/clinician',
      headers: { host: 'medissy.test' },
    });

    expect(page.statusCode).toBe(401);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    expect(page.body).toContain('SYNTHETIC DEMO');
    expect(page.body).toContain('href="/auth/clinician/sign-in"');
  });
});
