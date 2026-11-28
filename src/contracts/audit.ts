import { z } from 'zod';

import {
  idSchema,
  issuerSchema,
  jsonScalarSchema,
  subjectSchema,
  timestampSchema,
  LIMITS,
} from './common';

export const AUDIT_EVENT_TYPES = [
  'disclosure.released',
  'disclosure.denied',
  'grant.created',
  'grant.revoked',
  'scope.requested',
  'scope.approved',
  'scope.declined',
  'invitation.created',
  'invitation.consumed',
  'connection.confirmed',
  'connection.declined',
  'sync.completed',
  'sync.failed',
  'task.denied',
  'auth.rejected',
  'record.submitted',
  'record.removed',
] as const;
export const auditEventTypeSchema = z.enum(AUDIT_EVENT_TYPES);
export type AuditEventType = z.infer<typeof auditEventTypeSchema>;

/**
 * an append-only audit event; `details` holds scalars only (no nested
 * structures, no clinical text) so the log cannot become a second copy of the
 * record; anonymous and system actors carry no identity
 */
export const auditEventSchema = z
  .strictObject({
    id: idSchema,
    occurredAt: timestampSchema,
    type: auditEventTypeSchema,
    outcome: z.enum(['success', 'denied', 'error']),
    actor: z.strictObject({
      kind: z.enum(['owner', 'clinician', 'system', 'anonymous']),
      issuer: issuerSchema.optional(),
      subject: subjectSchema.optional(),
    }),
    patientId: idSchema.optional(),
    requestId: idSchema.optional(),
    receiptId: idSchema.optional(),
    target: z
      .strictObject({
        type: z.string().min(1).max(LIMITS.name),
        id: z.string().min(1).max(LIMITS.id),
      })
      .optional(),
    details: z
      .record(z.string().min(1).max(LIMITS.name), jsonScalarSchema)
      .refine(
        (value) => Object.keys(value).length <= LIMITS.listMedium,
        'at most 32 detail keys',
      ),
  })
  .superRefine((event, context) => {
    const identified =
      event.actor.kind === 'owner' || event.actor.kind === 'clinician';
    const hasIdentity =
      event.actor.issuer !== undefined && event.actor.subject !== undefined;
    const hasAny =
      event.actor.issuer !== undefined || event.actor.subject !== undefined;

    if (identified ? !hasIdentity : hasAny) {
      context.addIssue({
        code: 'custom',
        path: ['actor'],
        message:
          'owner and clinician actors need issuer and subject; others must have none',
      });
    }
  });
export type AuditEvent = z.infer<typeof auditEventSchema>;
