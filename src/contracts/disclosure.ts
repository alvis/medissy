import { z } from 'zod';

import {
  idSchema,
  purposeSchema,
  recordCategorySchema,
  timestampSchema,
  verificationSchema,
  LIMITS,
} from './common';
import { fhirResourceSchema } from './record';

/** the fixed notice every selective extract carries (brief §7) */
export const SELECTIVE_NOTICE =
  'Selective extract of available authorized records; not a complete medical history.';

/** a FHIR R4 `collection` Bundle whose entries are authorised resources */
export const fhirCollectionBundleSchema = z.looseObject({
  resourceType: z.literal('Bundle'),
  type: z.literal('collection'),
  entry: z
    .array(z.looseObject({ resource: fhirResourceSchema }))
    .max(LIMITS.listLarge),
});
export type FhirCollectionBundle = z.infer<typeof fhirCollectionBundleSchema>;

/** one source-linked evidence card */
export const evidenceItemSchema = z.strictObject({
  recordId: idSchema,
  label: z.string().min(1).max(LIMITS.line),
  factualValue: z.string().max(LIMITS.listLarge).optional(),
  source: z.string().min(1).max(LIMITS.line),
  authoredAt: timestampSchema.optional(),
  importedAt: timestampSchema,
  verification: verificationSchema,
});
export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

/**
 * a conflict among released records, listing released ids only: a curated
 * link between sources that disagree, or a record whose source has an
 * unreviewed newer copy
 */
export const disclosureConflictSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('linked'),
    topic: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    recordIds: z.array(idSchema).min(2).max(LIMITS.listTiny),
  }),
  z.strictObject({
    kind: z.literal('open-source-conflict'),
    recordId: idSchema,
  }),
]);
export type DisclosureConflict = z.infer<typeof disclosureConflictSchema>;

/** the structured result of an authorised, selective disclosure */
export const disclosureResultSchema = z
  .strictObject({
    requestId: idSchema,
    receiptId: idSchema,
    kind: z.literal('selective-evidence'),
    scope: z.strictObject({
      purpose: purposeSchema,
      encounterId: idSchema,
      categories: z.array(recordCategorySchema).max(LIMITS.listSmall),
      expiresAt: timestampSchema,
    }),
    notice: z.literal(SELECTIVE_NOTICE),
    evidence: z.array(evidenceItemSchema).max(LIMITS.listLarge),
    conflicts: z.array(disclosureConflictSchema).max(LIMITS.listLarge),
    coverage: z.strictObject({
      lastSyncAt: timestampSchema.optional(),
      limitations: z
        .array(z.string().min(1).max(LIMITS.sentence))
        .max(LIMITS.listShort),
    }),
    bundle: fhirCollectionBundleSchema,
  })
  .superRefine((result, context) => {
    const released = new Set(result.evidence.map((item) => item.recordId));
    const named = result.conflicts.flatMap((conflict) =>
      conflict.kind === 'linked' ? conflict.recordIds : [conflict.recordId],
    );

    if (named.some((id) => !released.has(id))) {
      context.addIssue({
        code: 'custom',
        path: ['conflicts'],
        message: 'conflicts may name released evidence only',
      });
    }
  });
export type DisclosureResult = z.infer<typeof disclosureResultSchema>;

/**
 * a safe refusal; it never carries evidence, record identifiers or counts, so
 * a denial reveals nothing about restricted records
 */
export const disclosureDenialSchema = z.strictObject({
  requestId: idSchema,
  kind: z.enum(['access_required', 'denied']),
  code: z.enum([
    'access-required',
    'not-permitted',
    'invalid-request',
    'temporarily-unavailable',
  ]),
  message: z.string().min(1).max(LIMITS.sentence),
  nextStep: z.string().min(1).max(LIMITS.sentence).optional(),
  receiptId: idSchema.optional(),
});
export type DisclosureDenial = z.infer<typeof disclosureDenialSchema>;

/** what an A2A data part carries: evidence or a safe denial */
export const disclosureOutcomeSchema = z.union([
  disclosureResultSchema,
  disclosureDenialSchema,
]);
export type DisclosureOutcome = z.infer<typeof disclosureOutcomeSchema>;
