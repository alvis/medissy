import { z } from 'zod';

import {
  grantableCategorySchema,
  idSchema,
  personRefSchema,
  sha256Schema,
  timestampSchema,
  LIMITS,
} from './common';

/**
 * a single-use share invitation (QR or link); only the SHA-256 of the random
 * token is stored; the token itself is shown once; the URL is a locator, never
 * a credential: consuming it only opens a pending connection
 */
export const invitationSchema = z
  .strictObject({
    id: idSchema,
    patientId: idSchema,
    tokenHash: sha256Schema,
    label: z.string().min(1).max(LIMITS.label).optional(),
    status: z.enum(['open', 'consumed', 'revoked']),
    createdAt: timestampSchema,
    expiresAt: timestampSchema,
    consumedAt: timestampSchema.optional(),
    consumedBy: personRefSchema.optional(),
  })
  .superRefine((invitation, context) => {
    const consumed = invitation.status === 'consumed';

    if (
      consumed !==
      (invitation.consumedAt !== undefined &&
        invitation.consumedBy !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message:
          'a consumed invitation needs consumedAt and consumedBy, and only then',
      });
    }

    if (Date.parse(invitation.createdAt) >= Date.parse(invitation.expiresAt)) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'expiresAt must be after createdAt',
      });
    }
  });
export type Invitation = z.infer<typeof invitationSchema>;

/**
 * a connection opened by consuming an invitation: pending until the owner
 * confirms or declines it; display fields are what the requester stated and
 * are untrusted
 */
export const connectionSchema = z
  .strictObject({
    id: idSchema,
    patientId: idSchema,
    invitationId: idSchema,
    requester: personRefSchema,
    statedName: z.string().min(1).max(LIMITS.title).optional(),
    statedOrganization: z.string().min(1).max(LIMITS.title).optional(),
    statedRole: z.string().min(1).max(LIMITS.name).optional(),
    // `ended`: a confirmed connection whose last live grant was revoked
    status: z.enum(['pending', 'confirmed', 'declined', 'ended']),
    createdAt: timestampSchema,
    decidedAt: timestampSchema.optional(),
  })
  .superRefine((connection, context) => {
    if (
      (connection.status === 'pending') !==
      (connection.decidedAt === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['decidedAt'],
        message: 'decidedAt is set exactly when the connection is decided',
      });
    }
  });
export type Connection = z.infer<typeof connectionSchema>;

/**
 * a clinician's request to widen scope; nothing is released until the owner
 * approves an explicit grant; `reason` is untrusted text
 */
export const scopeRequestSchema = z
  .strictObject({
    id: idSchema,
    /** idempotency key chosen by the requester, unique per requester */
    requestId: idSchema,
    patientId: idSchema,
    requester: personRefSchema,
    encounterId: idSchema,
    requestedCategories: z
      .array(grantableCategorySchema)
      .min(1)
      .max(LIMITS.listSmall),
    reason: z.string().max(LIMITS.paragraph),
    desiredExpiresAt: timestampSchema,
    status: z.enum(['pending', 'approved', 'declined', 'expired', 'cancelled']),
    createdAt: timestampSchema,
    decidedAt: timestampSchema.optional(),
    /** the grant issued on approval (its first version) */
    grantId: idSchema.optional(),
  })
  .superRefine((request, context) => {
    if (
      new Set(request.requestedCategories).size !==
      request.requestedCategories.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['requestedCategories'],
        message: 'categories must be unique',
      });
    }

    if ((request.status === 'pending') !== (request.decidedAt === undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['decidedAt'],
        message:
          'decidedAt is set exactly when the request is no longer pending',
      });
    }

    if ((request.status === 'approved') !== (request.grantId !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['grantId'],
        message: 'grantId is set exactly when the request is approved',
      });
    }
  });
export type ScopeRequest = z.infer<typeof scopeRequestSchema>;
