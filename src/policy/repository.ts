/**
 * the thin read side of policy: loads the registry entry, the encounter, the
 * effective grants and the patient id from the vault, validating each row
 * against its contract; an invalid registry or encounter row stops the
 * decision; an invalid grant row is returned apart from the valid grants,
 * identified by id, version and stored effect only, so the engine can skip
 * an allow and fail closed on anything else
 * errors name the table only; they never echo row contents
 */
import {
  clinicianEntrySchema,
  encounterSchema,
  grantSchema,
} from '../contracts';

import type { DatabaseSync } from 'node:sqlite';

import type { ZodType } from 'zod';

import type { ClinicianEntry, Encounter, Grant, PersonRef } from '../contracts';

/** a raw SQLite row */
type Row = Record<string, unknown>;

/** a stored grant row that failed validation, identified without content */
export interface InvalidGrantRow {
  id: string;
  version: number;
  /** the stored `effect` column, to tell a skippable allow from a deny */
  effect: unknown;
}

/** the effective grants of a patient, split by validity */
export interface GrantRead {
  grants: Grant[];
  invalid: InvalidGrantRow[];
}

/** error raised when stored policy state does not satisfy its contract */
export class PolicyDataError extends Error {
  /**
   * @param table the table whose row failed validation
   * @param options standard error options carrying the validation cause
   */
  constructor(table: string, options?: ErrorOptions) {
    super(`stored ${table} row failed validation`, options);
    this.name = 'PolicyDataError';
  }
}

/**
 * returns the vault's single patient id
 * @param db an open vault
 * @returns the patient id, or undefined when the vault has no patient
 */
export function readPatientId(db: DatabaseSync): string | undefined {
  const row = db.prepare('SELECT id FROM patient LIMIT 1').get();

  return typeof row?.id === 'string' ? row.id : undefined;
}

/**
 * returns the registry entry for a verified `(issuer, subject)`; only an entry of an
 * enabled `institution` issuer counts (ADR-9): an entry under a patient
 * issuer, or under an institution since disabled, reads as unknown
 * @param db an open vault
 * @param person the verified issuer and subject
 * @returns the validated entry, or undefined when the clinician is unknown
 */
export function readClinician(
  db: DatabaseSync,
  person: PersonRef,
): ClinicianEntry | undefined {
  const row = db
    .prepare(
      `SELECT c.issuer, c.subject, c.display_name, c.organization_id, c.organization_name, c.roles,
              c.status, c.verified_at
       FROM clinicians c
       JOIN trusted_issuers t ON t.issuer = c.issuer AND t.enabled = 1 AND t.kind = 'institution'
       WHERE c.issuer = ? AND c.subject = ?`,
    )
    .get(person.issuer, person.subject);

  return row
    ? parseRow('clinicians', clinicianEntrySchema, {
        issuer: row.issuer,
        subject: row.subject,
        displayName: row.display_name,
        organizationId: optional(row.organization_id),
        organizationName: optional(row.organization_name),
        roles: parseJson('clinicians', row.roles),
        status: row.status,
        verifiedAt: row.verified_at,
      })
    : undefined;
}

/**
 * returns the encounter a request's selector names, read from the owner-managed table
 * @param db an open vault
 * @param encounterId the caller-supplied selector
 * @returns the validated encounter, or undefined when no row has this id
 */
export function readEncounter(
  db: DatabaseSync,
  encounterId: string,
): Encounter | undefined {
  const row = db
    .prepare(
      `SELECT id, patient_id, purpose, reason, clinician_issuer, clinician_subject, organization_id,
              starts_at, ends_at, status, created_by_issuer, created_by_subject, created_at
       FROM encounters WHERE id = ?`,
    )
    .get(encounterId);

  return row
    ? parseRow('encounters', encounterSchema, toEncounter(row))
    : undefined;
}

/**
 * reads the effective (highest-version) grants of a patient from `current_grants`;
 * a row that fails validation is reported in `invalid` rather than thrown, and
 * never falls back to an older version of the same grant
 * @param db an open vault
 * @param patientId the vault patient
 * @returns the valid effective grants and the invalid rows
 */
export function readGrants(db: DatabaseSync, patientId: string): GrantRead {
  const read: GrantRead = { grants: [], invalid: [] };
  const rows = db
    .prepare(
      `SELECT id, version, patient_id, effect, grantee_issuer, grantee_subject, grantee_organization_id,
              grantee_roles, encounter_id, purpose, categories, max_sensitivity, allow_baseline,
              allowed_record_ids, valid_from, expires_at, revoked_at
       FROM current_grants WHERE patient_id = ? ORDER BY id`,
    )
    .all(patientId);

  for (const row of rows) {
    try {
      read.grants.push(parseRow('grants', grantSchema, toGrant(row)));
    } catch (error) {
      if (!(error instanceof PolicyDataError)) {
        throw error;
      }

      read.invalid.push({
        id: String(row.id),
        version: Number(row.version),
        effect: row.effect,
      });
    }
  }

  return read;
}

/**
 * maps an encounters row to the contract shape
 * @param row the raw row
 * @returns the unvalidated encounter fields
 */
function toEncounter(row: Row): Row {
  const clinicianIssuer = optional(row.clinician_issuer);
  const clinicianSubject = optional(row.clinician_subject);

  return {
    id: row.id,
    patientId: row.patient_id,
    purpose: row.purpose,
    reason: optional(row.reason),
    clinician:
      clinicianIssuer === undefined && clinicianSubject === undefined
        ? undefined
        : { issuer: clinicianIssuer, subject: clinicianSubject },
    organizationId: optional(row.organization_id),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    createdBy: {
      issuer: row.created_by_issuer,
      subject: row.created_by_subject,
    },
    createdAt: row.created_at,
  };
}

/**
 * maps a grants row to the contract shape
 * @param row the raw row
 * @returns the unvalidated grant fields
 */
function toGrant(row: Row): Row {
  const roles = parseJson('grants', row.grantee_roles);
  const allowedRecordIds = optional(row.allowed_record_ids);

  return {
    id: row.id,
    patientId: row.patient_id,
    version: row.version,
    effect: row.effect,
    grantee: {
      issuer: row.grantee_issuer,
      subject: optional(row.grantee_subject),
      organizationId: optional(row.grantee_organization_id),
      roles: Array.isArray(roles) && roles.length === 0 ? undefined : roles,
    },
    encounterId: row.encounter_id,
    purpose: row.purpose,
    categories: parseJson('grants', row.categories),
    maxSensitivity: row.max_sensitivity,
    allowBaseline: row.allow_baseline === 1,
    allowedRecordIds:
      allowedRecordIds === undefined
        ? undefined
        : parseJson('grants', allowedRecordIds),
    validFrom: row.valid_from,
    expiresAt: row.expires_at,
    revokedAt: optional(row.revoked_at),
  };
}

/**
 * validates a mapped row against its contract
 * @param table the source table, for the error message
 * @param schema the contract schema
 * @param value the mapped row
 * @returns the validated value
 */
function parseRow<T>(table: string, schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);

  if (!result.success) {
    throw new PolicyDataError(table, { cause: result.error });
  }

  return result.data;
}

/**
 * parses a JSON text column
 * @param table the source table, for the error message
 * @param value the column value
 * @returns the parsed value
 */
function parseJson(table: string, value: unknown): unknown {
  try {
    return JSON.parse(String(value)) as unknown;
  } catch (error) {
    throw new PolicyDataError(table, { cause: error });
  }
}

/**
 * turns a nullable column into an optional field
 * @param value the column value
 * @returns the value, or undefined for SQL NULL
 */
function optional(value: unknown): unknown {
  return value === null ? undefined : value;
}
