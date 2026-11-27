import { z } from 'zod';

import {
  idSchema,
  purposeSchema,
  recordCategorySchema,
  LIMITS,
} from './common';

/** upper bound on the clinician's free-text question, in characters */
export const MAX_QUESTION_LENGTH = 2000;

/**
 * a clinical request after transport parsing; `requestId` is the idempotency
 * key, scoped to the verified caller; the question is untrusted data
 *
 * `encounterId` is a selector, not evidence: the server looks the encounter up
 * and admits the caller only if it is active, inside its window and linked to
 * the caller (`encounterAdmitsCaller`); an id that does not resolve, or that
 * resolves to an encounter the caller is not linked to, gets the same denial
 *
 * `requestedCategories` only narrows what grants already allow; omitted means
 * no narrowing; when present it is non-empty and `baseline` is included only
 * when listed explicitly
 */
export const clinicalRequestSchema = z.strictObject({
  requestId: idSchema,
  encounterId: idSchema,
  purpose: purposeSchema,
  question: z.string().trim().min(1).max(MAX_QUESTION_LENGTH),
  requestedCategories: z
    .array(recordCategorySchema)
    .min(1)
    .max(LIMITS.listSmall)
    .refine(
      (items) => new Set(items).size === items.length,
      'categories must be unique',
    )
    .optional(),
});
export type ClinicalRequest = z.infer<typeof clinicalRequestSchema>;
