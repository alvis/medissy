import { z } from 'zod';

import { idSchema, LIMITS } from './common';
import { disclosureOutcomeSchema } from './disclosure';

/** media type of the machine-readable disclosure data part */
export const DISCLOSURE_MEDIA_TYPE = 'application/vnd.medissy.disclosure+json';

/** upper bound on the base64 length of the HTML part (~150 KB decoded) */
export const MAX_HTML_BASE64_LENGTH = 200_000;

/**
 * the optional A2A part `metadata`: a bounded JSON object; Medissy sets none
 * today, but a conforming client or server may carry some
 */
export const partMetadataSchema = z
  .record(z.string().min(1).max(LIMITS.name), z.json())
  .refine(
    (value) => Object.keys(value).length <= LIMITS.listMedium,
    'at most 32 metadata keys',
  );
export type PartMetadata = z.infer<typeof partMetadataSchema>;

/** A2A 1.0 text part: `{"text": ...}` with no `kind` discriminator */
export const textPartSchema = z.strictObject({
  text: z.string().max(LIMITS.textPart),
  metadata: partMetadataSchema.optional(),
});
export type TextPart = z.infer<typeof textPartSchema>;

/** A2A 1.0 data part carrying the typed disclosure outcome */
export const disclosureDataPartSchema = z.strictObject({
  data: disclosureOutcomeSchema,
  mediaType: z.literal(DISCLOSURE_MEDIA_TYPE),
  metadata: partMetadataSchema.optional(),
});
export type DisclosureDataPart = z.infer<typeof disclosureDataPartSchema>;

/**
 * A2A 1.0 raw part holding server-escaped HTML as base64; clients render it
 * in a sandbox or ignore it; it never carries scripts or remote references
 */
export const htmlRawPartSchema = z.strictObject({
  raw: z.base64().max(MAX_HTML_BASE64_LENGTH),
  mediaType: z.literal('text/html'),
  filename: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,64}$/)
    .optional(),
  metadata: partMetadataSchema.optional(),
});
export type HtmlRawPart = z.infer<typeof htmlRawPartSchema>;

export const artifactPartSchema = z.union([
  textPartSchema,
  disclosureDataPartSchema,
  htmlRawPartSchema,
]);
export type ArtifactPart = z.infer<typeof artifactPartSchema>;

/** an A2A artifact assembled from the allowed parts */
export const disclosureArtifactSchema = z.strictObject({
  artifactId: idSchema,
  name: z.string().min(1).max(LIMITS.title).optional(),
  description: z.string().min(1).max(LIMITS.sentence).optional(),
  parts: z.array(artifactPartSchema).min(1).max(LIMITS.listTiny),
});
export type DisclosureArtifact = z.infer<typeof disclosureArtifactSchema>;
