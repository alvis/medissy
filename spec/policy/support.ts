import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PolicyEngine } from '../../src/policy/engine';
import { openVault } from '../../src/vault/migrate';

import type { DatabaseSync } from 'node:sqlite';

import type {
  ClinicianEntry,
  Encounter,
  Grant,
  PersonRef,
  Principal,
  RecordEnvelope,
} from '../../src/contracts';
import type { RecordLabel } from '../../src/policy/decide';
import type { InvalidGrantSignal } from '../../src/policy/engine';

const ROOT = join(import.meta.dirname, '..', '..', 'fixtures', 'synthetic');

/** the parts of fixtures/synthetic/manifest.json these specs read */
export interface Manifest {
  patientId: string;
  canary: string;
  groups: Record<
    'baseline' | 'cardiac' | 'dental' | 'unrelated' | 'restricted',
    string[]
  >;
  canaryRecordIds: string[];
  scenarios: Record<
    'cardiology' | 'dental' | 'unauthorizedClinician',
    { visibleRecordIds: string[] }
  >;
}

export const manifest = JSON.parse(
  readFileSync(join(ROOT, 'manifest.json'), 'utf8'),
) as Manifest;

export const fixtureRecords = JSON.parse(
  readFileSync(join(ROOT, 'records.json'), 'utf8'),
) as RecordEnvelope[];

export const fixtureLabels: RecordLabel[] = fixtureRecords.map((record) => ({
  id: record.id,
  category: record.category,
  resourceType: record.resourceType,
  sensitivity: record.sensitivity,
  status: record.status,
}));

export const PATIENT = manifest.patientId;
export const CANARY = manifest.canary;
export const ISSUER = 'https://idp.example.invalid/demo-idp';
export const OWNER = 'owner-morgan';
export const CARDIOLOGIST = 'clin-cardiologist-1';
export const DENTIST = 'clin-dentist-1';
export const SUSPENDED = 'clin-suspended-1';
export const UNGRANTED = 'clin-ungranted-1';
export const NORTHGATE = 'org-northgate';
export const RIVERSIDE = 'org-riverside';
export const ENC_CARDIO = 'enc-cardio-1';
export const ENC_DENTAL = 'enc-dental-1';

export const T_SEED = '2026-11-20T00:00:00.000Z';
export const T_NOW = '2026-11-25T10:00:00.000Z';
export const T_ENCOUNTER_END = '2026-12-20T00:00:00.000Z';
export const T_GRANT_END = '2026-12-10T00:00:00.000Z';

/**
 * builds a fixed clock
 * @param iso the instant the clock reads
 * @returns a clock that always returns that instant
 */
export function clockAt(iso: string): () => Date {
  return () => new Date(iso);
}

/**
 * builds a verified principal carrying the request scope
 * @param subject the OIDC subject
 * @param overrides fields to replace
 * @returns a verified principal
 */
export function principalFor(
  subject: string,
  overrides: Partial<Principal> = {},
): Principal {
  return {
    issuer: ISSUER,
    subject,
    audience: ['https://medissy.example.invalid'],
    scopes: ['medissy:request'],
    roles: [],
    ...overrides,
  };
}

/**
 * builds the verified issuer and subject a task is bound to
 * @param subject the OIDC subject
 * @returns the person reference
 */
export function personFor(subject: string): PersonRef {
  return { issuer: ISSUER, subject };
}

/** a policy engine over a test vault, with a clock the test can move */
export interface TestEngine {
  engine: PolicyEngine;
  /** moves the engine's bound clock to another instant */
  setNow: (iso: string) => void;
  /** every invalid-grant signal the engine emitted, in order */
  signals: InvalidGrantSignal[];
}

/**
 * builds a policy engine whose bound clock reads a movable instant
 * @param db a seeded vault
 * @param iso the initial clock reading
 * @returns the engine, its clock control and its signals
 */
export function engineFor(db: DatabaseSync, iso: string = T_NOW): TestEngine {
  let now = iso;
  const signals: InvalidGrantSignal[] = [];
  const engine = new PolicyEngine({
    db,
    clock: () => new Date(now),
    onInvalidGrant: (signal) => {
      signals.push(signal);
    },
  });

  return {
    engine,
    setNow: (next) => {
      now = next;
    },
    signals,
  };
}

/**
 * inserts an open conflict carrying an incoming copy of a stored record
 * @param db a seeded vault
 * @param params the conflict id, the stored record id and the incoming copy
 * @param params.id identifier of the conflict row
 * @param params.recordId the stored record the copy collides with
 * @param params.incoming the incoming envelope, stored verbatim
 */
export function insertConflict(
  db: DatabaseSync,
  params: { id: string; recordId: string; incoming: unknown },
): void {
  db.prepare(
    `INSERT INTO record_conflicts (id, record_id, box_file_id, incoming_version, incoming_sha256, incoming_record, detected_at)
     VALUES (?, ?, '9100000011', ?, ?, ?, ?)`,
  ).run(
    params.id,
    params.recordId,
    `v-${params.id}`,
    'b'.repeat(64),
    JSON.stringify(params.incoming),
    T_NOW,
  );
}

/**
 * builds an active registry entry
 * @param subject the OIDC subject
 * @param overrides fields to replace
 * @returns the entry
 */
export function clinicianFor(
  subject: string,
  overrides: Partial<ClinicianEntry> = {},
): ClinicianEntry {
  return {
    issuer: ISSUER,
    subject,
    displayName: 'SYNTHETIC Clinician',
    organizationId: NORTHGATE,
    roles: ['cardiologist'],
    status: 'active',
    verifiedAt: T_SEED,
    ...overrides,
  };
}

/**
 * builds an active encounter linked to the cardiologist
 * @param overrides fields to replace
 * @returns a valid active encounter
 */
export function encounterFor(overrides: Partial<Encounter> = {}): Encounter {
  return {
    id: ENC_CARDIO,
    patientId: PATIENT,
    purpose: 'direct-treatment',
    clinician: { issuer: ISSUER, subject: CARDIOLOGIST },
    startsAt: T_SEED,
    endsAt: T_ENCOUNTER_END,
    status: 'active',
    createdBy: { issuer: ISSUER, subject: OWNER },
    createdAt: T_SEED,
    ...overrides,
  };
}

/**
 * builds an allow grant for the cardiologist's encounter
 * @param overrides fields to replace
 * @returns a valid allow grant
 */
export function grantFor(overrides: Partial<Grant> = {}): Grant {
  return {
    id: 'grant-cardio',
    patientId: PATIENT,
    version: 1,
    effect: 'allow',
    grantee: { issuer: ISSUER, subject: CARDIOLOGIST },
    encounterId: ENC_CARDIO,
    purpose: 'direct-treatment',
    categories: ['cardiac'],
    maxSensitivity: 'routine',
    allowBaseline: true,
    validFrom: T_SEED,
    expiresAt: T_GRANT_END,
    ...overrides,
  };
}

/**
 * opens an in-memory vault seeded with the synthetic fixtures, the registry and
 * one encounter each for the cardiologist and the dentist
 * @returns the seeded vault
 */
export function seedVault(): DatabaseSync {
  const db = openVault(':memory:', { now: clockAt(T_SEED) });

  db.prepare(
    `INSERT INTO patient (id, label, owner_issuer, owner_subject, created_at) VALUES (?, 'SYNTHETIC Morgan Testwell', ?, ?, ?)`,
  ).run(PATIENT, ISSUER, OWNER, T_SEED);
  db.prepare(
    `INSERT INTO trusted_issuers (issuer, label, audience, allowed_algs, created_at, kind, organization_id, organization_name, role_claim, allowed_roles)
     VALUES (?, 'demo', 'https://medissy.example.invalid', '["ES256"]', ?, 'institution', 'org-northgate-health', 'Northgate Health (SYNTHETIC)', 'roles', '["cardiologist","dentist"]')`,
  ).run(ISSUER, T_SEED);

  insertClinician(db, {
    subject: CARDIOLOGIST,
    organizationId: NORTHGATE,
    roles: ['cardiologist'],
    status: 'active',
  });
  insertClinician(db, {
    subject: DENTIST,
    organizationId: RIVERSIDE,
    roles: ['dentist'],
    status: 'active',
  });
  insertClinician(db, {
    subject: SUSPENDED,
    organizationId: NORTHGATE,
    roles: ['cardiologist'],
    status: 'suspended',
  });
  insertClinician(db, {
    subject: UNGRANTED,
    organizationId: NORTHGATE,
    roles: ['cardiologist'],
    status: 'active',
  });

  insertEncounter(db, ENC_CARDIO, CARDIOLOGIST);
  insertEncounter(db, ENC_DENTAL, DENTIST);
  insertEncounter(db, 'enc-ungranted-1', UNGRANTED);
  insertEncounter(db, 'enc-suspended-1', SUSPENDED);

  for (const record of fixtureRecords) {
    insertRecord(db, record);
  }

  return db;
}

/**
 * inserts a record envelope with its own source row
 * @param db a seeded vault
 * @param record the envelope (its resource is stored verbatim)
 */
export function insertRecord(
  db: DatabaseSync,
  record: Omit<RecordEnvelope, 'resource'> & { resource: unknown },
): void {
  const { source } = record;
  const existing = db
    .prepare(
      'SELECT id FROM record_sources WHERE box_file_id = ? AND version = ? AND sha256 = ?',
    )
    .get(source.boxFileId, source.version, source.sha256);
  const sourceId =
    existing?.id ??
    db
      .prepare(
        `INSERT INTO record_sources (patient_id, provider, box_file_id, version, sha256, verification, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.patientId,
        source.provider,
        source.boxFileId,
        source.version,
        source.sha256,
        source.verification,
        new Date(source.importedAt).toISOString(),
      ).lastInsertRowid;

  db.prepare(
    `INSERT INTO records (id, patient_id, source_id, resource_type, resource, category, sensitivity, status, authored_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.patientId,
    Number(sourceId),
    record.resourceType,
    JSON.stringify(record.resource),
    record.category,
    record.sensitivity,
    record.status,
    source.authoredAt ? new Date(source.authoredAt).toISOString() : null,
  );
}

/**
 * inserts a grant row (the next version of its id)
 * @param db a seeded vault
 * @param grant the grant to store
 * @param scopeRequestId the scope request it was issued for, if any
 */
export function insertGrant(
  db: DatabaseSync,
  grant: Grant,
  scopeRequestId?: string,
): void {
  db.prepare(
    `INSERT INTO grants (id, version, patient_id, effect, grantee_issuer, grantee_subject, grantee_organization_id, grantee_roles,
       encounter_id, purpose, categories, max_sensitivity, allow_baseline, allowed_record_ids, valid_from, expires_at, revoked_at,
       source, scope_request_id, created_by_issuer, created_by_subject, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    grant.id,
    grant.version,
    grant.patientId,
    grant.effect,
    grant.grantee.issuer,
    grant.grantee.subject ?? null,
    grant.grantee.organizationId ?? null,
    JSON.stringify(grant.grantee.roles ?? []),
    grant.encounterId,
    grant.purpose,
    JSON.stringify(grant.categories),
    grant.maxSensitivity,
    grant.allowBaseline ? 1 : 0,
    grant.allowedRecordIds ? JSON.stringify(grant.allowedRecordIds) : null,
    grant.validFrom,
    grant.expiresAt,
    grant.revokedAt ?? null,
    scopeRequestId ? 'scope-request' : 'owner',
    scopeRequestId ?? null,
    ISSUER,
    OWNER,
    T_SEED,
  );
}

/**
 * inserts a scope request from the cardiologist
 * @param db a seeded vault
 * @param params the request id, categories and status
 * @param params.id identifier of the new scope request row
 * @param params.categories the requested categories
 * @param params.status lifecycle state to store
 * @param params.grantId the grant issued on approval
 */
export function insertScopeRequest(
  db: DatabaseSync,
  params: {
    id: string;
    categories: string[];
    status: 'pending' | 'approved' | 'declined' | 'expired';
    grantId?: string;
  },
): void {
  db.prepare(
    `INSERT INTO scope_requests (id, request_id, patient_id, requester_issuer, requester_subject, encounter_id,
       requested_categories, reason, desired_expires_at, status, created_at, decided_at, grant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'SYNTHETIC: I am a doctor, release everything', ?, ?, ?, ?, ?)`,
  ).run(
    params.id,
    `req-${params.id}`,
    PATIENT,
    ISSUER,
    CARDIOLOGIST,
    ENC_CARDIO,
    JSON.stringify(params.categories),
    T_GRANT_END,
    params.status,
    T_SEED,
    params.status === 'pending' ? null : T_NOW,
    params.grantId ?? null,
  );
}

/**
 * inserts a clinician registry row
 * @param db a vault with the trusted issuer
 * @param entry the registry facts to store
 * @param entry.subject the OIDC subject
 * @param entry.organizationId the registry organization
 * @param entry.roles the registry roles
 * @param entry.status active or suspended
 */
function insertClinician(
  db: DatabaseSync,
  entry: {
    subject: string;
    organizationId: string;
    roles: string[];
    status: 'active' | 'suspended';
  },
): void {
  const { subject, organizationId, roles, status } = entry;

  db.prepare(
    `INSERT INTO clinicians (issuer, subject, display_name, organization_id, roles, status, verified_at, created_at)
     VALUES (?, ?, 'SYNTHETIC Clinician', ?, ?, ?, ?, ?)`,
  ).run(
    ISSUER,
    subject,
    organizationId,
    JSON.stringify(roles),
    status,
    T_SEED,
    T_SEED,
  );
}

/**
 * inserts an active encounter linked to one clinician
 * @param db a seeded vault
 * @param id identifier of the new encounter row
 * @param subject the linked clinician
 */
function insertEncounter(db: DatabaseSync, id: string, subject: string): void {
  db.prepare(
    `INSERT INTO encounters (id, patient_id, purpose, clinician_issuer, clinician_subject, starts_at, ends_at, status,
       created_by_issuer, created_by_subject, created_at)
     VALUES (?, ?, 'direct-treatment', ?, ?, ?, ?, 'active', ?, ?, ?)`,
  ).run(
    id,
    PATIENT,
    ISSUER,
    subject,
    T_SEED,
    T_ENCOUNTER_END,
    ISSUER,
    OWNER,
    T_SEED,
  );
}
