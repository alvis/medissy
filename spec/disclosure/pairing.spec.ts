import { describe, expect, it } from 'vitest';

import {
  markConflicts,
  pairConflicts,
  parseConflictLinks,
} from '../../src/disclosure/pairing';
import { manifest } from '../policy/support';

import { projectionsFor } from './projections';

const links = parseConflictLinks(manifest);
const allowed = projectionsFor([
  'rec-med-001',
  'rec-med-002',
  'rec-med-003',
  'rec-cond-001',
]);

describe('fn:parseConflictLinks', () => {
  it('should keep the topic code and ids and drop the free-text note', () => {
    expect(links).toEqual([
      { topic: 'anticoagulant', recordIds: ['rec-med-001', 'rec-med-002'] },
    ]);
  });

  it('should reject a link with markup in its topic or a single member', () => {
    expect(() =>
      parseConflictLinks({
        conflicts: [{ topic: '<b>x</b>', recordIds: ['a', 'b'] }],
      }),
    ).toThrow();
    expect(() =>
      parseConflictLinks({ conflicts: [{ topic: 'x', recordIds: ['a'] }] }),
    ).toThrow();
  });
});

describe('fn:pairConflicts', () => {
  it('should add the allowed partner of a selected conflict member and mark the pair', () => {
    const result = pairConflicts({
      selectedIds: ['rec-cond-001', 'rec-med-002'],
      projections: allowed,
      links,
    });

    expect(result).toEqual({
      recordIds: ['rec-cond-001', 'rec-med-002', 'rec-med-001'],
      markers: [
        {
          kind: 'linked',
          topic: 'anticoagulant',
          recordIds: ['rec-med-001', 'rec-med-002'],
        },
      ],
    });
  });

  it('should never add a partner outside the allowed set, nor mention it', () => {
    const result = pairConflicts({
      selectedIds: ['rec-med-001'],
      projections: projectionsFor(['rec-med-001', 'rec-cond-001']),
      links,
    });

    expect(result).toEqual({ recordIds: ['rec-med-001'], markers: [] });
  });

  it('should leave a selection with no conflict member unchanged', () => {
    expect(
      pairConflicts({
        selectedIds: ['rec-cond-001'],
        projections: allowed,
        links,
      }),
    ).toEqual({
      recordIds: ['rec-cond-001'],
      markers: [],
    });
  });

  it('should follow links that share members to a fixpoint', () => {
    // the second link only fires after the first adds its shared member, so a
    // single pass over the links would miss rec-med-003
    const chained = [
      { topic: 'antihypertensive', recordIds: ['rec-med-002', 'rec-med-003'] },
      ...links,
    ];

    expect(
      pairConflicts({
        selectedIds: ['rec-med-001'],
        projections: allowed,
        links: chained,
      }).recordIds,
    ).toEqual(['rec-med-001', 'rec-med-002', 'rec-med-003']);
  });

  it('should not chain through a hidden member to reach another allowed record', () => {
    const throughHidden = [
      { topic: 'hidden-a', recordIds: ['rec-med-001', 'rec-med-004'] },
      { topic: 'hidden-b', recordIds: ['rec-med-004', 'rec-med-003'] },
    ];

    expect(
      pairConflicts({
        selectedIds: ['rec-med-001'],
        projections: allowed,
        links: throughHidden,
      }),
    ).toEqual({ recordIds: ['rec-med-001'], markers: [] });
  });

  it('should pass an id that is not allowed through untouched for the guard to refuse', () => {
    expect(
      pairConflicts({
        selectedIds: ['rec-cond-007'],
        projections: allowed,
        links,
      }).recordIds,
    ).toEqual(['rec-cond-007']);
  });
});

describe('fn:markConflicts', () => {
  it('should mark each released record under an open source conflict', () => {
    const projections = projectionsFor(
      ['rec-cond-001', 'rec-med-001'],
      ['rec-cond-001', 'rec-med-001'],
    );

    expect(
      markConflicts(new Set(['rec-cond-001']), projections, links),
    ).toEqual([{ kind: 'open-source-conflict', recordId: 'rec-cond-001' }]);
  });
});
