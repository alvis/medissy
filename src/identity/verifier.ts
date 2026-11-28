/**
 * token verification (A02); an access token is accepted only when it is an
 * RFC 9068 `at+jwt` from an enabled trusted issuer, signed with an allowed
 * algorithm by that issuer's key, names the issuer's configured audience, is
 * unexpired at the injected clock, names a signed-in person (not just a
 * client, as a client-credentials token would), and carries the required
 * scope; an access token alone proves who someone is, never what they are
 *
 * a doctor is established only by `verifyClinician` (ADR-9): a verified access
 * token AND a verified ID token from the same enabled `institution` issuer for
 * the same subject; roles are the ID token's configured role claim
 * intersected with the issuer's allowed roles; the organisation is the
 * issuer's configured one, never a token claim; the sign-in is then recorded
 * just in time in the clinician registry, which policy reads
 */
import { jwtVerify } from 'jose';

import {
  keyLookup,
  MS_PER_SECOND,
  reasonFor,
  trustedKeys,
  verifyAccessToken,
} from './access-token';
import { verifyClinicianSignIn } from './institution-sign-in';

import type { JWTPayload } from 'jose';

import type {
  VerifierState,
  VerifyFailure,
  VerifyResult,
} from './access-token';
import type { IdentityDirectory } from './directory';
import type { ClinicianExpectation, IssuedTokens } from './institution-sign-in';
import type { KeyResolver, TrustedIssuer } from './issuer';

export type { VerifyFailure, VerifyResult } from './access-token';
export type { ClinicianExpectation, IssuedTokens } from './institution-sign-in';

/** outcome of `verifyIdToken`: the person and when they authenticated */
export type IdTokenResult =
  | { ok: true; issuer: string; subject: string; authTime: Date }
  | { ok: false; reason: VerifyFailure };

/** verifies bearer access tokens and clinician sign-ins */
export interface AccessTokenVerifier {
  /**
   * verifies an access token from any trusted issuer; the principal carries
   * identity and scopes only: no organisation, no roles, no registry entry
   */
  verify(token: string, requiredScope: string): Promise<VerifyResult>;
  /**
   * verifies a doctor's sign-in at the trusted institution (ADR-9) and records
   * it in the clinician registry; a person with no allowlisted role is
   * verified but unknown: no organisation, no roles, a null entry
   */
  verifyClinician(
    tokens: IssuedTokens,
    expected: ClinicianExpectation,
  ): Promise<VerifyResult>;
  /**
   * verifies an ID token from the browser sign-in: trusted issuer and key,
   * audience the portal client, the sign-in's nonce, and an `auth_time`;
   * the token is verified and dropped, never stored
   */
  verifyIdToken?(
    token: string,
    expected: { clientId: string; nonce: string },
  ): Promise<IdTokenResult>;
}

/** options for `createAccessTokenVerifier` */
export interface VerifierOptions {
  directory: IdentityDirectory;
  /** key set per issuer; defaults to the issuer's remote `jwks_uri` */
  keys?: KeyResolver;
  /** clock for expiry checks */
  now?: () => Date;
}

/**
 * builds the result from a verified ID token payload
 * @param payload the verified claims
 * @param trusted the issuer that signed it
 * @param nonce the nonce the sign-in started with
 * @returns the subject and sign-in time, or the rejection reason
 */
function toIdTokenResult(
  payload: JWTPayload,
  trusted: TrustedIssuer,
  nonce: string,
): IdTokenResult {
  const authTime = payload.auth_time;

  if (payload.nonce !== nonce || typeof authTime !== 'number' || !payload.sub) {
    return { ok: false, reason: 'invalid-claims' };
  }

  return {
    ok: true,
    issuer: trusted.issuer,
    subject: payload.sub,
    authTime: new Date(authTime * MS_PER_SECOND),
  };
}

/**
 * builds a verifier over the vault's trusted issuers and clinician registry
 * @param options directory, key resolution and clock
 * @returns a verifier for access tokens and ID tokens
 */
export function createAccessTokenVerifier(
  options: VerifierOptions,
): AccessTokenVerifier {
  const now = options.now ?? (() => new Date());
  const keysFor = keyLookup(options.keys);
  const state: VerifierState = { directory: options.directory, keysFor, now };

  return {
    /**
     * verifies an access token against the trusted issuers
     * @param token the compact JWT
     * @param requiredScope the scope the token must carry
     * @returns the identity-only principal, or the rejection reason
     */
    async verify(token, requiredScope) {
      return verifyAccessToken(state, token, requiredScope);
    },
    /**
     * verifies a doctor's institution sign-in and records it in the registry
     * @param tokens the access and ID tokens of the sign-in
     * @param expected the scope, client and nonce
     * @returns the principal with configured organisation and allowlisted roles, or the
     * rejection reason
     */
    async verifyClinician(tokens, expected) {
      return verifyClinicianSignIn(state, tokens, expected);
    },
    /**
     * verifies an ID token for the given client and nonce
     * @param token the compact JWT
     * @param expected the client and nonce the token must match
     * @returns the verified principal, or the rejection reason
     */
    async verifyIdToken(token, expected) {
      const source = trustedKeys(token, options.directory, keysFor);

      if ('reason' in source) {
        return { ok: false, reason: source.reason };
      }

      const { trusted, keys } = source;

      try {
        const { payload } = await jwtVerify(token, keys, {
          issuer: trusted.issuer,
          audience: expected.clientId,
          algorithms: trusted.allowedAlgs,
          currentDate: now(),
          requiredClaims: ['sub', 'exp', 'iat', 'nonce', 'auth_time'],
        });

        return toIdTokenResult(payload, trusted, expected.nonce);
      } catch (error) {
        return { ok: false, reason: reasonFor(error) };
      }
    },
  };
}
