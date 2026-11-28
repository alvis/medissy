import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { filterVault } from '../../src/vault/filter';
import {
  VaultReadError,
  readOpenConflicts,
  readRecordLabels,
  readRecords,
} from '../../src/vault/records';
import {
  CANARY,
  CARDIOLOGIST,
  ENC_CARDIO,
  ISSUER,
  OWNER,
  PATIENT,
  T_NOW,
  engineFor,
  fixtureRecords,
  grantFor,
  insertConflict,
  insertGrant,
  manifest,
  personFor,
  principalFor,
  seedVault,
} from '../policy/support';

import type { DatabaseSync } from 'node:sqlite';

import type { RecordEnvelope } from '../../src/contracts';
import type { FilterOutcome } from '../../src/vault/filter';

const MARKER = 'INCOMING-COPY-MARKER';

let db: DatabaseSync;

beforeEach(() => {
  db = seedVault();
});

afterEach(() => {
  db.close();
});

describe('fn:readRecordLabels', () => {
  it('should return labels for every record without any body', () => {
    const result = readRecordLabels(db, PATIENT);

    expect(result.map((label) => label.id)).toEqual(
      fixtureRecords.map((record) => record.id).sort(),
    );
    expect(Object.keys(result[0] ?? {}).sort()).toEqual([
      'category',
      'id',
      'resourceType',
      'sensitivity',
      'status',
    ]);
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it('should ignore an uncurated, source-only file', () => {
    db.prepare(
      `INSERT INTO record_sources (patient_id, provider, box_file_id, version, sha256, verification, imported_at)
       VALUES (?, 'Unknown', '9100000099', '1', ?, 'unverified', ?)`,
    ).run(PATIENT, 'a'.repeat(64), T_NOW);

    const result = readRecordLabels(db, PATIENT);

    expect(result.map((label) => label.id)).toEqual(
      fixtureRecords.map((record) => record.id).sort(),
    );
  });
});

describe('fn:readRecords', () => {
  it('should read exactly the requested ids in the requested order', () => {
    const result = readRecords(db, PATIENT, ['rec-obs-001', 'rec-pat-001']);

    expect(result.map((record) => record.id)).toEqual([
      'rec-obs-001',
      'rec-pat-001',
    ]);
    expect(result[0]?.source).toEqual({
      provider: 'Northgate Cardiology Clinic',
      boxFileId: '9100000011',
      version: '1',
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      authoredAt: expect.any(String),
      importedAt: expect.any(String),
      verification: 'synthetic-provider',
    });
  });

  it('should read nothing for no ids', () => {
    const prepare = vi.spyOn(db, 'prepare');

    const result = readRecords(db, PATIENT, []);

    expect(result).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('should fail with a content-free error for an id it cannot find', () => {
    expect(() => readRecords(db, PATIENT, ['rec-missing'])).toThrow(
      new VaultReadError('an allowed record is missing from the vault'),
    );
  });

  it('should not read another patient record', () => {
    expect(() => readRecords(db, 'other-patient', ['rec-obs-001'])).toThrow(
      VaultReadError,
    );
  });
});

describe('record conflicts', () => {
  const cardiology = [...manifest.scenarios.cardiology.visibleRecordIds].sort();
  const original = fixtureRecords.find((record) => record.id === 'rec-obs-001');

  /**
   * builds an incoming copy of rec-obs-001 with changed labels and a marked body
   * @param labels label fields to replace on the incoming envelope
   * @returns the incoming envelope
   */
  function incomingCopy(
    labels: Partial<Pick<RecordEnvelope, 'category' | 'sensitivity'>> = {},
  ): unknown {
    return {
      ...original,
      ...labels,
      source: { ...original?.source, version: '2', sha256: 'b'.repeat(64) },
      resource: {
        ...original?.resource,
        status: 'amended',
        note: [{ text: `${MARKER} ${CANARY}` }],
      },
    };
  }

  /**
   * decides and filters the cardiology request
   * @returns the filter outcome
   */
  function cardiologyOutcome(): FilterOutcome {
    const { engine } = engineFor(db);
    const decision = engine.evaluate({
      principal: principalFor(CARDIOLOGIST),
      request: { encounterId: ENC_CARDIO, purpose: 'direct-treatment' },
    });

    if (decision.effect !== 'allow') {
      throw new Error(`expected allow, got ${decision.rationaleCode}`);
    }

    return filterVault(engine, { decision, caller: personFor(CARDIOLOGIST) });
  }

  /**
   * returns the released ids and the ids flagged with an open conflict
   * @param outcome the filter outcome
   * @returns both sorted id lists
   */
  function releaseOf(outcome: FilterOutcome): {
    released: string[];
    flagged: string[];
  } {
    const projections = outcome.kind === 'released' ? outcome.projections : [];

    return {
      released: projections.map((projection) => projection.recordId).sort(),
      flagged: projections
        .filter((projection) => projection.openConflict)
        .map((projection) => projection.recordId)
        .sort(),
    };
  }

  beforeEach(() => {
    insertGrant(db, grantFor());
  });

  it('should release a record under a same-label open conflict as its original, flagged', () => {
    insertConflict(db, {
      id: 'conflict-1',
      recordId: 'rec-obs-001',
      incoming: incomingCopy(),
    });

    const outcome = cardiologyOutcome();
    const text = JSON.stringify(outcome);

    expect(releaseOf(outcome)).toEqual({
      released: cardiology,
      flagged: ['rec-obs-001'],
    });
    expect(text).not.toContain(MARKER);
    expect(text).not.toContain(CANARY);
    expect(
      outcome.kind === 'released' &&
        outcome.projections.find(
          (projection) => projection.recordId === 'rec-obs-001',
        )?.resource.status,
    ).toBe('final');
  });

  it.each([
    {
      change: 'a restricted category',
      labels: { category: 'mental-health', sensitivity: 'restricted' },
    },
    { change: 'another routine category', labels: { category: 'dental' } },
    { change: 'a higher sensitivity', labels: { sensitivity: 'restricted' } },
    { change: 'an invalid sensitivity', labels: { sensitivity: 'secret' } },
  ] as const)(
    'should withhold a record whose open conflict carries $change',
    ({ labels }) => {
      insertConflict(db, {
        id: 'conflict-1',
        recordId: 'rec-obs-001',
        incoming: incomingCopy(labels as Partial<RecordEnvelope>),
      });

      const outcome = cardiologyOutcome();

      expect(
        readRecordLabels(db, PATIENT).map((label) => label.id),
      ).not.toContain('rec-obs-001');
      expect(releaseOf(outcome)).toEqual({
        released: cardiology.filter((id) => id !== 'rec-obs-001'),
        flagged: [],
      });
      expect(JSON.stringify(outcome)).not.toContain(MARKER);
    },
  );

  it('should let a stricter open conflict win over a same-label one on the same record', () => {
    insertConflict(db, {
      id: 'conflict-1',
      recordId: 'rec-obs-001',
      incoming: incomingCopy(),
    });
    insertConflict(db, {
      id: 'conflict-2',
      recordId: 'rec-obs-001',
      incoming: incomingCopy({ sensitivity: 'restricted' }),
    });

    expect([...readOpenConflicts(db, PATIENT)]).toEqual([
      ['rec-obs-001', 'withhold'],
    ]);
  });

  it('should stop flagging or withholding once the conflict is resolved', () => {
    insertConflict(db, {
      id: 'conflict-1',
      recordId: 'rec-obs-001',
      incoming: incomingCopy({ category: 'mental-health' }),
    });
    db.prepare(
      `UPDATE record_conflicts SET status = 'kept-original', resolved_by_issuer = ?, resolved_by_subject = ?, resolved_at = ?
       WHERE id = 'conflict-1'`,
    ).run(ISSUER, OWNER, T_NOW);

    expect(readOpenConflicts(db, PATIENT).size).toBe(0);
    expect(releaseOf(cardiologyOutcome())).toEqual({
      released: cardiology,
      flagged: [],
    });
  });
});
