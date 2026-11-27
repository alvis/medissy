import { createHash } from 'node:crypto';

import { createFixtureStore } from '../../src/box/fixture';
import { createInboundPort } from '../../src/inbound/service';
import {
  CARDIOLOGIST,
  clockAt,
  grantFor,
  insertGrant,
  ISSUER,
  PATIENT,
  personFor,
  seedVault,
  T_NOW,
  T_SEED,
} from '../policy/support';

import type { DatabaseSync } from 'node:sqlite';

import type { FixtureFile } from '../../src/box/fixture';
import type { SecureStore } from '../../src/box/types';
import type { PersonRef } from '../../src/contracts';
import type { InboundPort } from '../../src/inbound/service';

export const FOLDER = '8800000001';
export const CARDIO: PersonRef = personFor(CARDIOLOGIST);

/** one inbound test rig: vault, folder, store and port */
export interface InboundRig {
  db: DatabaseSync;
  files: FixtureFile[];
  store: SecureStore;
  port: InboundPort;
}

/**
 * records a confirmed connection for a clinician
 * @param db a vault with its patient
 * @param person the patient and the clinician's issuer and subject
 * @param person.patientId the vault patient, default the synthetic one
 * @param person.issuer the clinician's issuer, default the test issuer
 * @param person.subject the clinician's subject
 */
export function confirmConnection(
  db: DatabaseSync,
  person: { patientId?: string; issuer?: string; subject: string },
): void {
  const { patientId = PATIENT, issuer = ISSUER, subject } = person;
  const id = `inv-${subject}`;

  db.prepare(
    `INSERT INTO invitations (id, patient_id, token_hash, status, created_at, expires_at, consumed_at, consumed_by_issuer, consumed_by_subject)
     VALUES (?, ?, ?, 'consumed', ?, '2099-12-31T00:00:00.000Z', ?, ?, ?)`,
  ).run(
    id,
    patientId,
    createHash('sha256').update(subject).digest('hex'),
    T_SEED,
    T_SEED,
    issuer,
    subject,
  );
  db.prepare(
    `INSERT INTO connections (id, patient_id, invitation_id, requester_issuer, requester_subject, status, created_at, decided_at)
     VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?)`,
  ).run(`conn-${subject}`, patientId, id, issuer, subject, T_SEED, T_SEED);
}

/**
 * builds a seeded vault where the cardiologist holds a confirmed connection and the
 * cardiac grant, with a fixture store over an in-memory folder
 * @param options what to leave out
 * @param options.grant false to omit the grant
 * @param options.connection false to omit the connection
 * @returns the vault, the in-memory folder, its store and the port
 */
export function inboundRig(
  options: { grant?: boolean; connection?: boolean } = {},
): InboundRig {
  const db = seedVault();
  const files: FixtureFile[] = [];
  const store = createFixtureStore(FOLDER, files);

  if (options.connection !== false) {
    confirmConnection(db, { subject: CARDIOLOGIST });
  }

  if (options.grant !== false) {
    insertGrant(db, grantFor());
  }

  return {
    db,
    files,
    store,
    port: createInboundPort({ db, store, clock: clockAt(T_NOW) }),
  };
}

/**
 * builds a synthetic Observation as a clinician's agent would send it
 * @param overrides fields to add or replace
 * @returns the resource
 */
export function observation(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    resourceType: 'Observation',
    status: 'final',
    code: { text: 'SYNTHETIC resting heart rate' },
    valueQuantity: { value: 64, unit: 'beats/min' },
    effectiveDateTime: '2026-11-24T09:00:00.000Z',
    ...overrides,
  };
}

/**
 * counts rows in a table
 * @param db the vault
 * @param sql a `SELECT COUNT(*) AS n …` statement
 * @param params positional parameters
 * @returns the number of matching rows
 */
export function count(
  db: DatabaseSync,
  sql: string,
  ...params: string[]
): number {
  return Number(db.prepare(sql).get(...params)?.n);
}
