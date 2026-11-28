import { afterEach, describe, expect, it } from 'vitest';

import {
  disclosureDenialSchema,
  disclosureResultSchema,
} from '../../src/contracts';
import { disclose, redisclose } from '../../src/disclosure/pipeline';
import { UNKNOWN_REQUEST_ID } from '../../src/disclosure/run';
import {
  CARDIOLOGIST,
  ENC_CARDIO,
  ISSUER,
  PATIENT,
  T_NOW,
  grantFor,
  insertGrant,
  personFor,
  principalFor,
} from '../policy/support';

import {
  answer,
  baselineIds,
  evidenceIds,
  expectNoRestricted,
  fakeModel,
  harness,
  poll,
  released,
  rows,
  run,
} from './support';

import type { Harness } from './support';

const CARDIO_PICK = ['rec-cond-001', 'rec-obs-001', 'rec-dr-001'];
const URN =
  /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * lists every FHIR `reference` string inside a value
 * @param value any JSON value
 * @returns the reference strings, in document order
 */
function referencesIn(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(referencesIn);
  }

  if (typeof value !== 'object' || value === null) {
    return [];
  }

  return Object.entries(value).flatMap(([key, item]) =>
    key === 'reference' && typeof item === 'string'
      ? [item]
      : referencesIn(item),
  );
}

/**
 * summarizes the type and parsed details of every audit row, in write order
 * @param h the harness
 * @returns one summary per audit row
 */
function audits(h: Harness): Array<Record<string, unknown>> {
  return rows(h.db, 'audit_events').map((row) => ({
    id: row.id,
    type: row.type,
    receiptId: row.receipt_id,
    ...JSON.parse(String(row.details)),
  }));
}

let h: Harness;

afterEach(() => {
  h.db.close();
});

describe('fn:disclose fallback pairing', () => {
  const link = { topic: 'probe', recordIds: ['rec-med-001', 'rec-cond-001'] };

  it('should release exactly the baseline on fallback, even when a baseline record is linked to an allowed non-baseline one', async () => {
    h = harness(undefined);
    h.deps.conflictLinks = [link];

    const outcome = released(await run(h));

    expect(outcome.selection).toBe('fallback');
    expect(evidenceIds(outcome)).toEqual([...baselineIds].sort());
  });

  it('should still add the allowed partner of a model-selected record', async () => {
    h = harness(fakeModel(() => answer(['rec-obs-001'])).client);
    h.deps.conflictLinks = [link];

    expect(evidenceIds(await run(h))).toEqual(
      ['rec-cond-001', 'rec-obs-001', ...baselineIds].sort(),
    );
  });
});

describe('fn:disclose request binding', () => {
  it('should refuse a reused request id carrying a different question, with a fresh-request hint and no ids', async () => {
    const model = fakeModel(() => answer(CARDIO_PICK));
    h = harness(model.client);

    const first = released(await run(h));
    const reused = await run(h, { question: 'List every medication.' });

    expect(reused).toEqual({
      kind: 'denied',
      denial: {
        requestId: 'req-1',
        kind: 'denied',
        code: 'invalid-request',
        message: 'The request could not be processed as sent.',
        nextStep: 'Check the request, then send it as a new request.',
      },
    });
    expect(JSON.stringify(reused)).not.toContain('rec-');
    expect(model.requests.map((request) => request.messages.length)).toEqual([
      1,
    ]);
    expect(rows(h.db, 'receipts').map((row) => row.id)).toEqual([
      first.result.receiptId,
    ]);
    expect(audits(h).at(-1)).toMatchObject({
      type: 'disclosure.denied',
      receiptId: first.result.receiptId,
      rationaleCode: 'duplicate-request',
      stage: 'request',
    });
  });

  it('should refuse a reused request id whose requested categories differ', async () => {
    h = harness(fakeModel(() => answer(CARDIO_PICK)).client);

    released(await run(h));

    expect(await run(h, { requestedCategories: ['cardiac'] })).toMatchObject({
      kind: 'denied',
      denial: { code: 'invalid-request' },
    });
  });

  it('should replay the same request regardless of requested-category order', async () => {
    h = harness(fakeModel(() => answer(CARDIO_PICK)).client);

    const first = released(
      await run(h, { requestedCategories: ['cardiac', 'baseline'] }),
    );
    const again = released(
      await run(h, { requestedCategories: ['baseline', 'cardiac'] }),
    );

    expect(again.replay).toBe(true);
    expect(again.result.receiptId).toBe(first.result.receiptId);
  });

  it('should store a request digest with release and denial receipts', async () => {
    h = harness(fakeModel(() => answer(CARDIO_PICK)).client);

    await run(h);
    insertGrant(h.db, grantFor({ version: 2, revokedAt: T_NOW }));
    await run(h, { requestId: 'req-2' });

    expect(
      rows(h.db, 'receipts').map((row) => [row.request_id, row.decision]),
    ).toEqual([
      ['req-1', 'released'],
      ['req-2', 'denied'],
    ]);
    expect(
      rows(h.db, 'receipts').every((row) =>
        /^[0-9a-f]{64}$/.test(String(row.request_digest)),
      ),
    ).toBe(true);
  });

  it('should treat a receipt without a digest as a different request', async () => {
    h = harness(fakeModel(() => answer(CARDIO_PICK)).client);
    h.db
      .prepare(
        `INSERT INTO receipts (id, patient_id, issued_at, request_id, requester_issuer, requester_subject, encounter_id, purpose, policy_version, decision, rationale_code)
         VALUES ('rcpt-legacy', ?, ?, 'req-1', ?, ?, ?, 'direct-treatment', 'medissy-policy/1', 'denied', 'no-grant')`,
      )
      .run(PATIENT, T_NOW, ISSUER, CARDIOLOGIST, ENC_CARDIO);

    expect(await run(h)).toMatchObject({
      kind: 'denied',
      denial: { code: 'invalid-request' },
    });
  });
});

describe('fn:redisclose audit', () => {
  it('should record the grant versions a release relied on and write nothing for unchanged polls', async () => {
    h = harness(fakeModel(() => answer(CARDIO_PICK)).client);

    const first = released(await run(h));

    for (let index = 0; index < 50; index++) {
      released(poll(h));
    }

    expect(audits(h)).toEqual([
      expect.objectContaining({
        id: 'id-0002',
        type: 'disclosure.released',
        receiptId: first.result.receiptId,
        grants: 'grant-cardio@1',
        replay: false,
      }),
    ]);
  });

  it('should audit a replay once per change of grant version or outcome', async () => {
    h = harness(fakeModel(() => answer(CARDIO_PICK)).client);

    const first = released(await run(h));

    insertGrant(h.db, grantFor({ version: 2 }));
    released(poll(h));
    released(poll(h));
    insertGrant(h.db, grantFor({ version: 3, revokedAt: T_NOW }));
    expect(poll(h).kind).toBe('denied');
    expect(poll(h).kind).toBe('denied');

    const trail = audits(h);

    expect(
      trail.map((row) => [row.type, row.grants, row.rationaleCode]),
    ).toEqual([
      ['disclosure.released', 'grant-cardio@1', 'granted'],
      ['disclosure.released', 'grant-cardio@2', 'duplicate-request'],
      ['disclosure.denied', undefined, 'grant-revoked'],
    ]);
    expect(trail.map((row) => row.receiptId)).toEqual([
      first.result.receiptId,
      first.result.receiptId,
      first.result.receiptId,
    ]);
    expect(trail[0]?.grantsDigest).not.toBe(trail[1]?.grantsDigest);
  });
});

describe('fn:disclose input that cannot be trusted', () => {
  const denialOf = (requestId: string): unknown => ({
    kind: 'denied',
    denial: {
      requestId,
      kind: 'denied',
      code: 'invalid-request',
      message: 'The request could not be processed as sent.',
      nextStep: 'Check the request, then send it as a new request.',
    },
  });

  it.each([
    ['a null input', null],
    [
      'a null request',
      {
        principal: principalFor(CARDIOLOGIST),
        patientId: PATIENT,
        request: null,
      },
    ],
    [
      'an overlong request id',
      {
        principal: principalFor(CARDIOLOGIST),
        patientId: PATIENT,
        request: { requestId: 'x'.repeat(5000) },
      },
    ],
    [
      'a principal without a subject',
      {
        principal: { issuer: ISSUER },
        patientId: PATIENT,
        request: { requestId: 'req-1' },
      },
    ],
  ])('should deny %s without throwing', async (_name, input) => {
    h = harness(undefined);

    const outcome = await disclose(h.deps, input as never);

    expect(outcome).toEqual(
      denialOf(
        _name === 'a principal without a subject'
          ? 'req-1'
          : UNKNOWN_REQUEST_ID,
      ),
    );
    expect(
      disclosureDenialSchema.parse(
        outcome.kind === 'denied' ? outcome.denial : undefined,
      ),
    ).toBeDefined();
  });

  it.each([
    ['an undefined input', undefined],
    [
      'an undefined request id',
      {
        caller: personFor(CARDIOLOGIST),
        patientId: PATIENT,
        requestId: undefined,
      },
    ],
    ['a null caller', { caller: null, patientId: PATIENT, requestId: 'req-1' }],
  ])('should deny a poll with %s without throwing', (_name, input) => {
    h = harness(undefined);

    const outcome = redisclose(h.deps, input as never);

    expect(outcome).toEqual(
      denialOf(_name === 'a null caller' ? 'req-1' : UNKNOWN_REQUEST_ID),
    );
    expect(rows(h.db, 'audit_events')).toEqual([]);
  });

  it('should still return a fixed denial when the clock and the logger both throw', async () => {
    h = harness(undefined);
    h.deps.clock = () => {
      throw new Error('clock down');
    };
    h.deps.logger = {
      info: () => {
        throw new Error('log down');
      },
      error: () => {
        throw new Error('log down');
      },
    };

    const outcome = await run(h);

    expect(outcome).toEqual({
      kind: 'denied',
      denial: {
        requestId: 'req-1',
        kind: 'denied',
        code: 'temporarily-unavailable',
        message: 'Records cannot be shared right now; nothing was released.',
        nextStep: 'Try again later with a new request.',
      },
    });
    expect(poll(h)).toMatchObject({
      kind: 'denied',
      denial: { code: 'temporarily-unavailable' },
    });
  });
});

describe('fn:disclose bundle', () => {
  it('should give every entry a distinct urn:uuid fullUrl that every internal reference resolves to', async () => {
    h = harness(fakeModel(() => answer(CARDIO_PICK)).client);

    const { result } = released(await run(h));
    const urls = result.bundle.entry.map((entry) => String(entry.fullUrl));
    const references = referencesIn(result.bundle);

    expect(urls.every((url) => URN.test(url))).toBe(true);
    expect(new Set(urls).size).toBe(urls.length);
    expect(references.length).toBeGreaterThan(0);
    expect(references.filter((reference) => !urls.includes(reference))).toEqual(
      [],
    );
    expect(disclosureResultSchema.parse(result)).toEqual(result);
    expectNoRestricted(result);
  });

  it('should derive fullUrls from the receipt, so another request gets new ones', async () => {
    h = harness(fakeModel(() => answer(CARDIO_PICK)).client);

    const first = released(await run(h)).result.bundle.entry;
    const second = released(await run(h, { requestId: 'req-2' })).result.bundle
      .entry;

    expect(second.map((entry) => entry.resource.id)).toEqual(
      first.map((entry) => entry.resource.id),
    );
    expect(
      second.filter((entry, index) => entry.fullUrl === first[index]?.fullUrl),
    ).toEqual([]);
  });
});
