import { describe, expect, it } from 'vitest';

import {
  POLICY_VERSION,
  decide,
  recheckDecision,
} from '../../src/policy/decide';

import {
  CANARY,
  CARDIOLOGIST,
  DENTIST,
  ENC_CARDIO,
  ISSUER,
  NORTHGATE,
  PATIENT,
  T_ENCOUNTER_END,
  T_GRANT_END,
  T_NOW,
  clinicianFor,
  encounterFor,
  fixtureLabels,
  grantFor,
  manifest,
  personFor,
  principalFor,
} from './support';

import type {
  PolicyAllow,
  PolicyInput,
  RecheckInput,
  RecordLabel,
} from '../../src/policy/decide';

const NOW = new Date(T_NOW);
const restricted = new Set(manifest.groups.restricted);
const cardiology = manifest.scenarios.cardiology.visibleRecordIds;

/**
 * builds a decision input for the cardiologist with a cardiac grant
 * @param overrides fields to replace
 * @returns a complete decision input
 */
function inputFor(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    principal: principalFor(CARDIOLOGIST),
    clinician: clinicianFor(CARDIOLOGIST),
    request: { encounterId: ENC_CARDIO, purpose: 'direct-treatment' },
    encounter: encounterFor(),
    patientId: PATIENT,
    grants: [grantFor()],
    records: fixtureLabels,
    now: NOW,
    ...overrides,
  };
}

/**
 * builds re-check state for the cardiologist: the decision input with the bound
 * person in place of the token and no request
 * @param overrides fields to replace, as for `inputFor`
 * @returns the re-check input
 */
function recheckStateFor(overrides: Partial<PolicyInput> = {}): RecheckInput {
  const { principal, request: _, ...state } = inputFor(overrides);

  return { ...state, caller: personFor(principal.subject) };
}

/**
 * lists the record ids an allow releases
 * @param input the decision input
 * @returns the released ids, or undefined for a deny
 */
function releasedIds(input: PolicyInput): string[] | undefined {
  const decision = decide(input);

  return decision.effect === 'allow'
    ? decision.records.map((record) => record.recordId)
    : undefined;
}

/**
 * decides and requires an allow
 * @param input the decision input
 * @returns the allow decision
 */
function allowOf(input: PolicyInput): PolicyAllow {
  const decision = decide(input);

  if (decision.effect !== 'allow') {
    throw new Error(`expected allow, got ${decision.rationaleCode}`);
  }

  return decision;
}

describe('fn:decide', () => {
  describe('allow', () => {
    it('should release exactly the cardiology scenario with grant version per record', () => {
      const expected: PolicyAllow = {
        effect: 'allow',
        rationaleCode: 'granted',
        policyVersion: POLICY_VERSION,
        decidedAt: T_NOW,
        patientId: PATIENT,
        encounterId: ENC_CARDIO,
        purpose: 'direct-treatment',
        caller: {
          issuer: ISSUER,
          subject: CARDIOLOGIST,
          organizationId: NORTHGATE,
          roles: ['cardiologist'],
        },
        approvedCategories: ['baseline', 'cardiac'],
        records: cardiology.map((recordId) => ({
          recordId,
          category: manifest.groups.baseline.includes(recordId)
            ? 'baseline'
            : 'cardiac',
          grant: { id: 'grant-cardio', version: 1 },
        })),
        expiresAt: T_GRANT_END,
      };

      const result = decide(inputFor());

      expect(result).toEqual(expected);
    });

    it('should bound expiry by the encounter when it ends before the grant', () => {
      const result = allowOf(
        inputFor({
          grants: [grantFor({ expiresAt: '2027-01-01T00:00:00.000Z' })],
        }),
      );

      expect(result.expiresAt).toBe(T_ENCOUNTER_END);
    });

    it('should narrow to requested categories and include baseline only when listed', () => {
      const result = releasedIds(
        inputFor({
          request: {
            encounterId: ENC_CARDIO,
            purpose: 'direct-treatment',
            requestedCategories: ['cardiac'],
          },
        }),
      );

      expect(result).toEqual(manifest.groups.cardiac);
    });

    it('should release only listed ids when the grant sets allowedRecordIds', () => {
      const result = releasedIds(
        inputFor({
          grants: [
            grantFor({ allowedRecordIds: ['rec-obs-001', 'rec-pat-001'] }),
          ],
        }),
      );

      expect(result).toEqual(['rec-pat-001', 'rec-obs-001']);
    });

    it('should skip records that are not current', () => {
      const records = fixtureLabels.map((label) =>
        label.id === 'rec-obs-001'
          ? { ...label, status: 'entered-in-error' as const }
          : label,
      );

      const result = releasedIds(inputFor({ records }));

      expect(result).toEqual(cardiology.filter((id) => id !== 'rec-obs-001'));
    });

    it('should admit from the exact encounter start and grant validFrom instants', () => {
      const result = releasedIds(
        inputFor({
          encounter: encounterFor({ startsAt: T_NOW }),
          grants: [grantFor({ validFrom: T_NOW })],
        }),
      );

      expect(result).toEqual(cardiology);
    });

    it('should refuse one millisecond before the encounter starts', () => {
      const result = decide(
        inputFor({
          encounter: encounterFor({ startsAt: '2026-11-25T10:00:00.001Z' }),
        }),
      );

      expect(result).toMatchObject({ rationaleCode: 'encounter-not-found' });
    });

    it('should credit the lowest-id allow when two allows cover a record, then switch once it is revoked', () => {
      const second = grantFor({ id: 'grant-cardio-second' });
      const both = allowOf(inputFor({ grants: [second, grantFor()] }));
      const afterRevoke = allowOf(
        inputFor({
          grants: [
            grantFor(),
            grantFor({ version: 2, revokedAt: T_NOW }),
            second,
          ],
        }),
      );

      expect(both.records.map((record) => record.recordId)).toEqual(cardiology);
      expect(both.records.map((record) => record.grant)).toEqual(
        cardiology.map(() => ({ id: 'grant-cardio', version: 1 })),
      );
      expect(afterRevoke.records.map((record) => record.recordId)).toEqual(
        cardiology,
      );
      expect(afterRevoke.records.map((record) => record.grant)).toEqual(
        cardiology.map(() => ({ id: 'grant-cardio-second', version: 1 })),
      );
    });

    it.each([
      ['expired', { expiresAt: T_NOW }],
      ['revoked', { revokedAt: '2026-11-25T09:00:00.000Z' }],
      ['not yet valid', { validFrom: '2026-11-25T10:00:00.001Z' }],
    ])('should ignore an %s deny next to a live allow', (_, window) => {
      const deny = grantFor({
        id: 'grant-deny-cardiac',
        effect: 'deny',
        allowBaseline: false,
        ...window,
      });

      const result = releasedIds(inputFor({ grants: [grantFor(), deny] }));

      expect(result).toEqual(cardiology);
    });

    it('should let a deny grant override the allow for its category', () => {
      const denyCardiac = grantFor({
        id: 'grant-deny-cardiac',
        effect: 'deny',
        allowBaseline: false,
        maxSensitivity: 'restricted',
      });

      const result = releasedIds(
        inputFor({ grants: [grantFor(), denyCardiac] }),
      );

      expect(result).toEqual(manifest.groups.baseline);
    });

    it('should let a routine deny block a restricted record a restricted allow covers', () => {
      const restrictedCardiac: RecordLabel = {
        id: 'rec-obs-960',
        category: 'cardiac',
        resourceType: 'Observation',
        sensitivity: 'restricted',
        status: 'current',
      };
      const records = [...fixtureLabels, restrictedCardiac];
      const restrictedAllow = grantFor({ maxSensitivity: 'restricted' });
      const routineDeny = grantFor({
        id: 'grant-deny-routine',
        effect: 'deny',
        allowBaseline: false,
        maxSensitivity: 'routine',
      });

      const allowed = releasedIds(
        inputFor({ records, grants: [restrictedAllow] }),
      );
      const denied = releasedIds(
        inputFor({ records, grants: [restrictedAllow, routineDeny] }),
      );

      expect(allowed).toEqual([...cardiology, 'rec-obs-960']);
      expect(denied).toEqual(manifest.groups.baseline);
    });

    it('should match an organization grant through registry organization and roles', () => {
      const orgGrant = grantFor({
        grantee: {
          issuer: ISSUER,
          organizationId: NORTHGATE,
          roles: ['cardiologist'],
        },
      });

      const result = releasedIds(inputFor({ grants: [orgGrant] }));

      expect(result).toEqual(cardiology);
    });
  });

  describe('deny', () => {
    it('should deny an unknown verified clinician (A02)', () => {
      const result = decide(inputFor({ clinician: undefined }));

      expect(result).toEqual({
        effect: 'deny',
        rationaleCode: 'principal-not-registered',
        policyVersion: POLICY_VERSION,
        decidedAt: T_NOW,
      });
    });

    it('should deny a suspended clinician', () => {
      const result = decide(
        inputFor({
          clinician: clinicianFor(CARDIOLOGIST, { status: 'suspended' }),
        }),
      );

      expect(result).toMatchObject({
        rationaleCode: 'principal-not-registered',
      });
    });

    it('should deny an entry whose institution no longer names a clinical role (ADR-9)', () => {
      const result = decide(
        inputFor({
          clinician: clinicianFor(CARDIOLOGIST, {
            roles: [],
            organizationId: undefined,
          }),
        }),
      );

      expect(result).toMatchObject({
        rationaleCode: 'principal-not-registered',
      });
    });

    it('should deny when the registry entry belongs to someone else', () => {
      const result = decide(inputFor({ clinician: clinicianFor(DENTIST) }));

      expect(result).toMatchObject({
        rationaleCode: 'principal-not-registered',
      });
    });

    it('should deny a principal without the request scope', () => {
      const result = decide(
        inputFor({
          principal: principalFor(CARDIOLOGIST, { scopes: ['medissy:owner'] }),
        }),
      );

      expect(result).toMatchObject({ rationaleCode: 'insufficient-scope' });
    });

    it('should ignore organization and role claims in the token', () => {
      const orgGrant = grantFor({
        grantee: {
          issuer: ISSUER,
          organizationId: NORTHGATE,
          roles: ['cardiologist'],
        },
      });
      const claimsDoctor = principalFor('clin-other', {
        organizationId: NORTHGATE,
        roles: ['cardiologist'],
      });

      const result = decide(
        inputFor({
          principal: claimsDoctor,
          clinician: clinicianFor('clin-other', {
            organizationId: 'org-elsewhere',
            roles: ['receptionist'],
          }),
          encounter: encounterFor({
            clinician: { issuer: ISSUER, subject: 'clin-other' },
          }),
          grants: [orgGrant],
        }),
      );

      expect(result).toMatchObject({
        effect: 'deny',
        rationaleCode: 'no-grant',
      });
    });

    it('should give a guessed encounter the same deny as an unknown one (A05)', () => {
      const unknown = decide(inputFor({ encounter: undefined }));
      const othersEncounter = decide(
        inputFor({
          encounter: encounterFor({
            clinician: { issuer: ISSUER, subject: DENTIST },
          }),
        }),
      );

      expect(unknown).toMatchObject({ rationaleCode: 'encounter-not-found' });
      expect(othersEncounter).toEqual(unknown);
    });

    it('should deny an encounter that is not the one the selector names', () => {
      const result = decide(
        inputFor({ encounter: encounterFor({ id: 'enc-other' }) }),
      );

      expect(result).toMatchObject({ rationaleCode: 'encounter-not-found' });
    });

    it('should deny another patient encounter', () => {
      const result = decide(
        inputFor({ encounter: encounterFor({ patientId: 'other-patient' }) }),
      );

      expect(result).toMatchObject({ rationaleCode: 'encounter-not-found' });
    });

    it.each([
      ['planned', { status: 'planned' as const }],
      ['closed', { status: 'closed' as const }],
      ['ended', { endsAt: T_NOW }],
    ])('should deny a %s encounter', (_, overrides) => {
      const result = decide(inputFor({ encounter: encounterFor(overrides) }));

      expect(result).toMatchObject({ rationaleCode: 'encounter-not-found' });
    });

    it('should deny a registered clinician with no grant (unauthorizedClinician)', () => {
      const result = decide(inputFor({ grants: [] }));

      expect(result).toMatchObject({
        effect: 'deny',
        rationaleCode: 'no-grant',
      });
      expect(manifest.scenarios.unauthorizedClinician.visibleRecordIds).toEqual(
        [],
      );
    });

    it('should ignore grants of another patient, encounter or grantee', () => {
      const result = decide(
        inputFor({
          grants: [
            grantFor({ patientId: 'other-patient' }),
            grantFor({ id: 'g-2', encounterId: 'enc-other' }),
            grantFor({
              id: 'g-3',
              grantee: { issuer: ISSUER, subject: DENTIST },
            }),
          ],
        }),
      );

      expect(result).toMatchObject({ rationaleCode: 'no-grant' });
    });

    it('should use only the highest grant version, so revocation is not outlived', () => {
      const v1 = grantFor();
      const v2 = grantFor({ version: 2, revokedAt: T_NOW });

      const result = decide(inputFor({ grants: [v2, v1] }));

      expect(result).toMatchObject({ rationaleCode: 'grant-revoked' });
    });

    it.each([
      ['grant-expired', { expiresAt: T_NOW }],
      ['grant-not-yet-valid', { validFrom: '2026-11-26T00:00:00.000Z' }],
      ['grant-revoked', { revokedAt: '2026-11-25T09:00:00.000Z' }],
    ])('should deny with %s', (rationaleCode, overrides) => {
      const result = decide(inputFor({ grants: [grantFor(overrides)] }));

      expect(result).toMatchObject({ effect: 'deny', rationaleCode });
    });

    it('should deny with category-not-permitted when the request excludes every granted category', () => {
      const result = decide(
        inputFor({
          request: {
            encounterId: ENC_CARDIO,
            purpose: 'direct-treatment',
            requestedCategories: ['mental-health'],
          },
        }),
      );

      expect(result).toMatchObject({ rationaleCode: 'category-not-permitted' });
    });

    it('should fail closed on a restricted-category grant, which has no field allowlist', () => {
      const result = decide(
        inputFor({
          grants: [
            grantFor({
              categories: ['mental-health', 'substance-use'],
              maxSensitivity: 'restricted',
              allowBaseline: false,
            }),
          ],
        }),
      );

      expect(result).toMatchObject({ rationaleCode: 'category-not-permitted' });
    });

    it('should report a deny grant when it removes everything an allow covers', () => {
      const result = decide(
        inputFor({
          grants: [
            grantFor({ allowBaseline: false }),
            grantFor({
              id: 'grant-deny-cardiac',
              effect: 'deny',
              allowBaseline: false,
            }),
          ],
        }),
      );

      expect(result).toMatchObject({ rationaleCode: 'denied-by-deny-grant' });
    });
  });

  describe('restricted records (A06)', () => {
    const withoutRestricted = fixtureLabels.filter(
      (label) => !restricted.has(label.id),
    );

    it.each([
      ['a cardiac allow', {}],
      [
        'a grant over every category',
        {
          grants: [
            grantFor({
              categories: [
                'cardiac',
                'dental',
                'musculoskeletal',
                'dermatology',
                'mental-health',
                'substance-use',
              ],
              maxSensitivity: 'restricted' as const,
            }),
          ],
        },
      ],
      [
        'a request for a restricted category',
        {
          request: {
            encounterId: ENC_CARDIO,
            purpose: 'direct-treatment' as const,
            requestedCategories: ['mental-health' as const],
          },
        },
      ],
      ['no grant', { grants: [] }],
    ])(
      'should decide %s identically whether restricted records exist or not',
      (_, overrides) => {
        const withRestricted = decide(inputFor(overrides));
        const without = decide(
          inputFor({ ...overrides, records: withoutRestricted }),
        );

        expect(withRestricted).toEqual(without);
        expect(JSON.stringify(withRestricted)).not.toContain(CANARY);

        for (const id of restricted) {
          expect(JSON.stringify(withRestricted)).not.toContain(id);
        }
      },
    );

    it('should carry nothing but the rationale on a deny', () => {
      const result = decide(inputFor({ grants: [] }));

      expect(Object.keys(result).sort()).toEqual([
        'decidedAt',
        'effect',
        'policyVersion',
        'rationaleCode',
      ]);
    });
  });
});

describe('fn:recheckDecision', () => {
  const prior = allowOf(inputFor());
  const later = new Date('2026-11-25T10:05:00.000Z');

  it('should keep the prior release when nothing changed', () => {
    const state = recheckStateFor({ now: later });

    const result = recheckDecision(prior, state);

    expect(result).toEqual({ ...prior, decidedAt: later.toISOString() });
  });

  it('should deny after revocation mid-request (A07)', () => {
    const state = recheckStateFor({
      now: later,
      grants: [grantFor({ version: 2, revokedAt: later.toISOString() })],
    });

    const result = recheckDecision(prior, state);

    expect(result).toMatchObject({
      effect: 'deny',
      rationaleCode: 'grant-revoked',
    });
  });

  it('should deny once the grant has expired (A07)', () => {
    const state = recheckStateFor({ now: new Date(T_GRANT_END) });

    const result = recheckDecision(prior, state);

    expect(result).toMatchObject({
      effect: 'deny',
      rationaleCode: 'grant-expired',
    });
  });

  it('should never widen: a newly approved category is not added to a prior release', () => {
    const state = recheckStateFor({
      now: later,
      grants: [
        grantFor(),
        grantFor({ id: 'grant-dental', categories: ['dental'] }),
      ],
    });

    const result = recheckDecision(prior, state);

    expect(result).toEqual({ ...prior, decidedAt: later.toISOString() });
  });

  it('should narrow to the current grant version when the owner narrows the grant', () => {
    const state = recheckStateFor({
      now: later,
      grants: [grantFor({ version: 2, categories: [], allowBaseline: true })],
    });

    const result = recheckDecision(prior, state);

    expect(result).toMatchObject({
      effect: 'allow',
      approvedCategories: ['baseline'],
      records: manifest.groups.baseline.map((recordId) => ({
        recordId,
        category: 'baseline',
        grant: { id: 'grant-cardio', version: 2 },
      })),
    });
  });

  it('should switch the credited grant when the credited allow is revoked mid-request', () => {
    const second = grantFor({ id: 'grant-cardio-second' });
    const credited = allowOf(inputFor({ grants: [grantFor(), second] }));
    const state = recheckStateFor({
      now: later,
      grants: [
        grantFor({ version: 2, revokedAt: later.toISOString() }),
        second,
      ],
    });

    const result = recheckDecision(credited, state);

    expect(result).toMatchObject({
      effect: 'allow',
      records: cardiology.map((recordId) =>
        expect.objectContaining({
          recordId,
          grant: { id: 'grant-cardio-second', version: 1 },
        }),
      ),
    });
  });

  it('should deny when a different person relies on the decision', () => {
    const state = recheckStateFor({
      now: later,
      principal: principalFor(DENTIST),
      clinician: clinicianFor(DENTIST),
    });

    const result = recheckDecision(prior, state);

    expect(result).toMatchObject({
      effect: 'deny',
      rationaleCode: 'principal-not-registered',
    });
  });

  it('should deny when the clinician was suspended since the decision', () => {
    const state = recheckStateFor({
      now: later,
      clinician: clinicianFor(CARDIOLOGIST, { status: 'suspended' }),
    });

    const result = recheckDecision(prior, state);

    expect(result).toMatchObject({ rationaleCode: 'principal-not-registered' });
  });
});
