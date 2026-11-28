import { inspect } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  filterVault,
  projectResource,
  toModelInput,
} from '../../src/vault/filter';
import { VaultReadError } from '../../src/vault/records';
import {
  CANARY,
  CARDIOLOGIST,
  DENTIST,
  ENC_CARDIO,
  ENC_DENTAL,
  ISSUER,
  PATIENT,
  RIVERSIDE,
  T_GRANT_END,
  T_NOW,
  engineFor,
  fixtureRecords,
  grantFor,
  insertGrant,
  insertRecord,
  manifest,
  personFor,
  principalFor,
  seedVault,
} from '../policy/support';

import type { DatabaseSync, StatementSync } from 'node:sqlite';

import type { RecordEnvelope } from '../../src/contracts';
import type { PolicyAllow } from '../../src/policy/decide';
import type { FilterOutcome, RecordProjection } from '../../src/vault/filter';
import type { TestEngine } from '../policy/support';

const LATER = '2026-11-25T10:02:00.000Z';
const restrictedIds = manifest.groups.restricted;
const byId = new Map(fixtureRecords.map((record) => [record.id, record]));

let db: DatabaseSync;
let test: TestEngine;

/**
 * returns the stored fixture record
 * @param id the record id
 * @returns the envelope
 */
function fixture(id: string): RecordEnvelope {
  const record = byId.get(id);

  if (!record) {
    throw new Error(`no fixture ${id}`);
  }

  return record;
}

/**
 * decides for a clinician and requires an allow
 * @param subject the clinician
 * @param encounterId the encounter selector
 * @returns the decision narrowed to an allow
 */
function allowFor(subject: string, encounterId: string): PolicyAllow {
  test.setNow(T_NOW);

  const decision = test.engine.evaluate({
    principal: principalFor(subject),
    request: { encounterId, purpose: 'direct-treatment' },
  });

  if (decision.effect !== 'allow') {
    throw new Error(`expected allow, got ${decision.rationaleCode}`);
  }

  return decision;
}

/**
 * decides and filters for a clinician at an instant
 * @param subject the clinician
 * @param encounterId the encounter selector
 * @param iso the clock reading at use
 * @returns the filter outcome
 */
function filterFor(
  subject: string,
  encounterId: string,
  iso = LATER,
): FilterOutcome {
  const decision = allowFor(subject, encounterId);

  return useAt(decision, iso);
}

/**
 * filters a prior decision for its own caller at an instant
 * @param decision the allow decision relied on
 * @param iso the clock reading at use
 * @returns the filter outcome
 */
function useAt(decision: PolicyAllow, iso = LATER): FilterOutcome {
  test.setNow(iso);

  return filterVault(test.engine, {
    decision,
    caller: personFor(decision.caller.subject),
  });
}

/**
 * lists the released record ids, sorted
 * @param outcome the filter outcome
 * @returns the projected ids in ascending order
 */
function releasedIds(outcome: FilterOutcome): string[] {
  return projectionsOf(outcome)
    .map((projection) => projection.recordId)
    .sort();
}

/**
 * requires a release
 * @param outcome the filter outcome
 * @returns the released projections
 */
function projectionsOf(outcome: FilterOutcome): RecordProjection[] {
  if (outcome.kind !== 'released') {
    throw new Error(`expected release, got ${outcome.decision.rationaleCode}`);
  }

  return outcome.projections;
}

/**
 * returns the projection of one record
 * @param projections released projections to search
 * @param id the record id
 * @returns the matching projection
 */
function projectionOf(
  projections: RecordProjection[],
  id: string,
): RecordProjection {
  const found = projections.find((projection) => projection.recordId === id);

  if (!found) {
    throw new Error(`no projection ${id}`);
  }

  return found;
}

/**
 * lists every object key anywhere in a value
 * @param value a JSON value to walk
 * @returns every key at any depth
 */
function keysDeep(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(keysDeep);
  }

  return typeof value === 'object' && value !== null
    ? Object.entries(value).flatMap(([key, child]) => [key, ...keysDeep(child)])
    : [];
}

/**
 * asserts a serialised value leaks no restricted content
 * @param value anything that leaves the filter
 */
function expectNoRestricted(value: unknown): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value);

  expect(text).not.toContain(CANARY);

  for (const id of restrictedIds) {
    expect(text).not.toContain(id);
  }
}

beforeEach(() => {
  db = seedVault();
  insertGrant(db, grantFor());
  insertGrant(
    db,
    grantFor({
      id: 'grant-dental',
      grantee: {
        issuer: ISSUER,
        organizationId: RIVERSIDE,
        roles: ['dentist'],
      },
      encounterId: ENC_DENTAL,
      categories: ['dental'],
    }),
  );
  test = engineFor(db);
});

afterEach(() => {
  db.close();
});

describe('fn:filterVault', () => {
  describe('A04 curated evidence', () => {
    it.each([
      {
        scenario: 'cardiology',
        subject: CARDIOLOGIST,
        encounterId: ENC_CARDIO,
        expected: manifest.scenarios.cardiology.visibleRecordIds,
      },
      {
        scenario: 'dental',
        subject: DENTIST,
        encounterId: ENC_DENTAL,
        expected: manifest.scenarios.dental.visibleRecordIds,
      },
    ])(
      'should project exactly the $scenario scenario records',
      ({ subject, encounterId, expected }) => {
        const outcome = filterFor(subject, encounterId);

        expect(releasedIds(outcome)).toEqual([...expected].sort());
        expect(
          outcome.kind === 'released' &&
            outcome.decision.records.map((record) => record.recordId).sort(),
        ).toEqual([...expected].sort());
      },
    );

    it('should keep every allowlisted nested field and drop meta, narrative, identifiers and display-only references', () => {
      const projections = projectionsOf(filterFor(CARDIOLOGIST, ENC_CARDIO));

      for (const projection of projections) {
        const {
          meta: _meta,
          text: _text,
          identifier: _identifier,
          recorder: _recorder,
          informationSource: _informationSource,
          author: _author,
          performer,
          agent,
          ...expected
        } = fixture(projection.recordId).resource;
        const resolvedPerformer =
          projection.recordId === 'rec-obs-003' ? { performer } : {};
        const typedAgent = Array.isArray(agent)
          ? {
              agent: agent.map(({ type }: { type: unknown }) => ({ type })),
            }
          : {};

        expect(projection.resource).toEqual({
          ...expected,
          ...resolvedPerformer,
          ...typedAgent,
        });
      }
    });

    it('should project the cardiology blood pressure with its components and units', () => {
      const projection = projectionOf(
        projectionsOf(filterFor(CARDIOLOGIST, ENC_CARDIO)),
        'rec-obs-001',
      );

      expect(projection).toEqual({
        recordId: 'rec-obs-001',
        category: 'cardiac',
        grant: { id: 'grant-cardio', version: 1 },
        source: {
          provider: 'Northgate Cardiology Clinic',
          version: '1',
          authoredAt: fixture('rec-obs-001').source.authoredAt
            ? new Date(
                fixture('rec-obs-001').source.authoredAt ?? '',
              ).toISOString()
            : undefined,
          importedAt: new Date(
            fixture('rec-obs-001').source.importedAt,
          ).toISOString(),
          verification: 'synthetic-provider',
        },
        resource: {
          resourceType: 'Observation',
          id: 'rec-obs-001',
          status: 'final',
          code: {
            coding: [
              {
                system: 'http://loinc.org',
                code: '85354-9',
                display: 'Blood pressure panel with all children optional',
              },
            ],
            text: 'Blood pressure',
          },
          subject: { reference: `Patient/${PATIENT}` },
          category: [
            {
              coding: [
                {
                  system:
                    'http://terminology.hl7.org/CodeSystem/observation-category',
                  code: 'vital-signs',
                },
              ],
            },
          ],
          effectiveDateTime: '2026-10-14T10:20:00Z',
          component: [
            {
              code: {
                coding: [
                  {
                    system: 'http://loinc.org',
                    code: '8480-6',
                    display: 'Systolic blood pressure',
                  },
                ],
                text: 'Systolic blood pressure',
              },
              valueQuantity: {
                value: 142,
                unit: 'mmHg',
                system: 'http://unitsofmeasure.org',
                code: 'mm[Hg]',
              },
            },
            {
              code: {
                coding: [
                  {
                    system: 'http://loinc.org',
                    code: '8462-4',
                    display: 'Diastolic blood pressure',
                  },
                ],
                text: 'Diastolic blood pressure',
              },
              valueQuantity: {
                value: 86,
                unit: 'mmHg',
                system: 'http://unitsofmeasure.org',
                code: 'mm[Hg]',
              },
            },
          ],
        },
        openConflict: false,
      });
    });

    it('should project the patient without identifiers or narrative', () => {
      const projection = projectionOf(
        projectionsOf(filterFor(DENTIST, ENC_DENTAL)),
        'rec-pat-001',
      );

      expect(projection.resource).toEqual({
        resourceType: 'Patient',
        id: PATIENT,
        active: true,
        name: [
          {
            use: 'official',
            prefix: ['SYNTHETIC'],
            family: 'Testwell',
            given: ['Morgan'],
          },
        ],
        gender: 'female',
        birthDate: '1961-04-17',
      });
    });

    it('should keep a dental document as attachment metadata, its prose as data, and no link', () => {
      const projection = projectionOf(
        projectionsOf(filterFor(DENTIST, ENC_DENTAL)),
        'rec-doc-002',
      );

      expect(projection.source.verification).toBe('unverified');
      expect(projection.resource.content).toEqual([
        {
          attachment: {
            contentType: 'text/plain',
            title: 'riverside-referral-letter-2026-11-03.txt',
            creation: '2026-11-03T09:00:00Z',
            size: 1109,
          },
        },
      ]);
      expect(projection.resource.description).toBe(
        fixture('rec-doc-002').resource.description,
      );
    });

    it('should keep the provenance target that is in the same release', () => {
      const projection = projectionOf(
        projectionsOf(filterFor(CARDIOLOGIST, ENC_CARDIO)),
        'rec-prov-001',
      );

      expect(projection.resource.target).toEqual([
        { reference: 'MedicationStatement/rec-med-001' },
      ]);
    });
  });

  describe('A06 restricted content never leaves the filter', () => {
    it.each([
      ['cardiology', CARDIOLOGIST, ENC_CARDIO],
      ['dental', DENTIST, ENC_DENTAL],
    ])(
      'should keep the canary and restricted ids out of the %s outcome and model input',
      (_, subject, encounterId) => {
        const outcome = filterFor(subject, encounterId);

        expectNoRestricted(outcome);
        expectNoRestricted(toModelInput(projectionsOf(outcome)));
      },
    );

    it('should withhold restricted records even under a grant that covers them', () => {
      insertGrant(
        db,
        grantFor({
          id: 'grant-everything',
          categories: [
            'cardiac',
            'dental',
            'musculoskeletal',
            'dermatology',
            'mental-health',
            'substance-use',
          ],
          maxSensitivity: 'restricted',
        }),
      );

      const outcome = filterFor(CARDIOLOGIST, ENC_CARDIO);

      expectNoRestricted(outcome);
      expect(releasedIds(outcome)).toEqual(
        fixtureRecords
          .map((record) => record.id)
          .filter((id) => !restrictedIds.includes(id))
          .sort(),
      );
    });

    it('should drop references, links and metadata that point at restricted content', () => {
      insertRecord(db, {
        ...fixture('rec-doc-001'),
        id: 'rec-doc-901',
        resource: {
          ...fixture('rec-doc-001').resource,
          id: 'rec-doc-901',
          relatesTo: [
            { target: { reference: 'DocumentReference/rec-doc-003' } },
          ],
          author: [
            {
              reference: 'DocumentReference/rec-doc-003',
              display: `Author ${CANARY}`,
            },
            { display: 'Northgate Cardiology Clinic' },
          ],
          content: [
            {
              attachment: {
                contentType: 'text/plain',
                title: 'letter.txt',
                url: `https://box.example.invalid/files/${CANARY}`,
                data: Buffer.from(CANARY).toString('base64'),
                hash: 'abc',
              },
            },
          ],
          contained: [
            { resourceType: 'Condition', id: 'c1', note: [{ text: CANARY }] },
          ],
          extension: [
            { url: 'https://example.invalid/x', valueString: CANARY },
          ],
          meta: { tag: [{ code: CANARY }] },
          text: { status: 'generated', div: `<div>${CANARY}</div>` },
        },
      });

      const projection = projectionOf(
        projectionsOf(filterFor(CARDIOLOGIST, ENC_CARDIO)),
        'rec-doc-901',
      );

      expectNoRestricted(projection);
      expect(projection.resource).not.toHaveProperty('author');
      expect(projection.resource.content).toEqual([
        { attachment: { contentType: 'text/plain', title: 'letter.txt' } },
      ]);
      expect(keysDeep(projection.resource)).not.toEqual(
        expect.arrayContaining(['url']),
      );
    });

    it('should drop references to records outside the release and absolute or fragment references', () => {
      insertRecord(db, {
        ...fixture('rec-obs-001'),
        id: 'rec-obs-901',
        resource: {
          ...fixture('rec-obs-001').resource,
          id: 'rec-obs-901',
          performer: [
            { reference: 'Condition/rec-cond-005' },
            { reference: 'Observation/rec-obs-008' },
            { reference: `https://other.example.invalid/Patient/${PATIENT}` },
            { reference: '#contained-1' },
            { reference: 'Patient/someone-else' },
            {
              reference: 'Condition/rec-cond-001',
              display: 'Atrial fibrillation',
            },
            { reference: 'Observation/rec-cond-001' },
          ],
        },
      });

      const projection = projectionOf(
        projectionsOf(filterFor(CARDIOLOGIST, ENC_CARDIO)),
        'rec-obs-901',
      );

      expect(projection.resource.performer).toEqual([
        { reference: 'Condition/rec-cond-001', display: 'Atrial fibrillation' },
      ]);
    });

    it('should drop a logical reference and its display, which resolve to nothing', () => {
      insertRecord(db, {
        ...fixture('rec-obs-001'),
        id: 'rec-obs-903',
        resource: {
          ...fixture('rec-obs-001').resource,
          id: 'rec-obs-903',
          performer: [
            {
              identifier: { system: 'https://example.invalid', value: 'x' },
              display: `Seen at ${CANARY}`,
            },
            { display: `Clinic ${CANARY}` },
            { reference: `Patient/${PATIENT}`, display: 'Morgan Testwell' },
          ],
        },
      });

      const projection = projectionOf(
        projectionsOf(filterFor(CARDIOLOGIST, ENC_CARDIO)),
        'rec-obs-903',
      );

      expectNoRestricted(projection);
      expect(projection.resource.performer).toEqual([
        { reference: `Patient/${PATIENT}`, display: 'Morgan Testwell' },
      ]);
    });

    it('should resolve references by FHIR resource id, not by record id', () => {
      insertRecord(db, {
        ...fixture('rec-cond-001'),
        id: 'rec-cond-950',
        resource: { ...fixture('rec-cond-001').resource, id: 'cond-alpha' },
      });
      insertRecord(db, {
        ...fixture('rec-obs-001'),
        id: 'rec-obs-904',
        resource: {
          ...fixture('rec-obs-001').resource,
          id: 'rec-obs-904',
          performer: [
            { reference: 'Condition/cond-alpha' },
            { reference: 'Condition/rec-cond-950' },
            { reference: 'Patient/rec-pat-001' },
          ],
        },
      });

      const projection = projectionOf(
        projectionsOf(filterFor(CARDIOLOGIST, ENC_CARDIO)),
        'rec-obs-904',
      );

      expect(projection.resource.performer).toEqual([
        { reference: 'Condition/cond-alpha' },
      ]);
    });

    it('should withhold a routine provenance whose target is restricted', () => {
      insertRecord(db, {
        ...fixture('rec-prov-001'),
        id: 'rec-prov-901',
        category: 'cardiac',
        resource: {
          ...fixture('rec-prov-001').resource,
          id: 'rec-prov-901',
          target: [
            { reference: 'MedicationStatement/rec-med-001' },
            { reference: 'DocumentReference/rec-doc-003' },
          ],
        },
      });

      const outcome = filterFor(CARDIOLOGIST, ENC_CARDIO);

      expectNoRestricted(outcome);
      expect(
        projectionsOf(outcome).map((projection) => projection.recordId),
      ).not.toContain('rec-prov-901');
      expect(
        outcome.kind === 'released' &&
          outcome.decision.records.some(
            (record) => record.recordId === 'rec-prov-901',
          ),
      ).toBe(false);
    });

    it('should withhold a provenance chain whose last link targets restricted content', () => {
      insertRecord(db, {
        ...fixture('rec-prov-001'),
        id: 'rec-prov-902',
        resource: {
          ...fixture('rec-prov-001').resource,
          id: 'rec-prov-902',
          target: [{ reference: 'DocumentReference/rec-doc-003' }],
        },
      });
      insertRecord(db, {
        ...fixture('rec-prov-001'),
        id: 'rec-prov-901',
        resource: {
          ...fixture('rec-prov-001').resource,
          id: 'rec-prov-901',
          target: [{ reference: 'Provenance/rec-prov-902' }],
        },
      });

      const outcome = filterFor(CARDIOLOGIST, ENC_CARDIO);

      expectNoRestricted(outcome);
      expect(releasedIds(outcome)).toEqual(
        [...manifest.scenarios.cardiology.visibleRecordIds].sort(),
      );
      expect(
        outcome.kind === 'released' &&
          outcome.decision.records.map((record) => record.recordId).sort(),
      ).toEqual([...manifest.scenarios.cardiology.visibleRecordIds].sort());
    });

    it('should fail with a content-free error when an allowed record body is invalid', () => {
      insertRecord(db, {
        ...fixture('rec-obs-001'),
        id: 'rec-obs-902',
        resource: {
          resourceType: 'Observation',
          id: 'rec-obs-902',
          subject: { reference: `Patient/${CANARY}` },
          note: [{ text: CANARY }],
        },
      });

      const run = (): FilterOutcome => filterFor(CARDIOLOGIST, ENC_CARDIO);

      expect(run).toThrow(
        new VaultReadError('stored record failed validation'),
      );

      try {
        run();
      } catch (error) {
        expectNoRestricted(inspect(error, { depth: 20 }));
        expectNoRestricted(
          JSON.stringify(error, Object.getOwnPropertyNames(error)),
        );
      }
    });
  });

  describe('A07 re-check at use', () => {
    it('should release nothing and read no record body after revocation mid-request', () => {
      const decision = allowFor(CARDIOLOGIST, ENC_CARDIO);

      insertGrant(
        db,
        grantFor({ version: 2, revokedAt: '2026-11-25T10:01:00.000Z' }),
      );

      const prepare = vi.spyOn(db, 'prepare');
      const outcome = useAt(decision);

      expect(outcome).toEqual({
        kind: 'denied',
        decision: expect.objectContaining({
          effect: 'deny',
          rationaleCode: 'grant-revoked',
        }),
      });
      expect(
        prepare.mock.calls.some(([sql]) => /\br\.resource\b/.test(sql)),
      ).toBe(false);
    });

    it('should release nothing once the grant expires between decision and use', () => {
      const outcome = filterFor(CARDIOLOGIST, ENC_CARDIO, T_GRANT_END);

      expect(outcome).toMatchObject({
        kind: 'denied',
        decision: { rationaleCode: 'grant-expired' },
      });
    });

    it('should drop a record marked entered-in-error between decision and use', () => {
      const decision = allowFor(CARDIOLOGIST, ENC_CARDIO);

      db.prepare(
        `UPDATE records SET status = 'entered-in-error' WHERE id = 'rec-obs-001'`,
      ).run();

      const outcome = useAt(decision);

      expect(releasedIds(outcome)).toEqual(
        manifest.scenarios.cardiology.visibleRecordIds
          .filter((id) => id !== 'rec-obs-001')
          .sort(),
      );
    });

    it('should re-check and read bodies in one snapshot', () => {
      const decision = allowFor(CARDIOLOGIST, ENC_CARDIO);
      const exec = vi.spyOn(db, 'exec');

      useAt(decision);

      expect(exec.mock.calls).toEqual([['BEGIN'], ['COMMIT']]);
    });

    it('should refuse a body read that is not current, with a content-free error', () => {
      const decision = allowFor(CARDIOLOGIST, ENC_CARDIO);
      const prepare = db.prepare.bind(db);

      vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
        const statement = prepare(sql);

        return sql.includes('JOIN record_sources')
          ? ({
              all: (...args: Parameters<StatementSync['all']>) =>
                statement
                  .all(...args)
                  .map((row) => ({ ...row, status: 'superseded' })),
            } as unknown as StatementSync)
          : statement;
      });

      expect(() => useAt(decision)).toThrow(
        new VaultReadError('an allowed record is no longer current'),
      );
      expect(db.isTransaction).toBe(false);
    });

    it('should never widen to a category approved after the decision', () => {
      const decision = allowFor(CARDIOLOGIST, ENC_CARDIO);

      insertGrant(db, grantFor({ id: 'grant-later', categories: ['dental'] }));

      const outcome = useAt(decision);

      expect(releasedIds(outcome)).toEqual(
        [...manifest.scenarios.cardiology.visibleRecordIds].sort(),
      );
    });
  });
});

describe('fn:toModelInput', () => {
  it('should carry only record ids and allowed fields', () => {
    db.close();
    db = seedVault();
    insertGrant(db, grantFor());
    test = engineFor(db);

    const projections = projectionsOf(filterFor(CARDIOLOGIST, ENC_CARDIO));

    const result = toModelInput(projections);

    expect(result).toEqual(
      projections.map((projection) => ({
        recordId: projection.recordId,
        fields: projection.resource,
      })),
    );
  });
});

describe('fn:projectResource', () => {
  const scope = { patientId: PATIENT, released: new Set<string>() };

  it.each(manifest.groups.restricted)(
    'should withhold restricted record %s',
    (id) => {
      const result = projectResource(fixture(id), scope);

      expect(result).toBeUndefined();
    },
  );

  it('should drop values whose shape does not match the allowlist', () => {
    const record = fixture('rec-cond-001');

    const result = projectResource(
      {
        ...record,
        resource: {
          ...record.resource,
          code: 'not-a-codeable-concept',
          onsetDateTime: { nested: CANARY },
          recordedDate: [[CANARY]],
          clinicalStatus: {
            coding: [{ code: Number.NaN, system: { x: CANARY } }],
          },
        },
      },
      scope,
    );

    expect(result).not.toHaveProperty('code');
    expect(result).not.toHaveProperty('onsetDateTime');
    expect(result).not.toHaveProperty('recordedDate');
    expect(result).not.toHaveProperty('clinicalStatus');
    expectNoRestricted(result);
  });
});
