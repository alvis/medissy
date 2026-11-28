/**
 * what the identity layer needs from the vault: trusted issuers, the
 * clinician registry and the patient owner; the registry is a just-in-time
 * record of verified doctors (ADR-9): every verified institution sign-in
 * rewrites the doctor's display name, roles and organisation, and never
 * touches `status`, the patient's `suspended` kill switch
 */
import { clinicianEntrySchema, trustedIssuerSchema } from '../contracts';

import type { DatabaseSync, StatementSync } from 'node:sqlite';

import type { ClinicianEntry, PersonRef } from '../contracts';

import type { TrustedIssuer } from './issuer';

/** a doctor an enabled institution has just vouched for */
export interface ClinicianSignIn {
  issuer: string;
  subject: string;
  displayName: string;
  /** from the institution's issuer row, never from a token claim */
  organizationId: string;
  organizationName: string;
  /** allowlisted roles from the ID token; empty when none is clinical */
  roles: readonly string[];
  verifiedAt: Date;
}

/** the lookups the verifier and sessions depend on */
export interface IdentityDirectory {
  /** an enabled trusted issuer, or null (also for a malformed row) */
  findTrustedIssuer(issuer: string): TrustedIssuer | null;
  /** a registry entry for `(issuer, subject)`, or null when unknown */
  findClinician(issuer: string, subject: string): ClinicianEntry | null;
  /**
   * records a verified institution sign-in; with clinical roles the entry is
   * inserted or refreshed and returned; without, an existing entry loses its
   * roles and null is returned, so the person counts as an unknown clinician
   */
  recordClinician(signIn: ClinicianSignIn): ClinicianEntry | null;
  /** the vault owner's identity, or null before a patient exists */
  findPatientOwner(): PersonRef | null;
}

interface IssuerRow {
  issuer: string;
  audience: string;
  allowedAlgs: string;
  jwksUri: string | null;
  kind: string;
  organizationId: string | null;
  organizationName: string | null;
  roleClaim: string | null;
  allowedRoles: string;
}

interface ClinicianRow {
  issuer: string;
  subject: string;
  displayName: string;
  organizationId: string | null;
  organizationName: string | null;
  roles: string;
  status: string;
  verifiedAt: string;
}

interface OwnerRow {
  issuer: string;
  subject: string;
}

/**
 * validates a stored issuer row; a row that does not match the contract is
 * treated as untrusted
 * @param row the stored row
 * @returns the issuer, or null
 */
function toTrustedIssuer(row: IssuerRow): TrustedIssuer | null {
  const parsed = trustedIssuerSchema.safeParse({
    issuer: row.issuer,
    audience: row.audience,
    allowedAlgs: JSON.parse(row.allowedAlgs) as unknown,
    jwksUri: row.jwksUri,
    kind: row.kind,
    ...(row.kind === 'institution'
      ? {
          organizationId: row.organizationId,
          organizationName: row.organizationName,
          roleClaim: row.roleClaim,
          allowedRoles: JSON.parse(row.allowedRoles) as unknown,
        }
      : {}),
  });

  return parsed.success ? parsed.data : null;
}

/**
 * prepares the statements the directory runs
 * @param db a vault opened through `openVault`
 * @returns the prepared issuer, clinician and owner statements
 */
function prepareStatements(
  db: DatabaseSync,
): Record<
  | 'issuerQuery'
  | 'clinicianQuery'
  | 'upsertClinician'
  | 'dropRoles'
  | 'ownerQuery',
  StatementSync
> {
  const issuerQuery = db.prepare(
    `SELECT issuer, audience, allowed_algs AS allowedAlgs, jwks_uri AS jwksUri, kind,
            organization_id AS organizationId, organization_name AS organizationName,
            role_claim AS roleClaim, allowed_roles AS allowedRoles
     FROM trusted_issuers WHERE issuer = ? AND enabled = 1`,
  );
  const clinicianQuery = db.prepare(
    `SELECT issuer, subject, display_name AS displayName, organization_id AS organizationId,
            organization_name AS organizationName, roles, status, verified_at AS verifiedAt
     FROM clinicians WHERE issuer = ? AND subject = ?`,
  );
  // status is never in the update list: the patient's suspension survives
  const upsertClinician = db.prepare(
    `INSERT INTO clinicians (issuer, subject, display_name, organization_id, organization_name, roles, status, verified_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
     ON CONFLICT (issuer, subject) DO UPDATE SET
       display_name = excluded.display_name,
       organization_id = excluded.organization_id,
       organization_name = excluded.organization_name,
       roles = excluded.roles,
       verified_at = excluded.verified_at`,
  );
  // a person the institution no longer vouches for as a doctor keeps their
  // row (grants and suspension refer to it) but loses roles and organisation
  const dropRoles = db.prepare(
    `UPDATE clinicians SET roles = '[]', organization_id = NULL, organization_name = NULL, verified_at = ?
     WHERE issuer = ? AND subject = ?`,
  );
  const ownerQuery = db.prepare(
    'SELECT owner_issuer AS issuer, owner_subject AS subject FROM patient LIMIT 1',
  );

  return {
    issuerQuery,
    clinicianQuery,
    upsertClinician,
    dropRoles,
    ownerQuery,
  };
}

/**
 * builds a directory backed by the vault tables from migrations 0001 and 0009
 * @param db a vault opened through `openVault`
 * @returns a directory over trusted issuers, clinicians and the owner
 */
export function createVaultDirectory(db: DatabaseSync): IdentityDirectory {
  const {
    issuerQuery,
    clinicianQuery,
    upsertClinician,
    dropRoles,
    ownerQuery,
  } = prepareStatements(db);

  const findClinician = (
    issuer: string,
    subject: string,
  ): ClinicianEntry | null => {
    const row = clinicianQuery.get(issuer, subject) as ClinicianRow | undefined;

    if (!row) {
      return null;
    }

    // a row that does not match the contract is treated as unknown
    const parsed = clinicianEntrySchema.safeParse({
      issuer: row.issuer,
      subject: row.subject,
      displayName: row.displayName,
      organizationId: row.organizationId ?? undefined,
      organizationName: row.organizationName ?? undefined,
      roles: JSON.parse(row.roles) as unknown,
      status: row.status,
      verifiedAt: row.verifiedAt,
    });

    return parsed.success ? parsed.data : null;
  };

  return {
    /**
     * looks up an enabled trusted issuer
     * @param issuer the issuer URL
     * @returns the issuer, or null
     */
    findTrustedIssuer(issuer) {
      const row = issuerQuery.get(issuer) as IssuerRow | undefined;

      return row ? toTrustedIssuer(row) : null;
    },
    findClinician,
    /**
     * writes a verified institution sign-in into the registry
     * @param signIn the verified doctor, roles and configured organisation
     * @returns the stored entry, or null when the sign-in carried no clinical role
     */
    recordClinician(signIn) {
      const at = signIn.verifiedAt.toISOString();

      if (signIn.roles.length === 0) {
        dropRoles.run(at, signIn.issuer, signIn.subject);

        return null;
      }

      upsertClinician.run(
        signIn.issuer,
        signIn.subject,
        signIn.displayName,
        signIn.organizationId,
        signIn.organizationName,
        JSON.stringify(signIn.roles),
        at,
        at,
      );

      return findClinician(signIn.issuer, signIn.subject);
    },
    /**
     * reads the vault owner's identity
     * @returns the owner, or null before a patient exists
     */
    findPatientOwner() {
      const row = ownerQuery.get() as OwnerRow | undefined;

      return row ? { issuer: row.issuer, subject: row.subject } : null;
    },
  };
}
