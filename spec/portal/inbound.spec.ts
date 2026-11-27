import { afterEach, describe, expect, it } from 'vitest';

import { createFixtureStore } from '../../src/box/fixture';
import { submitRecordInputSchema } from '../../src/contracts';
import {
  DEMO_CARDIOLOGIST,
  INSTITUTION_ISSUER,
} from '../../src/demo-idp/users';
import { createInboundPort } from '../../src/inbound/service';
import { PATIENT_ID } from '../identity/support';

import {
  ISSUER,
  formFields,
  mintToken,
  pendingConnectionId,
  portalHarness,
  redeem,
  signedIn,
} from './support';

import type { Browser, PortalHarness } from './support';

const FOLDER = '8800000002';

/** the choices a confirm form posts for the cardiologist's connection */
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
 * sets up an owner who granted the cardiologist cardiac access, then received one
 * record the cardiologist's agent handed back
 * @returns the harness, the owner's browser and the receipt id
 */
async function handedBack(): Promise<{
  h: PortalHarness;
  owner: Browser;
  submissionId: string;
  recordId: string;
}> {
  const h = await portalHarness();

  harness = h;

  const owner = await signedIn(h, 'owner', 'owner');
  const clinician = await signedIn(h, 'clinician', 'cardiologist');

  await redeem(clinician, await mintToken(owner));

  const confirmPath = `/owner/confirm/${pendingConnectionId(h.db)}`;
  const confirmPage = await owner.request('GET', confirmPath);

  await owner.request('POST', confirmPath, {
    ...formFields(confirmPage, confirmPath),
    ...CHOICE,
  });

  const port = createInboundPort({
    db: h.db,
    store: createFixtureStore(FOLDER),
    clock: h.clock.now,
  });
  const outcome = await port.submit({
    caller: { issuer: ISSUER, subject: DEMO_CARDIOLOGIST.subject },
    patientId: PATIENT_ID,
    requestId: 'req-portal-inbound',
    submission: submitRecordInputSchema.parse({
      skill: 'submit-record',
      document: {
        title: 'SYNTHETIC clinic letter <b>bold</b>',
        text: 'SYNTHETIC follow-up in six weeks.',
      },
    }),
  });

  if (outcome.kind !== 'filed') {
    throw new Error(`expected a filed record, got ${outcome.kind}`);
  }

  return {
    h,
    owner,
    submissionId: outcome.result.submissionId,
    recordId: outcome.result.recordId,
  };
}

/**
 * returns the status of one vault record
 * @param h the app and its vault
 * @param recordId the vault id of the filed record
 * @returns `current`, or `entered-in-error` once removed
 */
function statusOf(h: PortalHarness, recordId: string): string {
  return String(
    h.db.prepare('SELECT status FROM records WHERE id = ?').get(recordId)
      ?.status,
  );
}

describe('owner receipts for handed-back records (ADR-10)', () => {
  it('should list a received record with its verified clinician, filed name and Box file', async () => {
    const { h, owner, submissionId } = await handedBack();
    const row = h.db
      .prepare(
        'SELECT filed_name, box_file_id FROM inbound_submissions s JOIN record_sources r ON r.id = s.source_id WHERE s.id = ?',
      )
      .get(submissionId);

    const dashboard = await owner.request('GET', '/owner');

    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.body).toContain('Records received from your care team');
    expect(dashboard.body).toContain(DEMO_CARDIOLOGIST.displayName);
    expect(dashboard.body).toContain(
      INSTITUTION_ISSUER.institution?.organizationName,
    );
    expect(dashboard.body).toContain(String(row?.filed_name));
    expect(dashboard.body).toContain(`Box file ${String(row?.box_file_id)}`);
    expect(dashboard.body).toContain(`/owner/inbound/${submissionId}/remove`);
    expect(dashboard.body).not.toContain('<b>bold</b>');
  });

  it('should remove a received record: entered-in-error, audited, and listed without a Remove', async () => {
    const { h, owner, submissionId, recordId } = await handedBack();
    const action = `/owner/inbound/${submissionId}/remove`;
    const dashboard = await owner.request('GET', '/owner');

    const removed = await owner.request(
      'POST',
      action,
      formFields(dashboard, action),
    );
    const after = await owner.request('GET', '/owner');

    expect(removed.statusCode).toBe(303);
    expect(statusOf(h, recordId)).toBe('entered-in-error');
    expect(
      h.db
        .prepare(
          "SELECT outcome, actor_kind FROM audit_events WHERE type = 'record.removed'",
        )
        .all(),
    ).toEqual([{ outcome: 'success', actor_kind: 'owner' }]);
    expect(after.body).toContain('removed');
    expect(after.body).not.toContain(action);
  });

  it('should refuse Remove with a forged CSRF token and change nothing', async () => {
    const { h, owner, submissionId, recordId } = await handedBack();

    const posted = await owner.request(
      'POST',
      `/owner/inbound/${submissionId}/remove`,
      { _csrf: 'forged' },
    );

    expect(posted.statusCode).toBe(403);
    expect(statusOf(h, recordId)).toBe('current');
  });

  it.each(['unknown-receipt', 'bad%20id'])(
    'should answer not found for the receipt id %s and change nothing',
    async (id) => {
      const { h, owner, submissionId, recordId } = await handedBack();
      const dashboard = await owner.request('GET', '/owner');
      const fields = formFields(
        dashboard,
        `/owner/inbound/${submissionId}/remove`,
      );

      const posted = await owner.request(
        'POST',
        `/owner/inbound/${id}/remove`,
        fields,
      );

      expect(posted.statusCode).toBe(404);
      expect(statusOf(h, recordId)).toBe('current');
    },
  );
});
