/**
 * validated reads of sharing state for the owner and clinician portals and
 * for the decisions; a row that does not match its contract is skipped, so a
 * malformed row can never be confirmed or approved
 */
import {
  connectionSchema,
  encounterAdmitsCaller,
  scopeRequestSchema,
} from '../contracts';
import { readClinician, readEncounter } from '../policy/repository';

import type { DatabaseSync } from 'node:sqlite';

import type {
  Connection,
  Encounter,
  PersonRef,
  ScopeRequest,
} from '../contracts';

const MS_PER_DAY = 86_400_000;
/** how long a pending connection may wait for the owner before it lapses */
export const PENDING_CONNECTION_TTL_DAYS = 7;
/** the furthest a scope request may ask access to last */
export const MAX_SCOPE_REQUEST_DAYS = 30;

type Row = Record<string, unknown>;

/**
 * returns a nullable column as an optional field
 * @param value the column value
 * @returns the value, or undefined for NULL
 */
function optional(value: unknown): unknown {
  return value ?? undefined;
}

/**
 * maps and validates a connections row
 * @param row the raw row
 * @returns the connection, or undefined when malformed
 */
function toConnection(row: Row): Connection | undefined {
  const parsed = connectionSchema.safeParse({
    id: row.id,
    patientId: row.patient_id,
    invitationId: row.invitation_id,
    requester: { issuer: row.requester_issuer, subject: row.requester_subject },
    statedName: optional(row.stated_name),
    statedOrganization: optional(row.stated_organization),
    statedRole: optional(row.stated_role),
    status: row.status,
    createdAt: row.created_at,
    decidedAt: optional(row.decided_at),
  });

  return parsed.success ? parsed.data : undefined;
}

/**
 * maps and validates a scope_requests row
 * @param row the raw row
 * @returns the scope request, or undefined when malformed
 */
function toScopeRequest(row: Row): ScopeRequest | undefined {
  let categories: unknown;

  try {
    categories = JSON.parse(String(row.requested_categories));
  } catch {
    return undefined;
  }

  const parsed = scopeRequestSchema.safeParse({
    id: row.id,
    requestId: row.request_id,
    patientId: row.patient_id,
    requester: { issuer: row.requester_issuer, subject: row.requester_subject },
    encounterId: row.encounter_id,
    requestedCategories: categories,
    reason: row.reason,
    desiredExpiresAt: row.desired_expires_at,
    status: row.status,
    createdAt: row.created_at,
    decidedAt: optional(row.decided_at),
    grantId: optional(row.grant_id),
  });

  return parsed.success ? parsed.data : undefined;
}

/**
 * reads one connection
 * @param db the vault
 * @param id the connection id to look up
 * @returns the connection, or undefined
 */
export function readConnection(
  db: DatabaseSync,
  id: string,
): Connection | undefined {
  const row = db.prepare('SELECT * FROM connections WHERE id = ?').get(id);

  return row ? toConnection(row) : undefined;
}

/**
 * reads one scope request
 * @param db the vault
 * @param id the scope request id to look up
 * @returns the scope request, or undefined
 */
export function readScopeRequest(
  db: DatabaseSync,
  id: string,
): ScopeRequest | undefined {
  const row = db.prepare('SELECT * FROM scope_requests WHERE id = ?').get(id);

  return row ? toScopeRequest(row) : undefined;
}

/**
 * lists connections in the given states, newest first
 * @param db the vault
 * @param statuses the states to list
 * @returns the valid connections
 */
export function listConnections(
  db: DatabaseSync,
  statuses: ReadonlyArray<Connection['status']>,
): Connection[] {
  return db
    .prepare('SELECT * FROM connections ORDER BY created_at DESC, id')
    .all()
    .flatMap((row) => toConnection(row) ?? [])
    .filter((connection) => statuses.includes(connection.status));
}

/**
 * lists scope requests, newest first, optionally only one requester's
 * @param db the vault
 * @param filter the states to list and an optional requester
 * @param filter.statuses the states to list
 * @param filter.requester only this requester's requests
 * @returns the valid scope requests
 */
export function listScopeRequests(
  db: DatabaseSync,
  filter: {
    statuses: ReadonlyArray<ScopeRequest['status']>;
    requester?: PersonRef;
  },
): ScopeRequest[] {
  const { requester } = filter;

  return db
    .prepare('SELECT * FROM scope_requests ORDER BY created_at DESC, id')
    .all()
    .flatMap((row) => toScopeRequest(row) ?? [])
    .filter(
      (request) =>
        filter.statuses.includes(request.status) &&
        (requester === undefined ||
          (request.requester.issuer === requester.issuer &&
            request.requester.subject === requester.subject)),
    );
}

/**
 * checks whether a pending connection waited too long for the owner; a lapsed
 * connection cannot be confirmed (it fails closed)
 * @param connection the pending connection to test
 * @param now the server clock
 * @returns true when it can no longer be confirmed
 */
export function hasLapsed(connection: Connection, now: Date): boolean {
  return (
    Date.parse(connection.createdAt) +
      PENDING_CONNECTION_TTL_DAYS * MS_PER_DAY <=
    now.getTime()
  );
}

/**
 * declines every pending connection that waited past
 * `PENDING_CONNECTION_TTL_DAYS`, so a lapsed one no longer counts as live and
 * the requester may redeem a new invitation
 * @param db the vault
 * @param now the server clock
 * @returns how many connections lapsed
 */
export function declineLapsedConnections(db: DatabaseSync, now: Date): number {
  const cutoff = new Date(
    now.getTime() - PENDING_CONNECTION_TTL_DAYS * MS_PER_DAY,
  ).toISOString();

  return Number(
    db
      .prepare(
        `UPDATE connections SET status = 'declined', decided_at = ?
         WHERE status = 'pending' AND created_at <= ?`,
      )
      .run(now.toISOString(), cutoff).changes,
  );
}

/**
 * ends a person's confirmed connection once they hold no live grant (not
 * revoked, not expired), so a revoked clinician can no longer ask for scope
 * @param db the vault
 * @param person the grantee
 * @param now the server clock
 * @returns how many connections ended
 */
export function endIdleConnection(
  db: DatabaseSync,
  person: PersonRef,
  now: Date,
): number {
  const live = db
    .prepare(
      `SELECT 1 FROM current_grants
       WHERE grantee_issuer = ? AND grantee_subject = ? AND revoked_at IS NULL AND expires_at > ?`,
    )
    .get(person.issuer, person.subject, now.toISOString());

  if (live) {
    return 0;
  }

  return Number(
    db
      .prepare(
        `UPDATE connections SET status = 'ended'
         WHERE requester_issuer = ? AND requester_subject = ? AND status = 'confirmed'`,
      )
      .run(person.issuer, person.subject).changes,
  );
}

/**
 * marks every pending scope request whose desired expiry has passed as
 * `expired`, so it can never be approved
 * @param db the vault
 * @param now the server clock
 * @returns how many requests expired
 */
export function expireStaleScopeRequests(db: DatabaseSync, now: Date): number {
  const at = now.toISOString();

  return Number(
    db
      .prepare(
        `UPDATE scope_requests SET status = 'expired', decided_at = ?
         WHERE status = 'pending' AND desired_expires_at <= ?`,
      )
      .run(at, at).changes,
  );
}

/**
 * checks whether a verified person holds a confirmed connection
 * @param db the vault
 * @param person the verified person
 * @returns true when the owner confirmed them
 */
export function hasConfirmedConnection(
  db: DatabaseSync,
  person: PersonRef,
): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM connections WHERE requester_issuer = ? AND requester_subject = ? AND status = 'confirmed'`,
      )
      .get(person.issuer, person.subject) !== undefined
  );
}

/**
 * lists the encounters that admit a person now: active, in their window, and
 * linked to the person or to their registry organization
 * @param db the vault
 * @param person the verified person
 * @param now the server clock
 * @returns the admitting encounters, oldest first
 */
export function encountersAdmitting(
  db: DatabaseSync,
  person: PersonRef,
  now: Date,
): Encounter[] {
  const organizationId = readClinician(db, person)?.organizationId;

  return db
    .prepare('SELECT id FROM encounters ORDER BY created_at, id')
    .all()
    .flatMap((row) => readEncounter(db, String(row.id)) ?? [])
    .filter((encounter) =>
      encounterAdmitsCaller(encounter, { ...person, organizationId }, now),
    );
}
