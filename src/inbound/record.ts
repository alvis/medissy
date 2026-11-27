/**
 * turning a clinician's submission into the record Medissy files (ADR-10);
 * pure: no clock, database or network; every string is stripped of control,
 * bidi-override and separator characters before it is stored; the text is
 * kept as data and is rendered inert wherever it is shown; Medissy sets the
 * resource id and the patient reference itself, and refuses a submission that
 * points at any other patient
 */
import { createHash } from 'node:crypto';

import { recordEnvelopeSchema, SUBMISSION_PROVIDER } from '../contracts';

import type {
  GrantableCategory,
  RecordEnvelope,
  SubmitRecordInput,
  SubmittableResourceType,
} from '../contracts';

/** control, format (bidi) and separator characters, newline excepted */
const INVISIBLE_KEEP_NEWLINE = /[\p{Cf}\p{Zl}\p{Zp}]|(?!\n)\p{Cc}/gu;
/** control, format (bidi) and separator characters */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
/** line endings normalised to `\n` before stripping */
const LINE_ENDINGS = /\r\n?/g;
/** length of the random part of a filed name */
const SHORT_ID_LENGTH = 8;
/** characters of an ISO date kept in a filed name (`yyyy-mm-dd`) */
const ISO_DATE_LENGTH = 10;

/** placeholder provenance used to validate before the store answers */
const PROBE_FILE_ID = '0';
const PROBE_VERSION = 'pending';

/** ids Medissy assigns to one submission */
export interface SubmissionIds {
  /** the receipt id (`inbound_submissions.id`) */
  submissionId: string;
  /** the record id, also the FHIR resource id */
  recordId: string;
  /** random hex used in the filed name */
  shortId: string;
}

/** why a submission is refused after sign-in; fixed codes */
export type BuildRefusal = 'foreign-patient' | 'invalid-record';

/** a record ready to upload and import */
export interface BuiltRecord {
  /** the filed name, e.g. `inbound-20261126-1a2b3c4d.json` */
  name: string;
  /** the FHIR collection Bundle bytes that are filed */
  bytes: Uint8Array;
  sha256: string;
  resourceType: SubmittableResourceType;
  /** builds the envelope once the store has reported the file id and version */
  envelope: (filed: { fileId: string; version: string }) => RecordEnvelope;
}

/** what `buildRecord` needs besides the submission */
export interface BuildContext {
  patientId: string;
  category: GrantableCategory;
  ids: SubmissionIds;
  /** the filing instant, ISO */
  now: string;
}

/**
 * strips invisible characters from every string in a JSON value
 * @param value a JSON value
 * @returns a copy with only visible characters (and no newlines)
 */
function clean(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(INVISIBLE, ' ').trim();
  }

  if (Array.isArray(value)) {
    return value.map(clean);
  }

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, clean(item)]),
    );
  }

  return value;
}

/**
 * strips invisible characters from free text, keeping its line breaks
 * @param text untrusted text
 * @returns the cleaned text
 */
function cleanText(text: string): string {
  return text
    .replace(LINE_ENDINGS, '\n')
    .replace(INVISIBLE_KEEP_NEWLINE, ' ')
    .trim();
}

/**
 * checks whether a reference string may name a patient other than this one: a
 * literal `Patient/<id>` for another id, or a conditional `Patient?…` search
 * @param reference the reference string
 * @param patientId the vault patient
 * @returns true when it may name another patient
 */
function isOtherPatientReference(
  reference: string,
  patientId: string,
): boolean {
  const namesPatient =
    reference.includes('Patient/') || reference.includes('Patient?');

  return namesPatient && reference !== `Patient/${patientId}`;
}

/**
 * checks whether any Reference in a JSON value may name a patient other than this
 * one: a `reference` string naming another patient, or a logical Reference
 * typed `Patient` that is not the plain reference to this patient
 * @param value a JSON value
 * @param patientId the vault patient
 * @returns true when another patient may be referenced
 */
function referencesOtherPatient(value: unknown, patientId: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => referencesOtherPatient(item, patientId));
  }

  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const entry = value as Record<string, unknown>;

  if (entry.type === 'Patient' && entry.reference !== `Patient/${patientId}`) {
    return true;
  }

  return Object.entries(entry).some(([key, item]) =>
    key === 'reference' && typeof item === 'string'
      ? isOtherPatientReference(item, patientId)
      : referencesOtherPatient(item, patientId),
  );
}

/**
 * checks whether the sent `subject` or `patient` names anyone but this patient; an
 * element without a plain reference (an identifier, say) counts as another
 * patient: Medissy cannot tell, so it refuses
 * @param resource the submitted resource
 * @param patientId the vault patient
 * @returns true when the submission points elsewhere
 */
function namesOtherSubject(
  resource: Record<string, unknown>,
  patientId: string,
): boolean {
  return ['subject', 'patient'].some((key) => {
    const element = resource[key];

    if (element === undefined) {
      return false;
    }

    return (
      typeof element !== 'object' ||
      element === null ||
      !('reference' in element) ||
      element.reference !== `Patient/${patientId}`
    );
  });
}

/**
 * builds the FHIR resource Medissy files, with its own id and patient reference
 * @param input the validated submission
 * @param context the patient, ids and filing instant
 * @returns the resource, or why it is refused
 */
function resourceFor(
  input: SubmitRecordInput,
  context: BuildContext,
): Record<string, unknown> | BuildRefusal {
  const patient = { reference: `Patient/${context.patientId}` };

  if (input.document) {
    const { title, text, authoredAt } = input.document;
    const cleanTitle = clean(title) as string;

    return {
      resourceType: 'DocumentReference',
      id: context.ids.recordId,
      status: 'current',
      type: { text: cleanTitle },
      subject: patient,
      date: authoredAt ?? context.now,
      description: cleanText(text),
      content: [
        { attachment: { contentType: 'text/plain', title: cleanTitle } },
      ],
    };
  }

  const record = clean(input.record) as Record<string, unknown>;

  if (
    namesOtherSubject(record, context.patientId) ||
    referencesOtherPatient(record, context.patientId)
  ) {
    return 'foreign-patient';
  }

  const subjectKey =
    record.resourceType === 'AllergyIntolerance' ? 'patient' : 'subject';

  return { ...record, id: context.ids.recordId, [subjectKey]: patient };
}

/**
 * builds the filed name of a submission: `inbound-<yyyymmdd>-<short id>.json`
 * @param now the filing instant, ISO
 * @param shortId random hex
 * @returns the name, safe for Box and for the sync's name check
 */
export function filedName(now: string, shortId: string): string {
  const day = now.slice(0, ISO_DATE_LENGTH).replaceAll('-', '');

  return `inbound-${day}-${shortId.slice(0, SHORT_ID_LENGTH)}.json`;
}

/**
 * builds the record to file from a validated submission
 * @param input the validated `submit-record` input
 * @param context the patient, category, ids and filing instant
 * @returns the bytes, digest and envelope builder, or why it is refused
 */
export function buildRecord(
  input: SubmitRecordInput,
  context: BuildContext,
): BuiltRecord | BuildRefusal {
  const resource = resourceFor(input, context);

  if (typeof resource === 'string') {
    return resource;
  }

  const bundle = {
    resourceType: 'Bundle',
    type: 'collection',
    entry: [{ resource }],
  };
  const bytes = new TextEncoder().encode(JSON.stringify(bundle));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const resourceType = resource.resourceType as SubmittableResourceType;
  const draft = (filed: { fileId: string; version: string }): unknown => ({
    id: context.ids.recordId,
    patientId: context.patientId,
    resourceType,
    resource,
    category: context.category,
    sensitivity: 'routine',
    status: 'current',
    source: {
      provider: SUBMISSION_PROVIDER,
      boxFileId: filed.fileId,
      version: filed.version,
      sha256,
      ...(input.document?.authoredAt
        ? { authoredAt: input.document.authoredAt }
        : {}),
      importedAt: context.now,
      verification: 'unverified',
    },
  });
  // validate before anything leaves the vault: a resource the envelope
  // contract refuses is never uploaded
  const probe = recordEnvelopeSchema.safeParse(
    draft({ fileId: PROBE_FILE_ID, version: PROBE_VERSION }),
  );

  return probe.success
    ? {
        name: filedName(context.now, context.ids.shortId),
        bytes,
        sha256,
        resourceType,
        envelope: (filed) => recordEnvelopeSchema.parse(draft(filed)),
      }
    : 'invalid-record';
}
