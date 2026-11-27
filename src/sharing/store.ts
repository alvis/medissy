/**
 * small vault helpers shared by the sharing operations: one `BEGIN IMMEDIATE`
 * transaction per operation, the owner check, and content-free audit and log
 * writes
 */
import { randomUUID } from 'node:crypto';

import { insertAudit } from '../disclosure/ledger';

import type { DatabaseSync } from 'node:sqlite';

import type { AuditEvent, PersonRef } from '../contracts';

import type {
  SharingDenial,
  SharingDenialCode,
  SharingDeps,
  SharingLogEntry,
} from './types';

/** the vault's patient and its verified owner */
export interface VaultOwner {
  patientId: string;
  owner: PersonRef;
}

/**
 * runs work in one `BEGIN IMMEDIATE` transaction, rolling back on any throw
 * @param db the vault
 * @param work the reads and writes
 * @returns what the work returned
 */
export function immediate<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');

  try {
    const result = work();

    db.exec('COMMIT');

    return result;
  } catch (error) {
    db.exec('ROLLBACK');

    throw error;
  }
}

/**
 * reads the vault patient and owner
 * @param db the vault to read
 * @returns the patient id and owner, or undefined before a patient exists
 */
export function readVaultOwner(db: DatabaseSync): VaultOwner | undefined {
  const row = db
    .prepare('SELECT id, owner_issuer, owner_subject FROM patient LIMIT 1')
    .get();

  return row
    ? {
        patientId: String(row.id),
        owner: {
          issuer: String(row.owner_issuer),
          subject: String(row.owner_subject),
        },
      }
    : undefined;
}

/**
 * checks whether a verified person is the vault owner
 * @param vault the vault owner, if any
 * @param person the verified person
 * @returns true only for the owner
 */
export function isOwner(
  vault: VaultOwner | undefined,
  person: PersonRef,
): boolean {
  return (
    vault?.owner.issuer === person.issuer &&
    vault.owner.subject === person.subject
  );
}

/**
 * builds a refusal
 * @param code why
 * @returns the denial
 */
export function denied(code: SharingDenialCode): SharingDenial {
  return { ok: false, code };
}

/**
 * mints a row id
 * @param deps the sharing deps
 * @returns a fresh id
 */
export function newId(deps: SharingDeps): string {
  return (deps.newId ?? randomUUID)();
}

/**
 * writes one log line (no identifiers, tokens or text)
 * @param deps the sharing deps
 * @param entry the event and outcome
 */
export function log(deps: SharingDeps, entry: SharingLogEntry): void {
  deps.logger?.info(entry);
}

/** what an audit event of the sharing service carries */
export interface SharingAudit {
  type: AuditEvent['type'];
  outcome: AuditEvent['outcome'];
  actorKind: 'owner' | 'clinician';
  actor: PersonRef;
  patientId: string;
  /** absent when the attempt named nothing that exists */
  target?: { type: string; id: string };
  details?: AuditEvent['details'];
}

/**
 * appends an audit event inside the caller's transaction; details are scalars
 * only and never carry a token, a stated name or reason text
 * @param deps the sharing deps
 * @param event what happened
 */
export function audit(deps: SharingDeps, event: SharingAudit): void {
  insertAudit(deps.db, {
    id: newId(deps),
    occurredAt: deps.clock().toISOString(),
    type: event.type,
    outcome: event.outcome,
    actor: {
      kind: event.actorKind,
      issuer: event.actor.issuer,
      subject: event.actor.subject,
    },
    patientId: event.patientId,
    target: event.target,
    details: event.details ?? {},
  });
}
