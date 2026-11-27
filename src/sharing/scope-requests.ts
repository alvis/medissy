/**
 * expanded-scope requests (brief §8, A07); a clinician the owner already
 * confirmed may ask for more categories in an encounter that admits them;
 * the request is stored pending and releases nothing: only the owner's
 * approval on the step-up confirm page issues a grant; the reason is
 * untrusted text, stored for the owner to read and never used in policy
 */
import { z } from 'zod';

import {
  grantableCategorySchema,
  idSchema,
  LIMITS,
  timestampSchema,
} from '../contracts';

import {
  encountersAdmitting,
  hasConfirmedConnection,
  MAX_SCOPE_REQUEST_DAYS,
} from './queries';
import { audit, denied, immediate, log, newId, readVaultOwner } from './store';

import type { GrantableCategory, PersonRef } from '../contracts';

import type { SharingDenial, SharingDeps } from './types';

const MS_PER_DAY = 86_400_000;

/** what a clinician asks for */
export interface ExpansionInput {
  /** the verified requester (never from message text) */
  requester: PersonRef;
  encounterId: string;
  categories: GrantableCategory[];
  /** untrusted free text for the owner */
  reason: string;
  desiredExpiresAt: string;
  /** the requester's idempotency key */
  requestId: string;
}

/** a stored (or re-found) scope request */
export interface RequestedExpansion {
  ok: true;
  id: string;
  status: 'pending';
}

const expansionSchema = z.strictObject({
  encounterId: idSchema,
  categories: z
    .array(grantableCategorySchema)
    .min(1)
    .max(LIMITS.listSmall)
    .refine((list) => new Set(list).size === list.length),
  reason: z.string().max(LIMITS.paragraph),
  desiredExpiresAt: timestampSchema,
  requestId: idSchema,
});

/**
 * returns the canonical stored form of a request's categories
 * @param categories the requested categories
 * @returns sorted JSON
 */
function categoriesJson(categories: readonly string[]): string {
  return JSON.stringify([...categories].sort());
}

type ExpansionRequest = z.infer<typeof expansionSchema>;

/**
 * answers a repeated request id: the stored request when the content matches;
 * a conflict when it does not
 * @param deps the vault and clock
 * @param repeat the requester and the parsed request
 * @param repeat.requester the verified requester
 * @param repeat.request the parsed request
 * @param repeat.categories the requested categories as stored JSON
 * @param repeat.desired the desired expiry
 * @returns the stored request or a conflict, or undefined for a new request id
 */
function findRepeat(
  deps: SharingDeps,
  repeat: {
    requester: ExpansionInput['requester'];
    request: ExpansionRequest;
    categories: string;
    desired: Date;
  },
): RequestedExpansion | SharingDenial | undefined {
  const { requester, request, categories, desired } = repeat;
  const existing = deps.db
    .prepare(
      `SELECT id, encounter_id, requested_categories, reason, desired_expires_at, status FROM scope_requests
       WHERE requester_issuer = ? AND requester_subject = ? AND request_id = ?`,
    )
    .get(requester.issuer, requester.subject, request.requestId);

  if (!existing) {
    return undefined;
  }

  const same =
    existing.encounter_id === request.encounterId &&
    existing.requested_categories === categories &&
    existing.reason === request.reason &&
    existing.desired_expires_at === desired.toISOString() &&
    existing.status === 'pending';

  return same
    ? { ok: true, id: String(existing.id), status: 'pending' }
    : refuse(deps, 'conflict');
}

/**
 * inserts the pending request and its audit event in one transaction
 * @param deps the vault and clock
 * @param stored what to store
 * @param stored.id the new request id
 * @param stored.request the parsed request
 * @param stored.vault the vault patient and owner
 * @param stored.requester the verified requester
 * @param stored.categories the requested categories as stored JSON
 * @param stored.desired the desired expiry
 * @param stored.now the current time
 */
function storeRequest(
  deps: SharingDeps,
  stored: {
    id: string;
    request: ExpansionRequest;
    vault: NonNullable<ReturnType<typeof readVaultOwner>>;
    requester: ExpansionInput['requester'];
    categories: string;
    desired: Date;
    now: Date;
  },
): void {
  const { id, request, vault, requester, categories, desired, now } = stored;

  immediate(deps.db, () => {
    deps.db
      .prepare(
        `INSERT INTO scope_requests (id, request_id, patient_id, requester_issuer, requester_subject, encounter_id,
           requested_categories, reason, desired_expires_at, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        id,
        request.requestId,
        vault.patientId,
        requester.issuer,
        requester.subject,
        request.encounterId,
        categories,
        request.reason,
        desired.toISOString(),
        now.toISOString(),
      );
    audit(deps, {
      type: 'scope.requested',
      outcome: 'success',
      actorKind: 'clinician',
      actor: requester,
      patientId: vault.patientId,
      target: { type: 'scope-request', id },
      details: { categories: request.categories.length },
    });
  });
}

/**
 * stores a pending scope request for a confirmed requester; repeating the
 * same request id with the same content returns the stored request; reusing
 * it for a different request is a conflict; nothing is released
 * @param deps the vault and clock
 * @param input the verified requester and what they ask for
 * @returns the pending request, or a denial that changed nothing
 */
export function requestExpansion(
  deps: SharingDeps,
  input: ExpansionInput,
): RequestedExpansion | SharingDenial {
  const parsed = expansionSchema.safeParse({
    encounterId: input.encounterId,
    categories: input.categories,
    reason: input.reason,
    desiredExpiresAt: input.desiredExpiresAt,
    requestId: input.requestId,
  });
  const now = deps.clock();
  const vault = readVaultOwner(deps.db);

  if (!parsed.success || !vault) {
    return refuse(deps, 'invalid-input');
  }

  const request = parsed.data;
  const desired = new Date(request.desiredExpiresAt);

  if (
    desired.getTime() <= now.getTime() ||
    desired.getTime() > now.getTime() + MAX_SCOPE_REQUEST_DAYS * MS_PER_DAY
  ) {
    return refuse(deps, 'invalid-input');
  }

  const categories = categoriesJson(request.categories);
  const repeated = findRepeat(deps, {
    requester: input.requester,
    request,
    categories,
    desired,
  });

  if (repeated) {
    return repeated;
  }

  const admitted = encountersAdmitting(deps.db, input.requester, now).some(
    (encounter) => encounter.id === request.encounterId,
  );

  if (!hasConfirmedConnection(deps.db, input.requester) || !admitted) {
    return refuse(deps, 'not-permitted');
  }

  const id = newId(deps);

  storeRequest(deps, {
    id,
    request,
    vault,
    requester: input.requester,
    categories,
    desired,
    now,
  });
  log(deps, { event: 'scope.requested', outcome: 'success' });

  return { ok: true, id, status: 'pending' };
}

/**
 * logs and returns a refusal
 * @param deps the sharing deps
 * @param code why
 * @returns the denial
 */
function refuse(deps: SharingDeps, code: SharingDenial['code']): SharingDenial {
  log(deps, { event: 'scope.requested', outcome: 'denied' });

  return denied(code);
}
