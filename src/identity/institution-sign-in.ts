/**
 * a doctor's sign-in at the trusted institution (ADR-9): a verified access
 * token AND a verified ID token from the same enabled `institution` issuer for
 * the same subject; roles are the ID token's configured role claim, shape-
 * and length-checked, intersected with the issuer's allowed roles; the
 * organisation is the issuer's configured one, never a token claim; the
 * sign-in is recorded just in time in the clinician registry
 */
import { jwtVerify } from 'jose';

import { LIMITS } from '../contracts';

import {
  ACCESS_TOKEN_TYPE,
  claimedIssuer,
  MS_PER_SECOND,
  reasonFor,
  verifyAccessToken,
} from './access-token';

import type { JWTPayload } from 'jose';

import type {
  VerifierState,
  VerifyFailure,
  VerifyResult,
} from './access-token';
import type { TrustedIssuer } from './issuer';

/** media-type prefix a JOSE `typ` may carry (RFC 7515 §4.1.9) */
const MEDIA_TYPE_PREFIX = /^application\//u;
/** most entries a role claim may hold; a longer claim is rejected outright */
const MAX_ROLE_CLAIM_ENTRIES = LIMITS.listMedium;
/** longest single role value accepted in a role claim */
const MAX_ROLE_CHARS = LIMITS.name;
/** longest display name kept from an ID token's `name` claim */
const MAX_DISPLAY_NAME_CHARS = LIMITS.title;

/** the tokens an issuer returned for one sign-in; verified, then dropped */
export interface IssuedTokens {
  accessToken: string;
  idToken?: string;
}

/** what a clinician sign-in must match */
export interface ClinicianExpectation {
  /** the scope the access token must carry */
  scope: string;
  /** the client the ID token was issued to (its audience) */
  clientId: string;
  /** the browser sign-in's nonce; a device sign-in has none */
  nonce?: string;
}

/**
 * reads a role claim: absent means no roles; anything but a short list of
 * short strings is rejected, never truncated or coerced
 * @param value the claim value
 * @returns the claimed roles, or undefined for a malformed claim
 */
function claimedRoles(value: unknown): readonly string[] | undefined {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || value.length > MAX_ROLE_CLAIM_ENTRIES) {
    return undefined;
  }

  const roles = value.filter(
    (role): role is string =>
      typeof role === 'string' &&
      role.length > 0 &&
      role.length <= MAX_ROLE_CHARS,
  );

  return roles.length === value.length ? roles : undefined;
}

/**
 * returns the clinical roles of a sign-in: claimed roles the institution is trusted
 * for, each once, in the institution's order
 * @param claimed the roles from the ID token
 * @param allowed the issuer's allowed roles
 * @returns the intersection
 */
function clinicalRoles(
  claimed: readonly string[],
  allowed: readonly string[],
): string[] {
  return allowed.filter((role) => claimed.includes(role));
}

/**
 * derives a display name from the ID token's `name` claim: control and format
 * characters removed, whitespace collapsed, length capped; the subject when
 * nothing printable is left
 * @param name the claim value
 * @param subject the verified subject
 * @returns the name to show
 */
function displayNameOf(name: unknown, subject: string): string {
  const cleaned =
    typeof name === 'string'
      ? name
          .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
          .replace(/\s+/gu, ' ')
          .trim()
      : '';

  return (cleaned || subject).slice(0, MAX_DISPLAY_NAME_CHARS);
}

/**
 * verifies an institution's ID token for the subject its access token named:
 * same issuer and keys, audience the expected client, the nonce when the
 * sign-in had one, and never an access token in its place
 * @param state directory, key lookup and clock
 * @param input the token, the issuer and subject it must name, the expectation
 * @param input.idToken the compact JWT
 * @param input.trusted the institution that issued the access token
 * @param input.subject the access token's subject
 * @param input.expected the client and nonce
 * @returns the verified claims, or the rejection reason
 */
async function verifyInstitutionIdToken(
  state: VerifierState,
  input: {
    idToken: string;
    trusted: TrustedIssuer;
    subject: string;
    expected: ClinicianExpectation;
  },
): Promise<JWTPayload | VerifyFailure> {
  const { idToken, trusted, subject, expected } = input;
  const claimed = claimedIssuer(idToken, state.directory);

  if (typeof claimed === 'string') {
    return claimed;
  }

  if (claimed.issuer !== trusted.issuer) {
    return 'id-token-mismatch';
  }

  const keys = state.keysFor(trusted);

  if (!keys) {
    return 'no-keys';
  }

  try {
    const { payload, protectedHeader } = await jwtVerify(idToken, keys, {
      issuer: trusted.issuer,
      audience: expected.clientId,
      algorithms: trusted.allowedAlgs,
      currentDate: state.now(),
      requiredClaims: ['sub', 'exp', 'iat'],
    });

    const typ = protectedHeader.typ
      ?.toLowerCase()
      .replace(MEDIA_TYPE_PREFIX, '');

    if (typ === ACCESS_TOKEN_TYPE) {
      return 'wrong-type';
    }

    if (payload.sub !== subject) {
      return 'id-token-mismatch';
    }

    if (expected.nonce !== undefined && payload.nonce !== expected.nonce) {
      return 'invalid-claims';
    }

    return payload;
  } catch (error) {
    return reasonFor(error);
  }
}

/**
 * verifies a clinician sign-in and records it in the registry
 * @param state directory, key lookup and clock
 * @param tokens the access and ID tokens of the sign-in
 * @param expected the scope, client and nonce
 * @returns the principal with configured organisation and allowlisted roles, or the
 * rejection reason
 */
export async function verifyClinicianSignIn(
  state: VerifierState,
  tokens: IssuedTokens,
  expected: ClinicianExpectation,
): Promise<VerifyResult> {
  const access = await verifyAccessToken(
    state,
    tokens.accessToken,
    expected.scope,
  );

  if (!access.ok) {
    return access;
  }

  const { principal } = access;
  const trusted = state.directory.findTrustedIssuer(principal.issuer);

  if (trusted?.kind !== 'institution') {
    return { ok: false, reason: 'not-institution' };
  }

  if (!tokens.idToken) {
    return { ok: false, reason: 'missing-id-token' };
  }

  const claims = await verifyInstitutionIdToken(state, {
    idToken: tokens.idToken,
    trusted,
    subject: principal.subject,
    expected,
  });

  if (typeof claims === 'string') {
    return { ok: false, reason: claims };
  }

  const claimed = claimedRoles(claims[trusted.roleClaim]);
  const roles = claimed ? clinicalRoles(claimed, trusted.allowedRoles) : [];
  // organisation from the issuer row; any organisation claim is ignored
  const clinician = state.directory.recordClinician({
    issuer: trusted.issuer,
    subject: principal.subject,
    displayName: displayNameOf(claims.name, principal.subject),
    organizationId: trusted.organizationId,
    organizationName: trusted.organizationName,
    roles,
    verifiedAt: state.now(),
  });

  // a malformed role claim fails the sign-in, after dropping any old roles
  if (!claimed) {
    return { ok: false, reason: 'invalid-roles' };
  }

  const authTime =
    typeof claims.auth_time === 'number'
      ? new Date(claims.auth_time * MS_PER_SECOND)
      : undefined;

  return {
    ...access,
    principal: {
      ...principal,
      ...(clinician ? { organizationId: clinician.organizationId } : {}),
      roles: clinician ? [...clinician.roles] : [],
    },
    clinician,
    ...(authTime ? { authTime } : {}),
  };
}
