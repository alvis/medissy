import { z } from 'zod';

import {
  ALWAYS_RESTRICTED_CATEGORIES,
  idSchema,
  personRefSchema,
  recordCategorySchema,
  resourceTypeSchema,
  RESOURCE_TYPES,
  sensitivitySchema,
  sha256Schema,
  timestampSchema,
  verificationSchema,
  LIMITS,
} from './common';

/** the minimum a FHIR R4 resource must carry; all other fields pass through */
export const fhirResourceSchema = z.looseObject({
  resourceType: resourceTypeSchema,
  id: idSchema,
});
export type FhirResource = z.infer<typeof fhirResourceSchema>;

/** where a record came from; `boxFileId` is a numeric Box file id */
export const recordSourceSchema = z.strictObject({
  provider: z.string().min(1).max(LIMITS.title),
  boxFileId: z.string().regex(/^\d{1,32}$/),
  version: z.string().min(1).max(LIMITS.name),
  sha256: sha256Schema,
  authoredAt: timestampSchema.optional(),
  importedAt: timestampSchema,
  verification: verificationSchema,
});
export type RecordSource = z.infer<typeof recordSourceSchema>;

/**
 * returns the patient reference a FHIR resource carries, or undefined when the type
 * has none (Patient, Provenance)
 * @param resource a FHIR resource
 * @returns the `subject` or `patient` reference string, if present
 */
export function patientReferenceOf(resource: FhirResource): string | undefined {
  for (const key of ['subject', 'patient']) {
    const value = resource[key];

    if (typeof value === 'object' && value !== null && 'reference' in value) {
      const { reference } = value;

      return typeof reference === 'string' ? reference : undefined;
    }
  }

  return undefined;
}

/** `Type/id` relative reference, with a known resource type */
const RELATIVE_REFERENCE = /^([A-Za-z]+)\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/;

/**
 * runs the patient check for a Provenance; R4 Provenance has no patient field, so
 * its link to the patient is its `target` list: it must be non-empty, every
 * entry a relative `Type/id` reference of a known resource type (no absolute
 * URLs, no contained fragments), and any `Patient/` target must be the
 * envelope patient; a Provenance that names another patient, or any
 * `subject`/`patient` reference to one, is rejected; whether each target is a
 * record of this patient with the same category and sensitivity is checked
 * where records are loaded together
 * @param resource the Provenance resource under check
 * @param patientId the envelope patient
 * @returns a list of problems, empty when the Provenance passes
 */
function provenanceProblems(
  resource: FhirResource,
  patientId: string,
): string[] {
  const problems: string[] = [];
  const { target } = resource;
  const patientReference = patientReferenceOf(resource);

  if (
    patientReference !== undefined &&
    patientReference !== `Patient/${patientId}`
  ) {
    problems.push('Provenance must not reference another patient');
  }

  if (!Array.isArray(target) || target.length === 0) {
    problems.push('Provenance needs at least one target reference');

    return problems;
  }

  for (const entry of target as unknown[]) {
    const reference =
      typeof entry === 'object' && entry !== null && 'reference' in entry
        ? entry.reference
        : undefined;
    const match =
      typeof reference === 'string' ? RELATIVE_REFERENCE.exec(reference) : null;
    const type = match?.[1];

    if (
      !match ||
      !RESOURCE_TYPES.some((known) => known === type) ||
      (type === 'Patient' && match[2] !== patientId)
    ) {
      problems.push(
        'Provenance targets must be Type/id references of this patient',
      );
    }
  }

  return problems;
}

/**
 * the internal FHIR R4 record envelope (brief §6); `category` and
 * `sensitivity` are the only fields policy reads, so they are validated
 * against the closed sets and against each other
 */
export const recordEnvelopeSchema = z
  .strictObject({
    id: idSchema,
    patientId: idSchema,
    resourceType: resourceTypeSchema,
    resource: fhirResourceSchema,
    category: recordCategorySchema,
    sensitivity: sensitivitySchema,
    source: recordSourceSchema,
    status: z.enum(['current', 'superseded', 'entered-in-error']),
  })
  .superRefine((envelope, context) => {
    const { resource } = envelope;

    if (resource.resourceType !== envelope.resourceType) {
      context.addIssue({
        code: 'custom',
        path: ['resource', 'resourceType'],
        message: 'resource.resourceType must equal resourceType',
      });
    }

    if (resource.resourceType === 'Patient') {
      if (resource.id !== envelope.patientId) {
        context.addIssue({
          code: 'custom',
          path: ['resource', 'id'],
          message: 'Patient resource id must equal patientId',
        });
      }
    } else if (resource.resourceType === 'Provenance') {
      for (const message of provenanceProblems(resource, envelope.patientId)) {
        context.addIssue({
          code: 'custom',
          path: ['resource', 'target'],
          message,
        });
      }
    } else {
      const reference = patientReferenceOf(resource);

      if (reference !== `Patient/${envelope.patientId}`) {
        context.addIssue({
          code: 'custom',
          path: ['resource'],
          message: 'resource must reference the envelope patient',
        });
      }
    }

    if (
      ALWAYS_RESTRICTED_CATEGORIES.includes(envelope.category) &&
      envelope.sensitivity !== 'restricted'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['sensitivity'],
        message: `category ${envelope.category} must be restricted`,
      });
    }

    if (
      envelope.category === 'baseline' &&
      envelope.sensitivity !== 'routine'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['sensitivity'],
        message: 'baseline records must be routine',
      });
    }
  });
export type RecordEnvelope = z.infer<typeof recordEnvelopeSchema>;

/** how an owner settled a record conflict */
export const CONFLICT_STATUSES = [
  'open',
  'kept-original',
  'accepted-incoming',
] as const;
export const conflictStatusSchema = z.enum(CONFLICT_STATUSES);
export type ConflictStatus = z.infer<typeof conflictStatusSchema>;

/**
 * a changed Box file version parked beside the record it would replace
 * (brief §6: conflicts stay visible, are never silently overwritten or
 * dropped); `incoming` is the full record envelope exactly as read
 *
 * a conflict is recorded `open` and is resolved once, by the owner:
 * `kept-original` leaves the existing record as it is; `accepted-incoming`
 * imports the incoming copy as a NEW record named by `acceptedRecordId`; a
 * resolution never mutates the existing record's category or sensitivity (only
 * its status may change, for example to `superseded`), because policy reads
 * those fields
 */
export const recordConflictSchema = z
  .strictObject({
    id: idSchema,
    recordId: idSchema,
    boxFileId: z.string().regex(/^\d{1,32}$/),
    incomingVersion: z.string().min(1).max(LIMITS.name),
    incomingSha256: sha256Schema,
    incoming: recordEnvelopeSchema,
    detectedAt: timestampSchema,
    status: conflictStatusSchema,
    resolvedBy: personRefSchema.optional(),
    resolvedAt: timestampSchema.optional(),
    acceptedRecordId: idSchema.optional(),
  })
  .superRefine((conflict, context) => {
    const open = conflict.status === 'open';

    if (open !== (conflict.resolvedAt === undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['resolvedAt'],
        message: 'resolvedAt is set exactly when the conflict is resolved',
      });
    }

    if (open !== (conflict.resolvedBy === undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['resolvedBy'],
        message: 'resolvedBy is set exactly when the conflict is resolved',
      });
    }

    if (
      (conflict.status === 'accepted-incoming') !==
      (conflict.acceptedRecordId !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['acceptedRecordId'],
        message: 'only an accepted conflict names its new record id',
      });
    }

    if (conflict.acceptedRecordId === conflict.recordId) {
      context.addIssue({
        code: 'custom',
        path: ['acceptedRecordId'],
        message: 'accepting creates a new record id, not the existing one',
      });
    }

    if (conflict.incoming.source.boxFileId !== conflict.boxFileId) {
      context.addIssue({
        code: 'custom',
        path: ['boxFileId'],
        message: 'boxFileId must match the incoming record source',
      });
    }
  });
export type RecordConflict = z.infer<typeof recordConflictSchema>;
