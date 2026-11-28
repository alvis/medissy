/**
 * access-token checks shared by every verification (A02): find the trusted
 * issuer a token claims, resolve its keys, and verify an RFC 9068 `at+jwt`
 * into an identity-only principal; organisation and roles are never read
 * here; only a verified institution sign-in sets them (ADR-9)
 */
import { createRemoteJWKSet, decodeJwt, errors, jwtVerify } from 'jose';

import { principalSchema } from '../contracts';

import type { JWTPayload, JWTVerifyGetKey } from 'jose';

import type { ClinicianEntry, Principal } from '../contracts';

import type { IdentityDirectory } from './directory';
import type { KeyResolver, TrustedIssuer } from './issuer';

export const MS_PER_SECOND = 1000;

/** upper bound on a token's length; anything longer is rejected */
const MAX_TOKEN_CHARS = 8192;
export const ACCESS_TOKEN_TYPE = 'at+jwt';

/** why a token was rejected; never includes the token itself */
export type VerifyFailure =
  | 'malformed'
  | 'untrusted-issuer'
  | 'no-keys'
  | 'bad-signature'
  | 'bad-algorithm'
  | 'wrong-type'
  | 'wrong-issuer'
  | 'wrong-audience'
  | 'expired'
  | 'invalid-claims'
  | 'no-end-user'
  | 'missing-scope'
  /** a clinician sign-in from an issuer that is not a trusted institution */
  | 'not-institution'
  /** a clinician sign-in without an ID token */
  | 'missing-id-token'
  /** the ID token names another issuer or subject than the access token */
  | 'id-token-mismatch'
  /** the role claim is not a short list of short strings */
  | 'invalid-roles';

/** outcome of `verify` */
export type VerifyResult =
  | {
      ok: true;
      principal: Principal;
      /** the registry entry, or null for a verified but unknown clinician */
      clinician: ClinicianEntry | null;
      /** token expiry; sessions never outlive it */
      expiresAt: Date;
      /** when the person authenticated, from a verified ID token */
      authTime?: Date;
    }
  | { ok: false; reason: VerifyFailure };

/** verification state shared by the verifier's methods */
export interface VerifierState {
  directory: IdentityDirectory;
  keysFor: KeyLookup;
  now: () => Date;
}

/** resolves the key set of a trusted issuer */
export type KeyLookup = (trusted: TrustedIssuer) => JWTVerifyGetKey | undefined;

/**
 * translates a jose error into a rejection reason
 * @param error what jwtVerify threw
 * @returns the matching rejection reason
 */
export function reasonFor(error: unknown): VerifyFailure {
  if (error instanceof errors.JWTExpired) {
    return 'expired';
  }

  if (error instanceof errors.JWTClaimValidationFailed) {
    switch (error.claim) {
      case 'typ':
        return 'wrong-type';
      case 'iss':
        return 'wrong-issuer';
      case 'aud':
        return 'wrong-audience';
      default:
        return 'invalid-claims';
    }
  }

  if (
    error instanceof errors.JWSSignatureVerificationFailed ||
    error instanceof errors.JWKSNoMatchingKey ||
    error instanceof errors.JWKSMultipleMatchingKeys
  ) {
    return 'bad-signature';
  }

  if (error instanceof errors.JOSEAlgNotAllowed) {
    return 'bad-algorithm';
  }

  return 'malformed';
}

/**
 * reads the space-separated `scope` claim
 * @param scope the claim value
 * @returns the scopes, empty when absent or not a string
 */
function scopesOf(scope: unknown): string[] {
  return typeof scope === 'string' ? scope.split(' ').filter(Boolean) : [];
}

/**
 * resolves key sets per trusted issuer: the configured resolver first, then
 * the issuer's remote `jwks_uri` (cached per issuer)
 * @param keys the configured resolver
 * @returns a function resolving the keys of a trusted issuer
 */
export function keyLookup(keys: KeyResolver | undefined): KeyLookup {
  const remote = new Map<string, JWTVerifyGetKey>();

  return (trusted) => {
    const resolved = keys?.(trusted);

    if (resolved || !trusted.jwksUri) {
      return resolved;
    }

    const cached =
      remote.get(trusted.issuer) ??
      createRemoteJWKSet(new URL(trusted.jwksUri));

    remote.set(trusted.issuer, cached);

    return cached;
  };
}

/**
 * finds the trusted issuer a token claims, before any signature check
 * @param token the compact JWS
 * @param directory the vault directory
 * @returns the issuer, or the rejection reason
 */
export function claimedIssuer(
  token: string,
  directory: IdentityDirectory,
): TrustedIssuer | VerifyFailure {
  if (token.length === 0 || token.length > MAX_TOKEN_CHARS) {
    return 'malformed';
  }

  let iss: unknown;

  try {
    iss = decodeJwt(token).iss;
  } catch {
    return 'malformed';
  }

  return (
    (typeof iss === 'string' ? directory.findTrustedIssuer(iss) : null) ??
    'untrusted-issuer'
  );
}

/**
 * builds the identity-only result from a verified access token payload
 * @param payload the verified claims
 * @param trusted the issuer
 * @param requiredScope the scope the token must carry
 * @returns the principal, or the rejection reason
 */
function toResult(
  payload: JWTPayload,
  trusted: TrustedIssuer,
  requiredScope: string,
): VerifyResult {
  const subject = payload.sub ?? '';
  const clientId =
    typeof payload.client_id === 'string' ? payload.client_id : undefined;

  // a token whose subject is its own client was minted without a person
  if (!clientId || subject === clientId) {
    return { ok: false, reason: 'no-end-user' };
  }

  const scopes = scopesOf(payload.scope);

  if (!scopes.includes(requiredScope)) {
    return { ok: false, reason: 'missing-scope' };
  }

  const parsed = principalSchema.safeParse({
    issuer: trusted.issuer,
    subject,
    audience:
      typeof payload.aud === 'string' ? [payload.aud] : (payload.aud ?? []),
    scopes,
    roles: [],
    clientId,
  });

  return parsed.success
    ? {
        ok: true,
        principal: parsed.data,
        clinician: null,
        expiresAt: new Date((payload.exp ?? 0) * MS_PER_SECOND),
      }
    : { ok: false, reason: 'invalid-claims' };
}

/**
 * finds the issuer a token claims and the keys to check it with
 * @param token the compact JWT
 * @param directory the vault directory
 * @param keysFor the key lookup per trusted issuer
 * @returns the issuer and keys, or the reason to reject the token
 */
export function trustedKeys(
  token: string,
  directory: IdentityDirectory,
  keysFor: ReturnType<typeof keyLookup>,
):
  | {
      trusted: TrustedIssuer;
      keys: NonNullable<ReturnType<ReturnType<typeof keyLookup>>>;
    }
  | { reason: VerifyFailure } {
  const trusted = claimedIssuer(token, directory);

  if (typeof trusted === 'string') {
    return { reason: trusted };
  }

  const keys = keysFor(trusted);

  return keys ? { trusted, keys } : { reason: 'no-keys' };
}

/**
 * verifies an access token against the trusted issuers
 * @param state directory, key lookup and clock
 * @param token the compact JWT
 * @param requiredScope the scope the token must carry
 * @returns the identity-only principal, or the rejection reason
 */
export async function verifyAccessToken(
  state: VerifierState,
  token: string,
  requiredScope: string,
): Promise<VerifyResult> {
  const source = trustedKeys(token, state.directory, state.keysFor);

  if ('reason' in source) {
    return { ok: false, reason: source.reason };
  }

  const { trusted, keys } = source;

  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer: trusted.issuer,
      audience: trusted.audience,
      typ: ACCESS_TOKEN_TYPE,
      algorithms: trusted.allowedAlgs,
      currentDate: state.now(),
      requiredClaims: ['sub', 'exp', 'iat', 'jti', 'client_id'],
    });

    return toResult(payload, trusted, requiredScope);
  } catch (error) {
    return { ok: false, reason: reasonFor(error) };
  }
}
