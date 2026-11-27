import { z } from 'zod';

import {
  issuerSchema,
  organizationIdSchema,
  roleSchema,
  LIMITS,
} from './common';

/** what every trusted issuer row configures, whatever it vouches for */
const trustedIssuerBase = {
  issuer: issuerSchema,
  /** the audience (resource) access tokens from this issuer must name */
  audience: z.string().min(1).max(LIMITS.url),
  /** JWS algorithms accepted from this issuer */
  allowedAlgs: z
    .array(z.string().min(1).max(LIMITS.name))
    .min(1)
    .max(LIMITS.listTiny),
  jwksUri: z.string().min(1).max(LIMITS.url).nullable(),
};

/**
 * an enabled trusted issuer as Medissy configures it in `trusted_issuers`
 * (migration 0009, ADR-9); a `patient` issuer signs in the vault owner and
 * vouches for nothing else; an `institution` issuer vouches for its staff: a
 * person it signs in with an allowlisted clinical role in `roleClaim` of the
 * ID token counts as a doctor of `organizationId`; the organisation always
 * comes from this configuration, never from a token claim
 */
export const trustedIssuerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...trustedIssuerBase, kind: z.literal('patient') }),
  z.strictObject({
    ...trustedIssuerBase,
    kind: z.literal('institution'),
    organizationId: organizationIdSchema,
    organizationName: z.string().min(1).max(LIMITS.title),
    /** the ID token claim holding the person's roles at the institution */
    roleClaim: z.string().min(1).max(LIMITS.name),
    /** the clinical roles Medissy accepts from this institution */
    allowedRoles: z.array(roleSchema).min(1).max(LIMITS.listSmall),
  }),
]);
export type TrustedIssuer = z.infer<typeof trustedIssuerSchema>;
