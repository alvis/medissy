/**
 * what the owner's decisions share: the refusal that rolls a transaction back,
 * the decision wrapper, the owner check, grant insertion and the audit of a
 * new grant version; `decisions.ts` holds the decisions themselves
 */
import { z } from 'zod';

import {
  grantableCategorySchema,
  grantSchema,
  LIMITS,
  sensitivitySchema,
  timestampSchema,
} from '../contracts';

import { encountersAdmitting } from './queries';
import {
  audit,
  denied,
  immediate,
  isOwner,
  log,
  newId,
  readVaultOwner,
} from './store';

import type { Grant, PersonRef } from '../contracts';

import type { VaultOwner } from './store';
import type {
  EncounterChoice,
  GrantChoice,
  SharingDenial,
  SharingDeps,
  SharingLogEntry,
} from './types';

export const MS_PER_DAY = 86_400_000;
/** the longest grant or new encounter the owner can issue at once */
export const MAX_GRANT_DAYS = 90;
const ENCOUNTER_REASON_MAX = 500;

/** a decision that issued a grant */
export interface IssuedGrant {
  ok: true;
  grantId: string;
  encounterId: string;
}

/** a decision that changed state without issuing a grant */
export interface Decided {
  ok: true;
}

const categoriesSchema = z
  .array(grantableCategorySchema)
  .max(LIMITS.listSmall)
  .refine((list) => new Set(list).size === list.length);

const encounterChoiceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('existing'), id: z.string().min(1) }),
  z.strictObject({
    kind: z.literal('new'),
    reason: z.string().max(ENCOUNTER_REASON_MAX).optional(),
    endsAt: timestampSchema,
  }),
]);

export const grantChoiceSchema = z.strictObject({
  encounter: encounterChoiceSchema,
  categories: categoriesSchema,
  allowBaseline: z.boolean(),
  maxSensitivity: sensitivitySchema,
  expiresAt: timestampSchema,
});

/** what the owner chose when approving a scope request */
export interface ScopeApproval {
  /** a non-empty subset of the requested categories */
  categories: GrantChoice['categories'];
  maxSensitivity: GrantChoice['maxSensitivity'];
  /** no later than the requester's desired expiry */
  expiresAt: string;
}

export const scopeApprovalSchema = z.strictObject({
  categories: categoriesSchema.min(1),
  maxSensitivity: sensitivitySchema,
  expiresAt: timestampSchema,
});

/** error thrown inside a transaction to roll it back with a denial */
export class Refusal extends Error {
  /** @param code the denial code */
  constructor(public readonly code: SharingDenial['code']) {
    super(code);
    this.name = 'Refusal';
  }
}

/**
 * runs a decision in one transaction; a `Refusal` rolls back and becomes a
 * denial, anything else propagates
 * @param deps the sharing deps
 * @param event the log event
 * @param work the transaction body
 * @returns the decision result or a denial
 */
export function decide<T extends { ok: true }>(
  deps: SharingDeps,
  event: SharingLogEntry['event'],
  work: () => T,
): T | SharingDenial {
  try {
    const result = immediate(deps.db, work);

    log(deps, { event, outcome: 'success' });

    return result;
  } catch (error) {
    if (!(error instanceof Refusal)) {
      throw error;
    }

    log(deps, { event, outcome: 'denied' });

    return denied(error.code);
  }
}

/**
 * returns the vault, provided the person is its owner
 * @param deps the sharing deps
 * @param owner the verified person acting
 * @returns the vault owner
 * @throws {Refusal} for anyone but the owner
 */
export function requireOwner(deps: SharingDeps, owner: PersonRef): VaultOwner {
  const vault = readVaultOwner(deps.db);

  if (!vault || !isOwner(vault, owner)) {
    throw new Refusal('not-permitted');
  }

  return vault;
}

/**
 * checks whether an instant lies after now and within the owner's horizon
 * @param iso the instant
 * @param now the server clock
 * @returns true when acceptable
 */
export function withinHorizon(iso: string, now: Date): boolean {
  const at = Date.parse(iso);

  return (
    at > now.getTime() && at <= now.getTime() + MAX_GRANT_DAYS * MS_PER_DAY
  );
}

/**
 * resolves the encounter of a confirmation: an existing one that admits the
 * requester now, or a new one the owner creates for exactly that requester
 * @param deps the sharing deps
 * @param params the vault, the owner, the requester and the choice
 * @param params.vault the vault owner
 * @param params.requester the verified requester
 * @param params.choice the owner's encounter choice
 * @returns the encounter id
 * @throws {Refusal} when the choice does not admit the requester
 */
export function resolveEncounter(
  deps: SharingDeps,
  params: { vault: VaultOwner; requester: PersonRef; choice: EncounterChoice },
): string {
  const { vault, requester, choice } = params;
  const now = deps.clock();

  if (choice.kind === 'existing') {
    const admits = encountersAdmitting(deps.db, requester, now).some(
      (encounter) => encounter.id === choice.id,
    );

    if (!admits) {
      throw new Refusal('invalid-input');
    }

    return choice.id;
  }

  if (!withinHorizon(choice.endsAt, now)) {
    throw new Refusal('invalid-input');
  }

  const id = newId(deps);

  deps.db
    .prepare(
      `INSERT INTO encounters (id, patient_id, purpose, reason, clinician_issuer, clinician_subject, starts_at, ends_at,
         status, created_by_issuer, created_by_subject, created_at)
       VALUES (?, ?, 'direct-treatment', ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    )
    .run(
      id,
      vault.patientId,
      choice.reason?.trim() ? choice.reason.trim() : null,
      requester.issuer,
      requester.subject,
      now.toISOString(),
      new Date(choice.endsAt).toISOString(),
      vault.owner.issuer,
      vault.owner.subject,
      now.toISOString(),
    );

  return id;
}

/**
 * validates and inserts version 1 of a new allow grant
 * @param deps the sharing deps
 * @param params the grant and who issued it on what basis
 * @param params.grant the grant to insert
 * @param params.owner the owner issuing it
 * @param params.scopeRequestId the scope request it answers, if any
 */
export function insertGrant(
  deps: SharingDeps,
  params: { grant: Grant; owner: PersonRef; scopeRequestId?: string },
): void {
  const grant = grantSchema.parse(params.grant);

  deps.db
    .prepare(
      `INSERT INTO grants (id, version, patient_id, effect, grantee_issuer, grantee_subject, grantee_organization_id,
         grantee_roles, encounter_id, purpose, categories, max_sensitivity, allow_baseline, allowed_record_ids,
         valid_from, expires_at, revoked_at, source, scope_request_id, created_by_issuer, created_by_subject, created_at)
       VALUES (?, 1, ?, 'allow', ?, ?, NULL, '[]', ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    )
    .run(
      grant.id,
      grant.patientId,
      grant.grantee.issuer,
      grant.grantee.subject ?? null,
      grant.encounterId,
      grant.purpose,
      JSON.stringify(grant.categories),
      grant.maxSensitivity,
      grant.allowBaseline ? 1 : 0,
      grant.validFrom,
      grant.expiresAt,
      params.scopeRequestId ? 'scope-request' : 'owner',
      params.scopeRequestId ?? null,
      params.owner.issuer,
      params.owner.subject,
      deps.clock().toISOString(),
    );
}

/**
 * moves a pending connection or scope request to its decided state
 * @param deps the sharing deps
 * @param change the table, row, new state and (for approval) grant id
 * @param change.table connections or scope_requests
 * @param change.id the row id
 * @param change.status the decided state
 * @param change.grantId the grant an approval issued
 * @throws {Refusal} when the row is missing or no longer pending
 */
export function settle(
  deps: SharingDeps,
  change: {
    table: 'connections' | 'scope_requests';
    id: string;
    status: string;
    grantId?: string;
  },
): void {
  const now = deps.clock().toISOString();
  const result =
    change.table === 'connections'
      ? deps.db
          .prepare(
            `UPDATE connections SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'`,
          )
          .run(change.status, now, change.id)
      : deps.db
          .prepare(
            `UPDATE scope_requests SET status = ?, decided_at = ?, grant_id = ? WHERE id = ? AND status = 'pending'`,
          )
          .run(change.status, now, change.grantId ?? null, change.id);

  if (result.changes !== 1) {
    throw new Refusal('not-pending');
  }
}

/**
 * audits a new grant version
 * @param deps the sharing deps
 * @param params the vault, the owner and the grant version
 * @param params.vault the vault owner
 * @param params.owner the owner who issued it
 * @param params.grantId the id of the grant that changed
 * @param params.version the version written
 */
export function auditGrant(
  deps: SharingDeps,
  params: {
    vault: VaultOwner;
    owner: PersonRef;
    grantId: string;
    version: number;
  },
): void {
  audit(deps, {
    type: 'grant.created',
    outcome: 'success',
    actorKind: 'owner',
    actor: params.owner,
    patientId: params.vault.patientId,
    target: { type: 'grant', id: params.grantId },
    details: { version: params.version },
  });
}
