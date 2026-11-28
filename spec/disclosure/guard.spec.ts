import { describe, expect, it } from 'vitest';

import {
  closeReferences,
  guardRelease,
  ReleaseGuardError,
} from '../../src/disclosure/guard';
import { PATIENT } from '../policy/support';

import { decisionFor, projectionsFor } from './projections';

import type { RecordProjection } from '../../src/vault/filter';

const ALLOWED = ['rec-pat-001', 'rec-med-001', 'rec-prov-001', 'rec-cond-001'];
const projections = projectionsFor(ALLOWED);
const decision = decisionFor(projections);

describe('fn:guardRelease', () => {
  it('should return the chosen projections in filter order', () => {
    const released = guardRelease({
      recordIds: ['rec-cond-001', 'rec-pat-001'],
      decision,
      projections,
    });

    expect(released.map((item) => item.recordId)).toEqual([
      'rec-pat-001',
      'rec-cond-001',
    ]);
  });

  it('should fail closed on an id outside the decision or the filter output', () => {
    expect(() =>
      guardRelease({
        recordIds: ['rec-cond-001', 'rec-cond-007'],
        decision,
        projections,
      }),
    ).toThrow(ReleaseGuardError);
    expect(() =>
      guardRelease({
        recordIds: ['rec-cond-001'],
        decision,
        projections: projections.filter(
          (item) => item.recordId !== 'rec-cond-001',
        ),
      }),
    ).toThrow(ReleaseGuardError);
  });

  it('should fail closed on a repeated id', () => {
    expect(() =>
      guardRelease({
        recordIds: ['rec-cond-001', 'rec-cond-001'],
        decision,
        projections,
      }),
    ).toThrow('a record id is repeated in the release');
  });

  it('should fail closed when a projection disagrees with its decision entry', () => {
    const stale = {
      ...decision,
      records: decision.records.map((record) => ({
        ...record,
        grant: { ...record.grant, version: 2 },
      })),
    };
    const narrowed = {
      ...decision,
      approvedCategories: decision.approvedCategories.filter(
        (c) => c !== 'cardiac',
      ),
    };

    expect(() =>
      guardRelease({
        recordIds: ['rec-cond-001'],
        decision: stale,
        projections,
      }),
    ).toThrow('a projection disagrees with its decision');
    expect(() =>
      guardRelease({
        recordIds: ['rec-cond-001'],
        decision: narrowed,
        projections,
      }),
    ).toThrow(ReleaseGuardError);
  });

  it('should keep no error text that names a record', () => {
    try {
      guardRelease({ recordIds: ['rec-cond-007'], decision, projections });
    } catch (error) {
      expect(String(error)).not.toContain('rec-');
    }

    expect.assertions(1);
  });
});

describe('fn:closeReferences', () => {
  it('should strip the patient reference when the patient is not released', () => {
    const [condition] = closeReferences(
      projectionsFor(ALLOWED).filter(
        (item) => item.recordId === 'rec-cond-001',
      ),
    );

    expect(condition?.resource.subject).toBeUndefined();
    expect(condition?.resource.code).toBeDefined();
  });

  it('should keep a reference that resolves inside the release unchanged', () => {
    const chosen = projections.filter((item) =>
      ['rec-pat-001', 'rec-cond-001'].includes(item.recordId),
    );
    const closed = closeReferences(chosen);

    expect(closed[1]?.resource).toBe(chosen[1]?.resource);
    expect(closed[1]?.resource.subject).toEqual({
      reference: `Patient/${PATIENT}`,
    });
  });

  it('should withhold a provenance whose target is not released', () => {
    const chosen = projections.filter((item) =>
      ['rec-pat-001', 'rec-prov-001'].includes(item.recordId),
    );

    expect(closeReferences(chosen).map((item) => item.recordId)).toEqual([
      'rec-pat-001',
    ]);
  });

  it('should keep a provenance whose target is released', () => {
    const chosen = projections.filter((item) =>
      ['rec-med-001', 'rec-prov-001'].includes(item.recordId),
    );

    expect(closeReferences(chosen).map((item) => item.recordId)).toEqual([
      'rec-med-001',
      'rec-prov-001',
    ]);
  });

  it('should drop nested references and emptied arrays', () => {
    const [projection] = projectionsFor(['rec-cond-001']);

    if (!projection) {
      throw new Error('no projection');
    }

    const nested: RecordProjection = {
      ...projection,
      resource: {
        ...projection.resource,
        note: [{ author: { reference: 'Practitioner/p1' } }, { text: 'kept' }],
        extra: [{ reference: 'Practitioner/p2' }],
      },
    };
    const [closed] = closeReferences([nested]);

    expect(closed?.resource.note).toEqual([{ text: 'kept' }]);
    expect(closed?.resource.extra).toBeUndefined();
  });
});
