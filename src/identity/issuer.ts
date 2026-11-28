/**
 * how Medissy reaches an OIDC issuer; Medissy talks to two: the patient's
 * own issuer (the demo IdP at `/demo-idp`) for the vault owner, and one
 * trusted institution (the synthetic Northgate Health issuer at
 * `/institution-idp`) for doctors (ADR-9); production points the same fields
 * at external IdPs (ADR-3), and nothing else in Medissy changes
 */
import type { JWTVerifyGetKey } from 'jose';

import type { TrustedIssuer } from '../contracts';

export type { TrustedIssuer };

/** endpoints and public client ids Medissy uses at one issuer */
export interface IssuerConnection {
  /** the `iss` value tokens from this issuer carry */
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  deviceAuthorizationEndpoint: string;
  /** public PKCE client for browser sign-in (no client secret) */
  portalClientId: string;
  /** public client for the in-task device flow (no client secret) */
  agentClientId: string;
}

/** chooses the verification key set for a trusted issuer */
export type KeyResolver = (
  issuer: TrustedIssuer,
) => JWTVerifyGetKey | undefined;

/** the HTTP client used to call issuer endpoints (injectable for tests) */
export type Fetch = typeof globalThis.fetch;
