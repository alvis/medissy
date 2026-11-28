import { z } from 'zod';

import {
  issuerSchema,
  organizationIdSchema,
  roleSchema,
  subjectSchema,
  timestampSchema,
  LIMITS,
} from './common';

/**
 * the caller as the server derived it from a verified sign-in (brief §5); an
 * access token alone yields identity and scopes; organisation and roles are
 * set only by a verified institution sign-in (ADR-9): roles from the ID
 * token's allowlisted role claim, the organisation from the issuer config; it
 * is never built from message text, a caller-supplied role or an unverified
 * claim
 */
export const principalSchema = z.strictObject({
  issuer: issuerSchema,
  subject: subjectSchema,
  audience: z
    .array(z.string().min(1).max(LIMITS.url))
    .min(1)
    .max(LIMITS.listTiny),
  scopes: z.array(z.string().min(1).max(LIMITS.id)).max(LIMITS.listMedium),
  organizationId: organizationIdSchema.optional(),
  roles: z.array(roleSchema).max(LIMITS.listSmall),
  clientId: z.string().min(1).max(LIMITS.scalar).optional(),
});
export type Principal = z.infer<typeof principalSchema>;

/**
 * a clinician registry entry (server-managed, keyed by issuer and subject),
 * recorded just in time at each verified institution sign-in (ADR-9): roles
 * from the institution's allowlisted ID token claim, organisation from its
 * issuer config, never from other token claims; only an `active` clinician
 * with a role may release records; `suspended` (the patient's kill switch,
 * never touched by a sign-in) releases nothing
 */
export const clinicianEntrySchema = z.strictObject({
  issuer: issuerSchema,
  subject: subjectSchema,
  displayName: z.string().min(1).max(LIMITS.title),
  organizationId: organizationIdSchema.optional(),
  organizationName: z.string().min(1).max(LIMITS.title).optional(),
  roles: z.array(roleSchema).max(LIMITS.listSmall),
  status: z.enum(['active', 'suspended']),
  verifiedAt: timestampSchema,
});
export type ClinicianEntry = z.infer<typeof clinicianEntrySchema>;
