/**
 * the synthetic people and the two synthetic issuers that sign them in;
 * nobody here is real; the patient's own issuer at `/demo-idp` signs in the
 * vault owner; the synthetic hospital "Northgate Health" at
 * `/institution-idp` signs in its staff and names their roles in the ID
 * token (ADR-9); production swaps both for external IdPs (ADR-3)
 */
import { SCOPE_OWNER, SCOPE_REQUEST } from '../contracts';

/** one synthetic account an issuer can authenticate */
export interface DemoUser {
  /** stable key used in forms and in `DEMO_IDP_SECRET_<KEY>` */
  key: string;
  /** OIDC subject; opaque and stable */
  subject: string;
  displayName: string;
  /** what the person is, for the sign-in page only */
  description: string;
  /** resource scopes this account may be granted; anything else is rejected */
  allowedScopes: readonly string[];
  /** roles the institution puts in the ID token; absent at the patient issuer */
  roles?: readonly string[];
}

/** the organisation an institution issuer vouches for, as Medissy trusts it */
export interface InstitutionTrust {
  organizationId: string;
  organizationName: string;
  /** the ID token claim holding the person's roles */
  roleClaim: string;
  /** roles Medissy accepts as clinical from this institution */
  allowedRoles: readonly string[];
}

/** one synthetic issuer: where it is mounted, who it signs in, how it is trusted */
export interface IssuerProfile {
  /** path the issuer is mounted on, e.g. `/demo-idp` */
  mount: string;
  /** banner shown on every page of this issuer */
  label: string;
  /** label of the `trusted_issuers` row Medissy writes for it */
  trustLabel: string;
  /** row id of its signing key in `idp_store`; one key per issuer */
  signingKeyId: string;
  /** names of the issuer's own cookies, distinct per issuer */
  cookieNames: { session: string; interaction: string; resume: string };
  /** resource scopes this issuer can grant for Medissy */
  resourceScopes: readonly string[];
  users: readonly DemoUser[];
  /** present for a hospital: the organisation Medissy trusts it for */
  institution?: InstitutionTrust;
}

export const DEMO_OWNER: DemoUser = {
  key: 'owner',
  subject: 'synthetic-owner-morgan-testwell',
  displayName: 'Morgan Testwell (SYNTHETIC patient)',
  description: 'The patient who owns this Medissy vault',
  allowedScopes: [SCOPE_OWNER],
};

export const DEMO_CARDIOLOGIST: DemoUser = {
  key: 'cardiologist',
  subject: 'synthetic-clinician-ada-northgate',
  displayName: 'Dr Ada Northgate (SYNTHETIC cardiologist)',
  description: 'Cardiologist at Northgate Health',
  allowedScopes: [SCOPE_REQUEST],
  roles: ['cardiologist'],
};

export const DEMO_DENTIST: DemoUser = {
  key: 'dentist',
  subject: 'synthetic-clinician-ravi-riverside',
  displayName: 'Dr Ravi Riverside (SYNTHETIC dentist)',
  description: 'Dentist at Northgate Health',
  allowedScopes: [SCOPE_REQUEST],
  roles: ['dentist'],
};

/**
 * Northgate staff with no clinical role; the hospital vouches for them, but
 * not as a doctor, so Medissy treats them as an unknown clinician
 */
export const DEMO_UNKNOWN_CLINICIAN: DemoUser = {
  key: 'unknown-clinician',
  subject: 'synthetic-clinician-unregistered',
  displayName: 'Sam Elsewhere (SYNTHETIC administrator)',
  description: 'Northgate Health staff with no clinical role',
  allowedScopes: [SCOPE_REQUEST],
  roles: ['administrator'],
};

/** the patient's own issuer: signs in the vault owner only */
export const PATIENT_ISSUER: IssuerProfile = {
  mount: '/demo-idp',
  label: 'SYNTHETIC DEMO — not a real identity provider',
  trustLabel: 'SYNTHETIC demo IdP',
  signingKeyId: 'es256',
  cookieNames: {
    session: '_session',
    interaction: '_interaction',
    resume: '_interaction_resume',
  },
  resourceScopes: [SCOPE_OWNER],
  users: [DEMO_OWNER],
};

/** the synthetic hospital: signs in its staff and names their roles */
export const INSTITUTION_ISSUER: IssuerProfile = {
  mount: '/institution-idp',
  label: 'SYNTHETIC Northgate Health — not a real hospital sign-in',
  trustLabel: 'SYNTHETIC Northgate Health',
  signingKeyId: 'es256-institution',
  cookieNames: {
    session: '_northgate_session',
    interaction: '_northgate_interaction',
    resume: '_northgate_interaction_resume',
  },
  resourceScopes: [SCOPE_REQUEST],
  users: [DEMO_CARDIOLOGIST, DEMO_DENTIST, DEMO_UNKNOWN_CLINICIAN],
  institution: {
    organizationId: 'org-northgate-health',
    organizationName: 'Northgate Health (SYNTHETIC)',
    roleClaim: 'roles',
    allowedRoles: ['cardiologist', 'dentist'],
  },
};

/** both synthetic issuers, the patient's first */
export const ISSUER_PROFILES: readonly IssuerProfile[] = [
  PATIENT_ISSUER,
  INSTITUTION_ISSUER,
];

/** every synthetic account across both issuers */
export const DEMO_USERS: readonly DemoUser[] = ISSUER_PROFILES.flatMap(
  (profile) => profile.users,
);

/**
 * finds one of an issuer's synthetic users by form key
 * @param profile the issuer whose accounts are searched
 * @param key the form key
 * @returns the user, or undefined for anything this issuer does not hold
 */
export function findDemoUserByKey(
  profile: IssuerProfile,
  key: string,
): DemoUser | undefined {
  return profile.users.find((user) => user.key === key);
}

/**
 * finds one of an issuer's synthetic users by subject
 * @param profile the issuer whose accounts are searched
 * @param subject the OIDC subject
 * @returns the user, or undefined for anything this issuer does not hold
 */
export function findDemoUserBySubject(
  profile: IssuerProfile,
  subject: string,
): DemoUser | undefined {
  return profile.users.find((user) => user.subject === subject);
}

/**
 * builds the issuer URL of a profile at a public origin
 * @param origin Medissy's public origin, without a trailing slash
 * @param profile which synthetic issuer, by its mount
 * @returns e.g. `https://medissy.example/institution-idp`
 */
export function issuerUrl(origin: string, profile: IssuerProfile): string {
  return `${origin}${profile.mount}`;
}
