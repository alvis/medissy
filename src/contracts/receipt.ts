import { z } from 'zod';

import {
  idSchema,
  organizationIdSchema,
  personRefSchema,
  purposeSchema,
  recordCategorySchema,
  roleSchema,
  timestampSchema,
  LIMITS,
} from './common';

/** machine-readable reason for a decision; never private reasoning */
export const RATIONALE_CODES = [
  'granted',
  'no-grant',
  'grant-not-yet-valid',
  'grant-expired',
  'grant-revoked',
  'encounter-not-found',
  'encounter-mismatch',
  'category-not-permitted',
  'sensitivity-exceeded',
  'denied-by-deny-grant',
  'principal-not-registered',
  'invalid-request',
  'insufficient-scope',
  'duplicate-request',
  'selector-fallback',
] as const;
export const rationaleCodeSchema = z.enum(RATIONALE_CODES);
export type RationaleCode = z.infer<typeof rationaleCodeSchema>;

/**
 * one released record, the source version it came from, and the exact grant
 * version that covered it; different records in one release may rely on
 * different grants, so the grant is recorded per record
 */
export const releasedRecordSchema = z.strictObject({
  recordId: idSchema,
  sourceVersion: z.string().min(1).max(LIMITS.name),
  grant: z.strictObject({ id: idSchema, version: z.number().int().min(1) }),
});
export type ReleasedRecord = z.infer<typeof releasedRecordSchema>;

/**
 * a disclosure receipt (brief §8): one per decision, released or denied; each
 * released record names the grant version it relied on (stored as one child row
 * per record); the owner sees all of it; a clinician-visible rendering must never include
 * restricted identifiers or vault-wide counts
 */
export const receiptSchema = z
  .strictObject({
    id: idSchema,
    issuedAt: timestampSchema,
    /** the request correlation id; unique per requester (idempotency) */
    requestId: idSchema,
    requester: personRefSchema,
    organizationId: organizationIdSchema.optional(),
    roles: z.array(roleSchema).max(LIMITS.listSmall),
    /** as attempted; may not exist when the decision is a denial */
    encounterId: z.string().min(1).max(LIMITS.id),
    purpose: purposeSchema,
    policyVersion: z.string().min(1).max(LIMITS.name),
    approvedCategories: z.array(recordCategorySchema).max(LIMITS.listSmall),
    releasedRecords: z.array(releasedRecordSchema).max(LIMITS.listLarge),
    decision: z.enum(['released', 'denied']),
    rationaleCode: rationaleCodeSchema,
  })
  .superRefine((receipt, context) => {
    if (receipt.decision === 'denied' && receipt.releasedRecords.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['releasedRecords'],
        message: 'a denial releases nothing',
      });
    }

    if (receipt.decision === 'released') {
      if (receipt.releasedRecords.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['releasedRecords'],
          message: 'a release names the records it released',
        });
      }

      const ids = receipt.releasedRecords.map((item) => item.recordId);

      if (new Set(ids).size !== ids.length) {
        context.addIssue({
          code: 'custom',
          path: ['releasedRecords'],
          message: 'a record is released at most once per receipt',
        });
      }
    }
  });
export type Receipt = z.infer<typeof receiptSchema>;
