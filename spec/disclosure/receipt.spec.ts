import { describe, expect, it } from 'vitest';

import { verifyReleaseGrants } from '../../src/disclosure/receipt';
import {
  CARDIOLOGIST,
  ENC_CARDIO,
  ISSUER,
  NORTHGATE,
  T_GRANT_END,
  T_NOW,
  fixtureLabels,
  grantFor,
} from '../policy/support';

import type { Grant } from '../../src/contracts';
import type { GrantCheckParams } from '../../src/disclosure/receipt';

const NOW = new Date(T_NOW);

/**
 * builds a grant check for one cardiac and one baseline record under grant-cardio@1
 * @param overrides fields to replace
 * @returns the check parameters
 */
function check(overrides: Partial<GrantCheckParams> = {}): GrantCheckParams {
  return {
    records: [
      {
        recordId: 'rec-cond-001',
        category: 'cardiac',
        grant: { id: 'grant-cardio', version: 1 },
      },
      {
        recordId: 'rec-med-001',
        category: 'baseline',
        grant: { id: 'grant-cardio', version: 1 },
      },
    ],
    grants: [grantFor()],
    labels: fixtureLabels,
    caller: {
      issuer: ISSUER,
      subject: CARDIOLOGIST,
      organizationId: NORTHGATE,
      roles: ['cardiologist'],
    },
    encounterId: ENC_CARDIO,
    now: NOW,
    ...overrides,
  };
}

/**
 * runs the check with the only grant replaced
 * @param overrides grant fields to replace
 * @returns whether the release holds
 */
function withGrant(overrides: Partial<Grant>): boolean {
  return verifyReleaseGrants(check({ grants: [grantFor(overrides)] }));
}

describe('fn:verifyReleaseGrants', () => {
  it('should accept records whose latest live grant names the caller and covers them', () => {
    expect(verifyReleaseGrants(check())).toBe(true);
  });

  it('should refuse a grant that is no longer the latest version', () => {
    expect(withGrant({ version: 2 })).toBe(false);
  });

  it('should refuse a revoked, expired or not-yet-valid grant', () => {
    expect(withGrant({ revokedAt: T_NOW })).toBe(false);
    expect(withGrant({ expiresAt: T_NOW })).toBe(false);
    expect(withGrant({ validFrom: T_GRANT_END })).toBe(false);
  });

  it('should refuse a grant whose grantee is someone else', () => {
    expect(
      withGrant({ grantee: { issuer: ISSUER, subject: 'clin-other-1' } }),
    ).toBe(false);
    expect(
      withGrant({
        grantee: {
          issuer: 'https://other.example.invalid',
          subject: CARDIOLOGIST,
        },
      }),
    ).toBe(false);
  });

  it('should refuse a grant that no longer covers the record category', () => {
    expect(withGrant({ categories: ['dental'] })).toBe(false);
    expect(withGrant({ allowBaseline: false })).toBe(false);
  });

  it('should refuse a deny grant and a grant for another encounter', () => {
    expect(withGrant({ effect: 'deny' })).toBe(false);
    expect(withGrant({ encounterId: 'enc-dental-1' })).toBe(false);
  });

  it('should refuse a record whose label is gone or whose category changed', () => {
    expect(
      verifyReleaseGrants(
        check({
          labels: fixtureLabels.filter((label) => label.id !== 'rec-cond-001'),
        }),
      ),
    ).toBe(false);
    expect(
      verifyReleaseGrants(
        check({
          records: [
            {
              recordId: 'rec-cond-001',
              category: 'dental',
              grant: { id: 'grant-cardio', version: 1 },
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  it('should refuse a record whose grant is missing', () => {
    expect(verifyReleaseGrants(check({ grants: [] }))).toBe(false);
  });
});
