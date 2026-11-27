import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POLICY_VERSION } from '../../src/policy/decide';
import { PolicyEngine } from '../../src/policy/engine';
import { PolicyDataError, readClinician } from '../../src/policy/repository';

import {
  CARDIOLOGIST,
  DENTIST,
  ENC_CARDIO,
  ENC_DENTAL,
  ISSUER,
  RIVERSIDE,
  SUSPENDED,
  T_GRANT_END,
  T_NOW,
  T_SEED,
  UNGRANTED,
  clockAt,
  engineFor,
  grantFor,
  insertGrant,
  insertScopeRequest,
  manifest,
  personFor,
  principalFor,
  seedVault,
} from './support';

import type { DatabaseSync } from 'node:sqlite';

import type { PolicyAllow, PolicyDecision } from '../../src/policy/decide';

import type { TestEngine } from './support';

const REQUEST = {
  encounterId: ENC_CARDIO,
  purpose: 'direct-treatment',
} as const;
const APPROVED_FROM = '2026-11-26T00:00:00.000Z';
const APPROVED_UNTIL = '2026-11-28T00:00:00.000Z';

let db: DatabaseSync;
let test: TestEngine;

/**
 * evaluates a cardiologist request at an instant
 * @param iso the clock reading
 * @param subject the requesting clinician
 * @param encounterId the encounter selector
 * @returns the decision
 */
function evaluateAt(
  iso: string,
  subject = CARDIOLOGIST,
  encounterId: string = ENC_CARDIO,
): PolicyDecision {
  test.setNow(iso);

  return test.engine.evaluate({
    principal: principalFor(subject),
    request: { ...REQUEST, encounterId },
  });
}

/**
 * re-checks a prior decision for the cardiologist at an instant
 * @param prior the decision being relied on
 * @param iso the clock reading
 * @returns the re-checked decision
 */
function recheckAt(prior: PolicyAllow, iso: string): PolicyDecision {
  test.setNow(iso);

  return test.engine.recheck({ prior, caller: personFor(CARDIOLOGIST) });
}

/**
 * replaces a stored grant row in place, bypassing the append-only trigger
 * @param id which stored grant to corrupt
 * @param assignment the SQL assignment that corrupts it
 */
function corruptGrant(id: string, assignment: string): void {
  db.exec('DROP TRIGGER grants_no_update');
  db.prepare(`UPDATE grants SET ${assignment} WHERE id = ?`).run(id);
}

/**
 * lists the ids a decision releases, sorted
 * @param decision an allow or a deny
 * @returns the released ids, empty for a deny
 */
function idsOf(decision: PolicyDecision): string[] {
  return decision.effect === 'allow'
    ? sorted(decision.records.map((record) => record.recordId))
    : [];
}

/**
 * returns a sorted copy
 * @param ids record ids
 * @returns the ids in ascending order
 */
function sorted(ids: readonly string[]): string[] {
  return [...ids].sort();
}

/**
 * requires an allow
 * @param decision a decision expected to allow
 * @returns the decision narrowed to an allow
 */
function allowOf(decision: PolicyDecision): PolicyAllow {
  if (decision.effect !== 'allow') {
    throw new Error(`expected allow, got ${decision.rationaleCode}`);
  }

  return decision;
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

describe('cl:PolicyEngine', () => {
  describe('mt:evaluate', () => {
    describe('A04 curated scenarios', () => {
      it('should release exactly the cardiology scenario ids under grant-cardio v1', () => {
        const result = allowOf(evaluateAt(T_NOW));

        expect(idsOf(result)).toEqual(
          sorted(manifest.scenarios.cardiology.visibleRecordIds),
        );
        expect(result.approvedCategories).toEqual(['baseline', 'cardiac']);
        expect(result.policyVersion).toBe(POLICY_VERSION);
        expect(
          new Set(
            result.records.map(
              (record) => `${record.grant.id}@${record.grant.version}`,
            ),
          ),
        ).toEqual(new Set(['grant-cardio@1']));
      });

      it('should release exactly the dental scenario ids under grant-dental v1', () => {
        const result = allowOf(evaluateAt(T_NOW, DENTIST, ENC_DENTAL));

        expect(idsOf(result)).toEqual(
          sorted(manifest.scenarios.dental.visibleRecordIds),
        );
        expect(result.approvedCategories).toEqual(['baseline', 'dental']);
        expect(result.caller).toEqual({
          issuer: ISSUER,
          subject: DENTIST,
          organizationId: RIVERSIDE,
          roles: ['dentist'],
        });
      });

      it('should keep the two evidence sets distinct and share exactly the baseline', () => {
        const cardiac = idsOf(evaluateAt(T_NOW));
        const dental = idsOf(evaluateAt(T_NOW, DENTIST, ENC_DENTAL));

        const shared = cardiac.filter((id) => dental.includes(id));

        expect(shared).toEqual(sorted(manifest.groups.baseline));
        expect(cardiac.filter((id) => !shared.includes(id))).toEqual(
          sorted(manifest.groups.cardiac),
        );
        expect(dental.filter((id) => !shared.includes(id))).toEqual(
          sorted(manifest.groups.dental),
        );
      });

      it('should release nothing to a registered clinician without a grant', () => {
        const result = evaluateAt(T_NOW, UNGRANTED, 'enc-ungranted-1');

        expect(result).toMatchObject({
          effect: 'deny',
          rationaleCode: 'no-grant',
        });
        expect(idsOf(result)).toEqual(
          manifest.scenarios.unauthorizedClinician.visibleRecordIds,
        );
      });
    });

    describe('identity and encounter (A02, A05)', () => {
      it('should release nothing to an unknown verified clinician', () => {
        const result = evaluateAt(T_NOW, 'clin-never-registered');

        expect(result).toMatchObject({
          effect: 'deny',
          rationaleCode: 'principal-not-registered',
        });
      });

      it('should release nothing to a suspended clinician', () => {
        const result = evaluateAt(T_NOW, SUSPENDED, 'enc-suspended-1');

        expect(result).toMatchObject({
          rationaleCode: 'principal-not-registered',
        });
      });

      it('should give a guessed encounter of another clinician the same deny as a made-up id', () => {
        const guessed = evaluateAt(T_NOW, CARDIOLOGIST, ENC_DENTAL);
        const madeUp = evaluateAt(T_NOW, CARDIOLOGIST, 'enc-does-not-exist');

        expect(guessed).toMatchObject({ rationaleCode: 'encounter-not-found' });
        expect(guessed).toEqual(madeUp);
      });
    });

    describe('A07 scope expansion and fail-closed grant states', () => {
      it('should yield nothing new for a pending scope request', () => {
        const before = evaluateAt(T_NOW);

        insertScopeRequest(db, {
          id: 'scope-1',
          categories: ['dental'],
          status: 'pending',
        });

        expect(evaluateAt(T_NOW)).toEqual(before);
      });

      it.each(['declined', 'expired'] as const)(
        'should yield nothing new for a %s scope request',
        (status) => {
          const before = evaluateAt(T_NOW);

          insertScopeRequest(db, {
            id: 'scope-1',
            categories: ['dental'],
            status,
          });

          expect(evaluateAt(T_NOW)).toEqual(before);
        },
      );

      describe('after approval of dental for a bounded window', () => {
        beforeEach(() => {
          insertScopeRequest(db, {
            id: 'scope-1',
            categories: ['dental'],
            status: 'approved',
            grantId: 'grant-scope-1',
          });
          insertGrant(
            db,
            grantFor({
              id: 'grant-scope-1',
              categories: ['dental'],
              allowBaseline: false,
              validFrom: APPROVED_FROM,
              expiresAt: APPROVED_UNTIL,
            }),
            'scope-1',
          );
        });

        it('should add only the approved category inside the approved window', () => {
          const result = allowOf(evaluateAt('2026-11-27T00:00:00.000Z'));

          expect(idsOf(result)).toEqual(
            sorted([
              ...manifest.scenarios.cardiology.visibleRecordIds,
              ...manifest.groups.dental,
            ]),
          );
          expect(result.approvedCategories).toEqual([
            'baseline',
            'cardiac',
            'dental',
          ]);
          expect(result.expiresAt).toBe(APPROVED_UNTIL);
          expect(
            result.records
              .filter((record) => record.category === 'dental')
              .every(
                (record) =>
                  record.grant.id === 'grant-scope-1' &&
                  record.grant.version === 1,
              ),
          ).toBe(true);
        });

        it.each([
          ['before', T_NOW],
          ['after', APPROVED_UNTIL],
        ])('should add nothing %s the approved window', (_, iso) => {
          const result = evaluateAt(iso);

          expect(idsOf(result)).toEqual(
            sorted(manifest.scenarios.cardiology.visibleRecordIds),
          );
        });

        it('should never add unapproved or restricted categories', () => {
          const ids = idsOf(evaluateAt('2026-11-27T00:00:00.000Z'));

          for (const id of [
            ...manifest.groups.unrelated,
            ...manifest.groups.restricted,
          ]) {
            expect(ids).not.toContain(id);
          }
        });
      });

      it('should fail closed once the grant is revoked', () => {
        insertGrant(db, grantFor({ version: 2, revokedAt: T_NOW }));

        expect(evaluateAt(T_NOW)).toMatchObject({
          effect: 'deny',
          rationaleCode: 'grant-revoked',
        });
      });

      it('should fail closed once the grant has expired', () => {
        expect(evaluateAt(T_GRANT_END)).toMatchObject({
          effect: 'deny',
          rationaleCode: 'grant-expired',
        });
      });
    });

    describe('inclusive start boundaries', () => {
      it('should admit at the exact encounter start and grant validFrom instant', () => {
        const result = allowOf(evaluateAt(T_SEED));

        expect(idsOf(result)).toEqual(
          sorted(manifest.scenarios.cardiology.visibleRecordIds),
        );
      });

      it('should refuse one millisecond before the encounter starts', () => {
        expect(evaluateAt('2026-11-19T23:59:59.999Z')).toMatchObject({
          effect: 'deny',
          rationaleCode: 'encounter-not-found',
        });
      });

      it('should release from the exact validFrom of a later grant, not a millisecond before', () => {
        insertGrant(db, grantFor({ version: 2, validFrom: T_NOW }));

        expect(evaluateAt('2026-11-25T09:59:59.999Z')).toMatchObject({
          effect: 'deny',
          rationaleCode: 'grant-not-yet-valid',
        });
        expect(idsOf(evaluateAt(T_NOW))).toEqual(
          sorted(manifest.scenarios.cardiology.visibleRecordIds),
        );
      });
    });

    it('should read the clock bound at construction, never the system clock', () => {
      const clock = vi.fn(clockAt(T_NOW));
      const engine = new PolicyEngine({ db, clock, onInvalidGrant: vi.fn() });

      const result = engine.evaluate({
        principal: principalFor(CARDIOLOGIST),
        request: REQUEST,
      });

      expect(clock).toHaveBeenCalledOnce();
      expect(result.decidedAt).toBe(T_NOW);
    });

    it('should refuse an invalid clock reading before reading the vault', () => {
      const engine = new PolicyEngine({
        db,
        clock: () => new Date('not a date'),
        onInvalidGrant: vi.fn(),
      });
      const prepare = vi.spyOn(db, 'prepare');

      expect(() =>
        engine.evaluate({
          principal: principalFor(CARDIOLOGIST),
          request: REQUEST,
        }),
      ).toThrow(new RangeError('the policy clock returned an invalid date'));
      expect(prepare).not.toHaveBeenCalled();
    });

    describe('invalid grant rows', () => {
      it('should skip an invalid allow row with an id-only signal and keep evaluating the rest', () => {
        corruptGrant('grant-cardio', `categories = '["cardiac","cardiac"]'`);

        const cardio = evaluateAt(T_NOW);
        const dental = allowOf(evaluateAt(T_NOW, DENTIST, ENC_DENTAL));

        expect(cardio).toMatchObject({
          effect: 'deny',
          rationaleCode: 'no-grant',
        });
        expect(idsOf(dental)).toEqual(
          sorted(manifest.scenarios.dental.visibleRecordIds),
        );
        expect(test.signals).toEqual([
          { grantId: 'grant-cardio', version: 1 },
          { grantId: 'grant-cardio', version: 1 },
        ]);
        expect(db.isTransaction).toBe(false);
      });

      it('should fail closed with a content-free error when the invalid row may be a deny', () => {
        insertGrant(
          db,
          grantFor({
            id: 'grant-deny-cardio',
            effect: 'deny',
            categories: ['cardiac'],
            allowBaseline: false,
          }),
        );
        corruptGrant(
          'grant-deny-cardio',
          `categories = '["cardiac","cardiac"]'`,
        );

        expect(() => evaluateAt(T_NOW)).toThrow(new PolicyDataError('grants'));
        expect(test.signals).toEqual([]);
        expect(db.isTransaction).toBe(false);
      });
    });
  });

  describe('mt:recheck', () => {
    it('should deny a prior allow after revocation in the middle of a request (A07)', () => {
      const prior = allowOf(evaluateAt(T_NOW));

      insertGrant(
        db,
        grantFor({ version: 2, revokedAt: '2026-11-25T10:01:00.000Z' }),
      );

      const result = recheckAt(prior, '2026-11-25T10:02:00.000Z');

      expect(result).toEqual({
        effect: 'deny',
        rationaleCode: 'grant-revoked',
        policyVersion: POLICY_VERSION,
        decidedAt: '2026-11-25T10:02:00.000Z',
      });
    });

    it('should keep a prior allow while the grant stays in force', () => {
      const prior = allowOf(evaluateAt(T_NOW));

      const result = recheckAt(prior, '2026-11-25T10:02:00.000Z');

      expect(idsOf(result)).toEqual(idsOf(prior));
    });

    it('should re-read the registry and deny once the bound clinician is suspended', () => {
      const prior = allowOf(evaluateAt(T_NOW));

      db.prepare(
        `UPDATE clinicians SET status = 'suspended' WHERE subject = ?`,
      ).run(CARDIOLOGIST);

      expect(recheckAt(prior, '2026-11-25T10:02:00.000Z')).toMatchObject({
        effect: 'deny',
        rationaleCode: 'principal-not-registered',
      });
    });

    it('should deny a prior allow once the encounter is closed', () => {
      const prior = allowOf(evaluateAt(T_NOW));

      db.prepare(`UPDATE encounters SET status = 'closed' WHERE id = ?`).run(
        ENC_CARDIO,
      );

      const result = recheckAt(prior, '2026-11-25T10:02:00.000Z');

      expect(result).toMatchObject({
        effect: 'deny',
        rationaleCode: 'encounter-not-found',
      });
    });
  });
});

describe('fn:readClinician (ADR-9)', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = seedVault();
  });

  afterEach(() => {
    db.close();
  });

  it('reads an entry only while its issuer is an enabled institution', () => {
    const person = { issuer: ISSUER, subject: CARDIOLOGIST };

    expect(readClinician(db, person)).toMatchObject({
      roles: ['cardiologist'],
    });

    db.prepare('UPDATE trusted_issuers SET enabled = 0 WHERE issuer = ?').run(
      ISSUER,
    );

    expect(readClinician(db, person)).toBeUndefined();
  });

  it('never reads an entry under a patient-kind issuer', () => {
    db.prepare(
      `UPDATE trusted_issuers SET kind = 'patient', organization_id = NULL, organization_name = NULL,
         role_claim = NULL, allowed_roles = '[]' WHERE issuer = ?`,
    ).run(ISSUER);

    expect(
      readClinician(db, { issuer: ISSUER, subject: CARDIOLOGIST }),
    ).toBeUndefined();
  });
});
