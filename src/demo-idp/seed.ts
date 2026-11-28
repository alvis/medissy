/**
 * register both synthetic issuers as trusted: the patient's own issuer
 * (`kind = 'patient'`, vouches for the vault owner only) and the Northgate
 * Health institution (`kind = 'institution'`, ADR-9) with the organisation,
 * role claim and allowed roles Medissy trusts it for; no clinician is seeded:
 * the registry is written just in time at each verified institution sign-in;
 * a synthetic issuer left over from an earlier public URL is disabled, so its
 * tokens stop verifying
 */
import {
  INSTITUTION_ISSUER,
  ISSUER_PROFILES,
  issuerUrl,
  PATIENT_ISSUER,
} from './users';

import type { DatabaseSync } from 'node:sqlite';

import type { IssuerProfile } from './users';

/** label of the patient issuer's trusted-issuer row */
export const DEMO_ISSUER_LABEL = PATIENT_ISSUER.trustLabel;

/** label of the institution's trusted-issuer row */
export const INSTITUTION_ISSUER_LABEL = INSTITUTION_ISSUER.trustLabel;

/** what `ensureDemoTrust` writes */
export interface DemoTrustOptions {
  /** Medissy's public origin; each issuer lives under its mount there */
  publicUrl: string;
  /** the audience access tokens must name; the origin by default */
  audience?: string;
  now?: () => Date;
}

/** the kind-specific columns of one issuer row */
interface KindColumns {
  kind: 'patient' | 'institution';
  organizationId: string | null;
  organizationName: string | null;
  roleClaim: string | null;
  allowedRoles: string;
}

/**
 * builds the kind-specific columns for a profile
 * @param profile the synthetic issuer
 * @returns its kind and, for an institution, the organisation and roles
 */
function kindColumns(profile: IssuerProfile): KindColumns {
  const { institution } = profile;

  return institution
    ? {
        kind: 'institution',
        organizationId: institution.organizationId,
        organizationName: institution.organizationName,
        roleClaim: institution.roleClaim,
        allowedRoles: JSON.stringify(institution.allowedRoles),
      }
    : {
        kind: 'patient',
        organizationId: null,
        organizationName: null,
        roleClaim: null,
        allowedRoles: '[]',
      };
}

/**
 * inserts both trusted issuers unless they already exist; existing rows are
 * left unchanged, so an operator's `enabled = 0` stays
 * @param db a vault opened through `openVault`
 * @param options public URL, audience and clock
 */
export function ensureDemoTrust(
  db: DatabaseSync,
  options: DemoTrustOptions,
): void {
  const at = (options.now ?? (() => new Date()))().toISOString();
  const origin = options.publicUrl.replace(/\/$/, '');
  const audience = options.audience ?? origin;
  const disableStale = db.prepare(
    'UPDATE trusted_issuers SET enabled = 0 WHERE label = ? AND issuer <> ? AND enabled = 1',
  );
  const insert = db.prepare(
    `INSERT INTO trusted_issuers (issuer, label, audience, allowed_algs, jwks_uri, enabled, created_at,
                                  kind, organization_id, organization_name, role_claim, allowed_roles)
     VALUES (?, ?, ?, '["ES256"]', ?, 1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (issuer) DO NOTHING`,
  );

  for (const profile of ISSUER_PROFILES) {
    const issuer = issuerUrl(origin, profile);
    const columns = kindColumns(profile);

    // first, so at most one institution is ever enabled
    disableStale.run(profile.trustLabel, issuer);
    insert.run(
      issuer,
      profile.trustLabel,
      audience,
      `${issuer}/jwks`,
      at,
      columns.kind,
      columns.organizationId,
      columns.organizationName,
      columns.roleClaim,
      columns.allowedRoles,
    );
  }
}
