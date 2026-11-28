/**
 * the owner's decisions (decision D3); confirming a connection and approving
 * a scope request are the only operations that create grants, and only the
 * step-up confirm page's POST calls them; each runs in one transaction,
 * re-checks the owner and the pending state at use, and writes immutable grant
 * rows through the 0003 rules (insert-only versions); decline, lapse, expiry
 * and revoke all fail closed
 */
import {
  auditGrant,
  decide,
  grantChoiceSchema,
  insertGrant,
  Refusal,
  requireOwner,
  resolveEncounter,
  scopeApprovalSchema,
  settle,
  withinHorizon,
} from './decision-core';
import {
  approvalFits,
  endGranteeConnection,
  insertRevocation,
  loadPendingConnection,
  loadPendingScopeRequest,
  requireAdmittedRequester,
} from './decision-steps';
import { expireStaleScopeRequests } from './queries';
import { audit, immediate, newId } from './store';

import type { PersonRef } from '../contracts';

import type { Decided, IssuedGrant, ScopeApproval } from './decision-core';
import type { GrantChoice, SharingDenial, SharingDeps } from './types';

export { MAX_GRANT_DAYS } from './decision-core';
export type { Decided, IssuedGrant, ScopeApproval } from './decision-core';

/**
 * confirms a pending connection and issues the grant the owner chose in full;
 * only the step-up confirm page's POST may call this
 * @param deps the vault and clock
 * @param input the verified owner, the connection and the chosen grant
 * @param input.owner the verified owner
 * @param input.connectionId the pending connection
 * @param input.choice the encounter, categories, sensitivity and expiry
 * @returns the issued grant, or a denial that changed nothing
 */
export function confirmConnection(
  deps: SharingDeps,
  input: { owner: PersonRef; connectionId: string; choice: GrantChoice },
): IssuedGrant | SharingDenial {
  return decide(deps, 'connection.confirmed', () => {
    const vault = requireOwner(deps, input.owner);
    const parsed = grantChoiceSchema.safeParse(input.choice);
    const now = deps.clock();

    if (!parsed.success) {
      throw new Refusal('invalid-input');
    }

    const choice = parsed.data;
    const connection = loadPendingConnection(deps, input.connectionId, now);

    if (
      (choice.categories.length === 0 && !choice.allowBaseline) ||
      !withinHorizon(choice.expiresAt, now)
    ) {
      throw new Refusal('invalid-input');
    }

    const encounterId = resolveEncounter(deps, {
      vault,
      requester: connection.requester,
      choice: choice.encounter,
    });
    const grantId = newId(deps);

    insertGrant(deps, {
      owner: input.owner,
      grant: {
        id: grantId,
        patientId: vault.patientId,
        version: 1,
        effect: 'allow',
        grantee: connection.requester,
        encounterId,
        purpose: 'direct-treatment',
        categories: choice.categories,
        maxSensitivity: choice.maxSensitivity,
        allowBaseline: choice.allowBaseline,
        validFrom: now.toISOString(),
        expiresAt: new Date(choice.expiresAt).toISOString(),
      },
    });
    settle(deps, {
      table: 'connections',
      id: connection.id,
      status: 'confirmed',
    });
    audit(deps, {
      type: 'connection.confirmed',
      outcome: 'success',
      actorKind: 'owner',
      actor: input.owner,
      patientId: vault.patientId,
      target: { type: 'connection', id: connection.id },
    });
    auditGrant(deps, { vault, owner: input.owner, grantId, version: 1 });

    return { ok: true, grantId, encounterId };
  });
}

/**
 * declines a pending connection; it issues nothing and cannot be reopened
 * @param deps the vault and clock
 * @param input the verified owner and the connection
 * @param input.owner the verified owner
 * @param input.connectionId the pending connection
 * @returns ok, or a denial that changed nothing
 */
export function declineConnection(
  deps: SharingDeps,
  input: { owner: PersonRef; connectionId: string },
): Decided | SharingDenial {
  return decide(deps, 'connection.declined', () => {
    const vault = requireOwner(deps, input.owner);

    settle(deps, {
      table: 'connections',
      id: input.connectionId,
      status: 'declined',
    });
    audit(deps, {
      type: 'connection.declined',
      outcome: 'success',
      actorKind: 'owner',
      actor: input.owner,
      patientId: vault.patientId,
      target: { type: 'connection', id: input.connectionId },
    });

    return { ok: true };
  });
}

/**
 * approves a pending scope request with the categories, sensitivity and
 * validity the owner chose, issuing a new grant for the request's encounter;
 * only the step-up confirm page's POST may call this
 * @param deps the vault and clock
 * @param input the verified owner, the scope request and the approval
 * @param input.owner the verified owner
 * @param input.scopeRequestId the pending scope request
 * @param input.approval the approved categories, sensitivity and expiry
 * @returns the issued grant, or a denial that changed nothing
 */
export function approveScopeRequest(
  deps: SharingDeps,
  input: { owner: PersonRef; scopeRequestId: string; approval: ScopeApproval },
): IssuedGrant | SharingDenial {
  // committed on its own, so a lapsed request stays expired after a refusal
  immediate(deps.db, () => expireStaleScopeRequests(deps.db, deps.clock()));

  return decide(deps, 'scope.approved', () => {
    const vault = requireOwner(deps, input.owner);
    const parsed = scopeApprovalSchema.safeParse(input.approval);
    const now = deps.clock();
    const request = loadPendingScopeRequest(deps, input.scopeRequestId);

    if (!parsed.success || !approvalFits(parsed.data, request, now)) {
      throw new Refusal('invalid-input');
    }

    requireAdmittedRequester(deps, request, now);

    const grantId = newId(deps);

    insertGrant(deps, {
      owner: input.owner,
      scopeRequestId: request.id,
      grant: {
        id: grantId,
        patientId: vault.patientId,
        version: 1,
        effect: 'allow',
        grantee: request.requester,
        encounterId: request.encounterId,
        purpose: 'direct-treatment',
        categories: parsed.data.categories,
        maxSensitivity: parsed.data.maxSensitivity,
        allowBaseline: false,
        validFrom: now.toISOString(),
        expiresAt: new Date(parsed.data.expiresAt).toISOString(),
      },
    });
    settle(deps, {
      table: 'scope_requests',
      id: request.id,
      status: 'approved',
      grantId,
    });
    audit(deps, {
      type: 'scope.approved',
      outcome: 'success',
      actorKind: 'owner',
      actor: input.owner,
      patientId: vault.patientId,
      target: { type: 'scope-request', id: request.id },
      details: { categories: parsed.data.categories.length },
    });
    auditGrant(deps, { vault, owner: input.owner, grantId, version: 1 });

    return { ok: true, grantId, encounterId: request.encounterId };
  });
}

/**
 * declines a pending scope request; nothing is released
 * @param deps the vault and clock
 * @param input the verified owner and the scope request
 * @param input.owner the verified owner
 * @param input.scopeRequestId the pending scope request
 * @returns ok, or a denial that changed nothing
 */
export function declineScopeRequest(
  deps: SharingDeps,
  input: { owner: PersonRef; scopeRequestId: string },
): Decided | SharingDenial {
  return decide(deps, 'scope.declined', () => {
    const vault = requireOwner(deps, input.owner);

    settle(deps, {
      table: 'scope_requests',
      id: input.scopeRequestId,
      status: 'declined',
    });
    audit(deps, {
      type: 'scope.declined',
      outcome: 'success',
      actorKind: 'owner',
      actor: input.owner,
      patientId: vault.patientId,
      target: { type: 'scope-request', id: input.scopeRequestId },
    });

    return { ok: true };
  });
}

/**
 * revokes a grant at once: inserts its next version with `revoked_at` set, so
 * every later poll, retry and download re-check fails closed; revoking an
 * already revoked grant changes nothing and succeeds
 * @param deps the vault and clock
 * @param input the verified owner and the grant id
 * @param input.owner the verified owner
 * @param input.grantId the grant to revoke
 * @returns ok, or a denial that changed nothing
 */
export function revokeGrant(
  deps: SharingDeps,
  input: { owner: PersonRef; grantId: string },
): Decided | SharingDenial {
  return decide(deps, 'grant.revoked', () => {
    const vault = requireOwner(deps, input.owner);
    const current = deps.db
      .prepare(
        'SELECT version, revoked_at FROM current_grants WHERE id = ? AND patient_id = ?',
      )
      .get(input.grantId, vault.patientId);

    if (!current) {
      throw new Refusal('not-found');
    }

    if (current.revoked_at !== null) {
      return { ok: true };
    }

    const now = deps.clock().toISOString();
    const version = Number(current.version) + 1;

    insertRevocation(deps, {
      owner: input.owner,
      grantId: input.grantId,
      from: Number(current.version),
      version,
      now,
    });
    audit(deps, {
      type: 'grant.revoked',
      outcome: 'success',
      actorKind: 'owner',
      actor: input.owner,
      patientId: vault.patientId,
      target: { type: 'grant', id: input.grantId },
      details: { version },
    });

    endGranteeConnection(deps, input.grantId, version);

    return { ok: true };
  });
}
