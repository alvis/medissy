/**
 * inbound records (ADR-10): what a clinician's agent may hand back to Medissy
 * through the `submit-record` skill, and what it gets back; the input is
 * untrusted clinical content: it is bounded here, refused when it embeds
 * other resources or remote attachments, and never interpreted as an
 * instruction; who may submit, and to which category, is decided after
 * sign-in against the clinician's active grant, never from this input
 */
import { z } from 'zod';

import {
  grantableCategorySchema,
  idSchema,
  LIMITS,
  timestampSchema,
} from './common';

/** the skill id on the Agent Card */
export const SKILL_SUBMIT_RECORD = 'submit-record';

/** media type of the submission result data part */
export const SUBMISSION_MEDIA_TYPE = 'application/vnd.medissy.submission+json';

/**
 * the provenance provider of a submitted record's source row; submitted
 * records are `unverified`: Medissy vouches for who sent them, not for what
 * they say
 */
export const SUBMISSION_PROVIDER = 'clinician-submitted';

/** largest serialized submission (the whole data part), in bytes */
export const MAX_SUBMISSION_BYTES = 65_536;

/** structural bounds on a submitted FHIR resource */
export const SUBMISSION_BOUNDS = {
  /** deepest nesting of objects and arrays below the resource */
  depth: 8,
  /** longest string value anywhere in the resource */
  string: 8_192,
  /** longest array anywhere in the resource */
  array: LIMITS.listMedium,
  /** most keys on one object */
  keys: 64,
} as const;

/** longest free-text body of a submitted document */
export const MAX_DOCUMENT_TEXT = 8_000;

/** FHIR R4 resource types a clinician may submit */
export const SUBMITTABLE_RESOURCE_TYPES = [
  'Observation',
  'DiagnosticReport',
  'DocumentReference',
  'Condition',
  'MedicationStatement',
  'AllergyIntolerance',
] as const;
export const submittableResourceTypeSchema = z.enum(SUBMITTABLE_RESOURCE_TYPES);
export type SubmittableResourceType = z.infer<
  typeof submittableResourceTypeSchema
>;

/** keys whose object values are FHIR Attachments (never with a `url`) */
const ATTACHMENT_KEYS: ReadonlySet<string> = new Set([
  'attachment',
  'presentedForm',
  'photo',
]);

/** suffix of every choice-type Attachment key, e.g. `valueAttachment` */
const ATTACHMENT_SUFFIX = 'Attachment';

/** choice-type keys whose value is itself a link; never accepted */
const LINK_VALUE_KEYS: ReadonlySet<string> = new Set([
  'valueUrl',
  'valueUri',
  'valueCanonical',
]);

/**
 * checks whether a key holds a FHIR Attachment, by name or choice-type suffix
 * @param key an object key
 * @returns true for `attachment`, `presentedForm`, `photo` and `*Attachment`
 */
function isAttachmentKey(key: string): boolean {
  return ATTACHMENT_KEYS.has(key) || key.endsWith(ATTACHMENT_SUFFIX);
}

/** why a submitted resource's shape is refused; fixed codes */
export type ShapeProblem =
  | 'too-deep'
  | 'string-too-long'
  | 'array-too-long'
  | 'too-many-keys'
  | 'contained'
  | 'attachment-url'
  | 'not-json';

/**
 * finds the first structural problem of a JSON value, walking it once
 * @param value the value to check
 * @param path the context: depth and whether the value is an attachment
 * @param path.depth how deep the value sits below the resource
 * @param path.attachment true when the value is an Attachment
 * @returns the problem, or undefined when the value is within bounds
 */
function shapeProblem(
  value: unknown,
  path: { depth: number; attachment: boolean },
): ShapeProblem | undefined {
  if (value === null || typeof value === 'boolean') {
    return undefined;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? undefined : 'not-json';
  }

  if (typeof value === 'string') {
    return value.length > SUBMISSION_BOUNDS.string
      ? 'string-too-long'
      : undefined;
  }

  if (path.depth > SUBMISSION_BOUNDS.depth) {
    return 'too-deep';
  }

  if (Array.isArray(value)) {
    return value.length > SUBMISSION_BOUNDS.array
      ? 'array-too-long'
      : firstProblem(value, (item) =>
          shapeProblem(item, { ...path, depth: path.depth + 1 }),
        );
  }

  if (typeof value !== 'object') {
    return 'not-json';
  }

  return objectProblem(value as Record<string, unknown>, path);
}

/**
 * finds the first structural problem of a JSON object's keys and values
 * @param value the object to check
 * @param path the context: depth and whether the object is an attachment
 * @param path.depth how deep the object sits below the resource
 * @param path.attachment true when the object is an Attachment
 * @returns the problem, or undefined when the object is within bounds
 */
function objectProblem(
  value: Record<string, unknown>,
  path: { depth: number; attachment: boolean },
): ShapeProblem | undefined {
  const keys = Object.keys(value);

  if (keys.length > SUBMISSION_BOUNDS.keys) {
    return 'too-many-keys';
  }

  if (keys.includes('contained')) {
    return 'contained';
  }

  if (
    (path.attachment && keys.includes('url')) ||
    keys.some((key) => LINK_VALUE_KEYS.has(key))
  ) {
    return 'attachment-url';
  }

  return firstProblem(keys, (key) =>
    shapeProblem(value[key], {
      depth: path.depth + 1,
      attachment: isAttachmentKey(key),
    }),
  );
}

/**
 * returns the first defined result of a check over a list
 * @param items the values to check in order
 * @param check the check returning a problem or undefined
 * @returns the first problem found
 */
function firstProblem<T>(
  items: readonly T[],
  check: (item: T) => ShapeProblem | undefined,
): ShapeProblem | undefined {
  for (const item of items) {
    const problem = check(item);

    if (problem) {
      return problem;
    }
  }

  return undefined;
}

/**
 * finds the structural problem of a submitted resource, if any
 * @param resource the resource as sent, before Medissy assigns its ids
 * @returns the problem, or undefined when the resource is within bounds
 */
export function submittedShapeProblem(
  resource: Record<string, unknown>,
): ShapeProblem | undefined {
  return objectProblem(resource, { depth: 0, attachment: false });
}

/**
 * a submitted FHIR R4 resource; its `id`, `subject` and `patient` are
 * replaced by Medissy; everything else is kept as sent, within bounds
 */
export const submittedResourceSchema = z
  .looseObject({
    resourceType: submittableResourceTypeSchema,
    id: z.string().max(LIMITS.id).optional(),
  })
  .superRefine((resource, context) => {
    const problem = submittedShapeProblem(resource);

    if (problem) {
      context.addIssue({ code: 'custom', message: problem });
    }
  });
export type SubmittedResource = z.infer<typeof submittedResourceSchema>;

/** a free-text document; Medissy builds a DocumentReference from it */
export const submittedDocumentSchema = z.strictObject({
  title: z.string().min(1).max(LIMITS.title),
  text: z.string().min(1).max(MAX_DOCUMENT_TEXT),
  authoredAt: timestampSchema.optional(),
});
export type SubmittedDocument = z.infer<typeof submittedDocumentSchema>;

/**
 * the `submit-record` data part: exactly one of `record` or `document`, and
 * an optional category suggestion (it must be within the grant)
 */
export const submitRecordInputSchema = z
  .strictObject({
    skill: z.literal(SKILL_SUBMIT_RECORD),
    record: submittedResourceSchema.optional(),
    document: submittedDocumentSchema.optional(),
    category: grantableCategorySchema.optional(),
  })
  .superRefine((input, context) => {
    if ((input.record === undefined) === (input.document === undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'send exactly one of record or document',
      });
    }

    if (
      Buffer.byteLength(JSON.stringify(input), 'utf8') > MAX_SUBMISSION_BYTES
    ) {
      context.addIssue({ code: 'custom', message: 'submission too large' });
    }
  });
export type SubmitRecordInput = z.infer<typeof submitRecordInputSchema>;

/**
 * what the clinician's agent gets back for a filed record: only what it
 * sent (type and category) plus Medissy's ids; never a Box id, link or
 * digest, and never the record body
 */
export const submissionResultSchema = z.strictObject({
  status: z.literal('filed'),
  submissionId: idSchema,
  recordId: idSchema,
  resourceType: submittableResourceTypeSchema,
  category: grantableCategorySchema,
  filedName: z.string().min(1).max(LIMITS.title),
  filedAt: timestampSchema,
});
export type SubmissionResult = z.infer<typeof submissionResultSchema>;
