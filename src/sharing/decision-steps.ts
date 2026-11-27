/**
 * the steps the owner's decisions share: reading what is still pending,
 * checking an approval against its request, and the revoke writes; each
 * refuses by throwing `Refusal`, which `decide` turns into a denial
 */
import { Refusal } from './decision-core';
import {
  encountersAdmitting,
  endIdleConnection,
  hasConfirmedConnection,
  hasLapsed,
  readConnection,
  readScopeRequest,
} from './queries';

import type { Connection, PersonRef, ScopeRequest } from '../contracts';

import type { SharingDeps } from './types';

/**
 * reads a connection that is still pending and in time
 * @param deps the vault and clock
 * @param id which connection the owner is deciding
 * @param now the current time
 * @returns the stored connection, known to be open for a decision
 * @throws {Refusal} when it is missing, decided or lapsed
 */
export function loadPendingConnection(
  deps: SharingDeps,
  id: string,
  now: Date,
): Connection {
  const connection = readConnection(deps.db, id);

  if (!connection) {
    throw new Refusal('not-found');
  }

  if (connection.status !== 'pending') {
    throw new Refusal('not-pending');
  }

  if (hasLapsed(connection, now)) {
    throw new Refusal('expired');
  }

  return connection;
}

/**
 * reads a scope request that is still pending
 * @param deps the vault and clock
 * @param id which scope request the owner is deciding
 * @returns the stored request, known to be open for a decision
 * @throws {Refusal} when it is missing, expired or decided
 */
export function loadPendingScopeRequest(
  deps: SharingDeps,
  id: string,
): ScopeRequest {
  const request = readScopeRequest(deps.db, id);

  if (!request) {
    throw new Refusal('not-found');
  }

  if (request.status === 'expired') {
    throw new Refusal('expired');
  }

  if (request.status !== 'pending') {
    throw new Refusal('not-pending');
  }

  return request;
}

/**
 * checks whether an approval stays inside what the requester asked for
 * @param approval the owner's approved categories and expiry
 * @param approval.categories the categories the owner ticked
 * @param approval.expiresAt when the new grant would end
 * @param request the pending scope request
 * @param now the current time
 * @returns true when every category was requested and the expiry is in range
 */
export function approvalFits(
  approval: { categories: readonly string[]; expiresAt: string },
  request: ScopeRequest,
  now: Date,
): boolean {
  return (
    !approval.categories.some(
      (category) =>
        !(request.requestedCategories as readonly string[]).includes(category),
    ) &&
    Date.parse(approval.expiresAt) > now.getTime() &&
    Date.parse(approval.expiresAt) <= Date.parse(request.desiredExpiresAt)
  );
}

/**
 * requires that the requester still has a confirmed connection and an
 * encounter that admits them
 * @param deps the vault and clock
 * @param request the pending scope request
 * @param now the current time
 * @throws {Refusal} `not-permitted` when either no longer holds
 */
export function requireAdmittedRequester(
  deps: SharingDeps,
  request: ScopeRequest,
  now: Date,
): void {
  const admits = encountersAdmitting(deps.db, request.requester, now).some(
    (encounter) => encounter.id === request.encounterId,
  );

  if (!admits || !hasConfirmedConnection(deps.db, request.requester)) {
    throw new Refusal('not-permitted');
  }
}

/**
 * inserts the next grant version with `revoked_at` set
 * @param deps the vault
 * @param revocation which grant version to copy, and who revokes it
 * @param revocation.owner the verified owner
 * @param revocation.grantId the grant to revoke
 * @param revocation.from the version being superseded
 * @param revocation.version the new version
 * @param revocation.now the revocation time as an ISO string
 */
export function insertRevocation(
  deps: SharingDeps,
  revocation: {
    owner: PersonRef;
    grantId: string;
    from: number;
    version: number;
    now: string;
  },
): void {
  const { owner, grantId, from, version, now } = revocation;

  deps.db
    .prepare(
      `INSERT INTO grants (id, version, patient_id, effect, grantee_issuer, grantee_subject, grantee_organization_id,
         grantee_roles, encounter_id, purpose, categories, max_sensitivity, allow_baseline, allowed_record_ids,
         valid_from, expires_at, revoked_at, source, scope_request_id, created_by_issuer, created_by_subject, created_at)
       SELECT id, ?, patient_id, effect, grantee_issuer, grantee_subject, grantee_organization_id, grantee_roles,
         encounter_id, purpose, categories, max_sensitivity, allow_baseline, allowed_record_ids, valid_from,
         expires_at, ?, source, scope_request_id, ?, ?, ?
       FROM grants WHERE id = ? AND version = ?`,
    )
    .run(version, now, owner.issuer, owner.subject, now, grantId, from);
}

/**
 * ends the grantee's connection when the revoked grant was its last live one,
 * so a revoked clinician can no longer send scope requests
 * @param deps the vault and clock
 * @param grantId the revoked grant
 * @param version the revoking version
 */
export function endGranteeConnection(
  deps: SharingDeps,
  grantId: string,
  version: number,
): void {
  const grantee = deps.db
    .prepare(
      'SELECT grantee_issuer, grantee_subject FROM grants WHERE id = ? AND version = ?',
    )
    .get(grantId, version);

  if (
    grantee?.grantee_subject !== null &&
    grantee?.grantee_subject !== undefined
  ) {
    endIdleConnection(
      deps.db,
      {
        issuer: String(grantee.grantee_issuer),
        subject: String(grantee.grantee_subject),
      },
      deps.clock(),
    );
  }
}
