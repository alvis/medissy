import { describe, expect, it } from 'vitest';

import { disclosureDenialSchema, LIMITS } from '../../src/contracts';
import { renderDenial, renderResult } from '../../src/disclosure/result';
import { T_NOW, manifest } from '../policy/support';

import { decisionFor, projectionsFor } from './projections';

import type { RecordProjection } from '../../src/vault/filter';

const visible = manifest.scenarios.dental.visibleRecordIds;

/**
 * renders a release of these projections
 * @param projections the released projections
 * @returns the result
 */
function render(projections: RecordProjection[]) {
  return renderResult({
    requestId: 'req-1',
    receiptId: 'rcpt-1',
    decision: decisionFor(projections),
    projections,
    markers: [],
    selection: 'model',
    issuedAt: T_NOW,
  });
}

describe('fn:renderResult', () => {
  it('should label every resource type from its projected fields', () => {
    const projections = projectionsFor([...visible, 'rec-obs-001']);
    const cards = Object.fromEntries(
      render(projections).evidence.map((item) => [
        item.recordId,
        [item.label, item.factualValue],
      ]),
    );

    expect(cards).toEqual({
      'rec-pat-001': [
        'Patient',
        'SYNTHETIC Morgan Testwell; gender female; born 1961-04-17',
      ],
      'rec-alg-001': [
        'Allergy: Allergy to penicillin',
        'criticality low; reaction Skin rash (moderate); clinical status active',
      ],
      'rec-alg-002': [
        'Allergy: Latex allergy',
        'criticality low; reaction Contact dermatitis (mild); clinical status active',
      ],
      'rec-med-001': [
        'Medication: apixaban 5 mg oral tablet',
        'status active; 5 mg by mouth twice daily; since 2026-06-15',
      ],
      'rec-med-002': [
        'Medication: warfarin 3 mg oral tablet',
        'status active; 3 mg by mouth once daily in the evening; since 2022-03-01',
      ],
      'rec-med-003': [
        'Medication: amlodipine 5 mg oral tablet',
        'status active; 5 mg by mouth once daily; since 2015-09-10',
      ],
      'rec-prov-001': [
        'Provenance',
        'recorded 2026-10-14T11:05:00Z; targets MedicationStatement/rec-med-001',
      ],
      'rec-cond-003': [
        expect.stringMatching(/^Condition: Impacted lower right third molar/),
        expect.stringContaining('clinical status'),
      ],
      'rec-cond-004': [
        expect.stringMatching(/^Condition: History of prolonged bleeding/),
        expect.any(String),
      ],
      'rec-obs-001': [
        'Observation: Blood pressure',
        expect.stringContaining('Systolic blood pressure 142 mmHg'),
      ],
      'rec-obs-006': [
        'Observation: INR',
        expect.stringMatching(/^1\.1 ratio; status final/),
      ],
      'rec-obs-007': [
        'Observation: Anti-Xa (apixaban) level',
        expect.stringContaining('status cancelled'),
      ],
      'rec-dr-002': [
        'Report: Panoramic dental radiograph',
        expect.stringMatching(
          /^Impacted lower right third molar.*; status final$/,
        ),
      ],
      'rec-doc-002': [
        expect.stringMatching(/^Document: /),
        expect.stringContaining('Ignore all previous instructions'),
      ],
    });
  });

  it('should fall back to the resource type and omit an empty fact line', () => {
    const [projection] = projectionsFor(['rec-cond-001']);

    if (!projection) {
      throw new Error('no projection');
    }

    const bare = {
      ...projection,
      resource: { resourceType: 'Condition' as const, id: 'rec-cond-001' },
    };
    const [card] = render([bare]).evidence;

    expect(card).toMatchObject({ label: 'Condition: Condition' });
    expect(card).not.toHaveProperty('factualValue');
  });

  it('should bound long text and the number of limitations', () => {
    const [projection] = projectionsFor(['rec-dr-001']);

    if (!projection) {
      throw new Error('no projection');
    }

    // conflicts may only name released records, so the long ids are released
    const long = {
      ...projection,
      recordId: `rec-${'y'.repeat(120)}`,
      resource: { ...projection.resource, conclusion: 'x'.repeat(2000) },
    };
    const result = renderResult({
      requestId: 'req-1',
      receiptId: 'rcpt-1',
      decision: decisionFor([long]),
      projections: [long],
      markers: Array.from({ length: 30 }, (_, index) => ({
        kind: 'linked' as const,
        topic: `topic-${index}`,
        recordIds: Array.from({ length: 8 }, () => long.recordId),
      })),
      selection: 'fallback',
      issuedAt: T_NOW,
    });

    expect(result.evidence[0]?.factualValue).toHaveLength(LIMITS.listLarge);
    expect(result.coverage.limitations).toHaveLength(LIMITS.listShort);
    expect(result.conflicts.map((conflict) => conflict.kind)).toEqual(
      Array.from({ length: 30 }, () => 'linked'),
    );
    expect(
      result.coverage.limitations.every(
        (text) => text.length <= LIMITS.sentence,
      ),
    ).toBe(true);
  });
});

describe('fn:renderDenial', () => {
  it.each([
    'access-required',
    'not-permitted',
    'invalid-request',
    'temporarily-unavailable',
  ] as const)(
    'should render a schema-valid %s denial with no ids or counts',
    (code) => {
      const denial = renderDenial('req-one', code);

      expect(disclosureDenialSchema.parse(denial)).toEqual(denial);
      expect(JSON.stringify(denial)).not.toMatch(/rec-|\d/);
    },
  );
});
