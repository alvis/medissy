import { z } from 'zod';

import {
  grantableCategorySchema,
  idSchema,
  issuerSchema,
  organizationIdSchema,
  purposeSchema,
  roleSchema,
  sensitivitySchema,
  subjectSchema,
  timestampSchema,
  LIMITS,
  SENSITIVITY_RANK,
} from './common';

import type { Principal } from './principal';
import type { RecordEnvelope } from './record';

/**
 * who a grant authorises: a specific person, an organisation plus role(s), or
 * both; organisation trust alone is never enough (brief §5), so
 * `organizationId` and a non-empty `roles` list come together or not at all;
 * when more than one part is present, every present part must match (see
 * `granteeMatches`)
 */
export const granteeSchema = z
  .strictObject({
    issuer: issuerSchema,
    subject: subjectSchema.optional(),
    organizationId: organizationIdSchema.optional(),
    roles: z.array(roleSchema).max(LIMITS.listSmall).optional(),
  })
  .superRefine((grantee, context) => {
    const hasOrganization = grantee.organizationId !== undefined;
    const hasRoles = (grantee.roles?.length ?? 0) > 0;

    if (hasOrganization !== hasRoles) {
      context.addIssue({
        code: 'custom',
        path: ['roles'],
        message: 'organizationId and a non-empty roles list come together',
      });
    }

    if (grantee.subject === undefined && !hasOrganization) {
      context.addIssue({
        code: 'custom',
        path: ['subject'],
        message:
          'grantee needs a subject, or an organization with at least one role',
      });
    }
  });
export type Grantee = z.infer<typeof granteeSchema>;

/**
 * a patient grant; grants are immutable, versioned rows: every change,
 * including revocation, is a new row with `version + 1`; nothing is updated in
 * place; the effective grant is the highest version of an `id`
 *
 * `effect` has no default: every grant states `allow` or `deny` explicitly, so
 * an omitted field can never silently widen access
 *
 * ## The exact release predicate
 *
 * inputs: the verified `caller` (a `Principal` whose `organizationId` and
 * `roles` come from the clinician registry, written only by a verified
 * institution sign-in: roles from its allowlisted ID token claim, the
 * organisation from its issuer config, ADR-9), the
 * `encounter` row read from the database by the request's selector, `now`
 * from the server clock, the record, and the request's optional
 * `requestedCategories`; `isRecordReleasable` implements this and is the
 * reference the policy engine must match
 *
 * 1. caller; the registry entry for `(caller.issuer, caller.subject)` exists
 *    and has `status = 'active'` (a suspended clinician releases nothing)
 * 2. encounter (see `encounterAdmitsCaller`); the encounter exists for this
 *    patient, `status = 'active'`, `startsAt <= now < endsAt`, and it is
 *    linked to the caller: `encounter.clinician` equals `(issuer, subject)`,
 *    or `encounter.organizationId` equals `caller.organizationId`
 * 3. a grant is in force when it is the highest version of its `id`,
 *    `revokedAt` is unset, `validFrom <= now < expiresAt`, and its
 *    `encounterId` and `purpose` equal the encounter's
 * 4. the grantee matches (`granteeMatches`); `grantee.issuer` equals
 *    `caller.issuer`, and every part that is present must match: a `subject`
 *    matches by `(issuer, subject)`; an `organizationId` with `roles` matches
 *    when `organizationId` equals `caller.organizationId` AND at least one of
 *    `grantee.roles` is in `caller.roles`
 * 5. an in-force, matching `allow` grant covers a record only on the
 *    intersection of all of these:
 *    - category: `record.category` is in `categories`, or `record.category`
 *      is `baseline` and `allowBaseline` is true (`baseline` is never
 *      released through `categories`);
 *    - sensitivity: `SENSITIVITY_RANK[record.sensitivity] <=
 *      SENSITIVITY_RANK[maxSensitivity]`;
 *    - record ids: when `allowedRecordIds` is set, it lists `record.id`. This
 *      applies to every record including `baseline`: baseline records are
 *      released only if `allowBaseline` is true AND (`allowedRecordIds` is
 *      unset OR lists the id)
 * 6. an in-force, matching `deny` grant covers every record whose category is
 *    in `categories`, whatever the record's sensitivity: a deny blocks the
 *    whole category and its `maxSensitivity` is not consulted; a deny grant
 *    carries no `allowBaseline` or `allowedRecordIds`, and `baseline` cannot
 *    be denied by a grant (revoke the allow instead)
 * 7. request narrowing; `requestedCategories` omitted means no narrowing;
 *    when present it is a non-empty list of `RECORD_CATEGORIES`; the record's
 *    category must be in it, and `baseline` is included only when `baseline`
 *    is listed explicitly; it narrows, never widens, and a requested category
 *    no grant covers is not an error: the result is simply the intersection
 * 8. deny-overrides; the record is released only if steps 1 and 2 hold, some
 *    allow grant covers it (5), no deny grant covers it (6), and 7 holds;
 *    anything else, including every error, releases nothing
 *
 * field-level allowlists are not part of this predicate; the policy layer
 * applies them after record selection
 */
export const grantSchema = z
  .strictObject({
    id: idSchema,
    patientId: idSchema,
    version: z.number().int().min(1),
    effect: z.enum(['allow', 'deny']),
    grantee: granteeSchema,
    encounterId: idSchema,
    purpose: purposeSchema,
    categories: z.array(grantableCategorySchema).max(LIMITS.listSmall),
    maxSensitivity: sensitivitySchema,
    allowBaseline: z.boolean(),
    allowedRecordIds: z.array(idSchema).min(1).max(LIMITS.listLarge).optional(),
    validFrom: timestampSchema,
    expiresAt: timestampSchema,
    revokedAt: timestampSchema.optional(),
  })
  .superRefine((grant, context) => {
    if (Date.parse(grant.validFrom) >= Date.parse(grant.expiresAt)) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'expiresAt must be after validFrom',
      });
    }

    if (new Set(grant.categories).size !== grant.categories.length) {
      context.addIssue({
        code: 'custom',
        path: ['categories'],
        message: 'categories must be unique',
      });
    }

    if (grant.effect === 'allow') {
      if (grant.categories.length === 0 && !grant.allowBaseline) {
        context.addIssue({
          code: 'custom',
          path: ['categories'],
          message:
            'an allow grant must cover baseline or at least one category',
        });
      }

      return;
    }

    if (grant.categories.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['categories'],
        message: 'a deny grant must name at least one category',
      });
    }

    if (grant.allowBaseline || grant.allowedRecordIds !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['effect'],
        message: 'a deny grant cannot set allowBaseline or allowedRecordIds',
      });
    }
  });
export type Grant = z.infer<typeof grantSchema>;

/** the caller fields a grant is matched against */
export type GrantCaller = Pick<
  Principal,
  'issuer' | 'subject' | 'organizationId' | 'roles'
>;

/** the record fields a grant is evaluated against */
export type GrantRecord = Pick<
  RecordEnvelope,
  'id' | 'category' | 'sensitivity'
>;

/**
 * checks whether a grantee names this caller: same issuer, and every present part
 * matches; a subject matches by `(issuer, subject)`; an organization with
 * roles matches when the organization is equal AND at least one role is held
 * @param grantee the grant's grantee
 * @param caller the verified caller with registry organization and roles
 * @returns true when the grantee authorises this caller
 */
export function granteeMatches(grantee: Grantee, caller: GrantCaller): boolean {
  if (grantee.issuer !== caller.issuer) {
    return false;
  }

  if (grantee.subject !== undefined && grantee.subject !== caller.subject) {
    return false;
  }

  if (grantee.organizationId !== undefined) {
    const held = new Set(caller.roles);

    return (
      grantee.organizationId === caller.organizationId &&
      (grantee.roles ?? []).some((role) => held.has(role))
    );
  }

  return grantee.subject !== undefined;
}

/**
 * checks whether an effective grant version is live: not revoked and inside its
 * validity window (`validFrom <= now < expiresAt`); the caller must pass the
 * highest version of the grant id
 * @param grant the effective (highest) version of a grant
 * @param now the server clock
 * @returns true when the grant is in force at `now`
 */
export function isGrantInForce(grant: Grant, now: Date): boolean {
  const at = now.getTime();

  return (
    grant.revokedAt === undefined &&
    Date.parse(grant.validFrom) <= at &&
    at < Date.parse(grant.expiresAt)
  );
}

/**
 * checks whether one grant covers one record, ignoring who is asking and when: the
 * intersection of category (or baseline via `allowBaseline`), sensitivity and
 * optional record ids for an allow grant; the category alone for a deny
 * grant, which blocks every sensitivity in it
 * @param grant the grant to test
 * @param record the record's id, category and sensitivity
 * @returns true when the grant's rules cover the record
 */
export function grantCoversRecord(grant: Grant, record: GrantRecord): boolean {
  if (grant.effect === 'deny') {
    return (
      record.category !== 'baseline' &&
      grant.categories.some((category) => category === record.category)
    );
  }

  const withinSensitivity =
    SENSITIVITY_RANK[record.sensitivity] <=
    SENSITIVITY_RANK[grant.maxSensitivity];

  const inCategory =
    record.category === 'baseline'
      ? grant.allowBaseline
      : grant.categories.some((category) => category === record.category);
  const idListed =
    grant.allowedRecordIds === undefined ||
    grant.allowedRecordIds.includes(record.id);

  return inCategory && withinSensitivity && idListed;
}

/** what `isRecordReleasable` needs to decide one record */
export interface ReleaseInput {
  /** the effective (highest-version) grants of the patient */
  grants: readonly Grant[];
  caller: GrantCaller;
  /** the encounter as read from the database, after `encounterAdmitsCaller` */
  encounter: { id: string; purpose: string };
  now: Date;
  record: GrantRecord;
  requestedCategories?: readonly string[];
}

/**
 * applies steps 3 to 8 of the release predicate to one record; the caller and
 * encounter checks (steps 1 and 2) are separate; a caller that fails them
 * releases nothing regardless of grants
 * @param input grants, caller, encounter, clock, record and request narrowing
 * @returns true only when an allow grant covers the record, no deny grant
 * does, and the request does not exclude its category
 */
export function isRecordReleasable(input: ReleaseInput): boolean {
  const { grants, caller, encounter, now, record, requestedCategories } = input;

  if (
    requestedCategories !== undefined &&
    !requestedCategories.includes(record.category)
  ) {
    return false;
  }

  const applicable = grants.filter(
    (grant) =>
      grant.encounterId === encounter.id &&
      grant.purpose === encounter.purpose &&
      isGrantInForce(grant, now) &&
      granteeMatches(grant.grantee, caller) &&
      grantCoversRecord(grant, record),
  );

  return (
    applicable.some((grant) => grant.effect === 'allow') &&
    !applicable.some((grant) => grant.effect === 'deny')
  );
}
