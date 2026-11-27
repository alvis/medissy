/**
 * the accounts a synthetic issuer signs in and the claims it makes about
 * them; the Northgate Health institution names the person and lists their
 * roles in its role claim (ADR-9); the patient's issuer vouches for the
 * subject only
 */
import { findDemoUserBySubject } from './users';

import type { Configuration } from 'oidc-provider';

import type { DemoUser, IssuerProfile } from './users';

/**
 * builds the claims an issuer puts about a person; the institution names the
 * person and lists their roles in its role claim; the patient's issuer
 * vouches for the subject only
 * @param profile the issuer, an institution or the patient's
 * @param user the signed-in person
 * @returns `sub`, plus `name` and the role claim at an institution
 */
function accountClaims(
  profile: IssuerProfile,
  user: DemoUser,
): Record<string, unknown> {
  const { institution } = profile;

  return institution
    ? {
        sub: user.subject,
        name: user.displayName,
        [institution.roleClaim]: [...(user.roles ?? [])],
      }
    : { sub: user.subject };
}

/**
 * builds the configuration for who the issuer signs in and what it says about
 * them; the institution's ID token carries the person's name and roles; with a
 * resource-bound access token the provider puts these `openid` scope claims in
 * the ID token
 * @param profile the issuer, an institution or the patient's
 * @returns the `findAccount` and `claims` configuration
 */
export function accountConfiguration(
  profile: IssuerProfile,
): Pick<Configuration, 'findAccount' | 'claims'> {
  const { institution } = profile;

  return {
    findAccount: async (_ctx, sub) => {
      const user = findDemoUserBySubject(profile, sub);

      return user
        ? {
            accountId: user.subject,
            claims: async () => accountClaims(profile, user),
          }
        : undefined;
    },
    claims: {
      openid: institution ? ['sub', 'name', institution.roleClaim] : ['sub'],
    },
  };
}
