/**
 * field-level allowlists applied after record selection (brief §7 step 3)
 *
 * a record is released only as a projection onto the allowlist of its
 * category and resource type; every field not listed here is dropped; there
 * is no generic redaction: narrative (`text`), `meta`, identifiers,
 * extensions, contained resources and attachment `url`/`data` are never
 * listed, so they never leave the vault; references are kept only when they
 * point at the vault patient or at another record in the same release (see
 * `src/vault/filter.ts`)
 *
 * the restricted categories (`mental-health`, `substance-use`) have no
 * allowlist in the MVP: their records fail closed even under a grant that
 * covers them, because no curated, field-level projection exists for them
 */
import type { RecordCategory, ResourceType } from '../contracts';

/**
 * how one field is projected: `scalar` copies a string, number, boolean or
 * null; `reference` copies a FHIR Reference after checking its target; an
 * object projects a nested element field by field; arrays are projected
 * element by element with the same spec
 */
export type FieldSpec =
  'scalar' | 'reference' | { readonly [field: string]: FieldSpec };

/** the allowlist of one resource type: top-level field name to spec */
export type ResourceFieldSpec = Readonly<Record<string, FieldSpec>>;

const SCALAR = 'scalar';
const REFERENCE = 'reference';

const CODING = { system: SCALAR, code: SCALAR, display: SCALAR } as const;
const CODEABLE_CONCEPT = { coding: CODING, text: SCALAR } as const;
const QUANTITY = {
  value: SCALAR,
  unit: SCALAR,
  system: SCALAR,
  code: SCALAR,
} as const;
const PERIOD = { start: SCALAR, end: SCALAR } as const;
const ANNOTATION = { text: SCALAR } as const;
/** attachment metadata only: never `url`, `data` or `hash` */
const ATTACHMENT = {
  contentType: SCALAR,
  title: SCALAR,
  creation: SCALAR,
  size: SCALAR,
} as const;

/** the allowlist of every supported FHIR R4 resource type */
const RESOURCE_FIELDS: Readonly<Record<ResourceType, ResourceFieldSpec>> = {
  Patient: {
    active: SCALAR,
    name: { use: SCALAR, prefix: SCALAR, family: SCALAR, given: SCALAR },
    gender: SCALAR,
    birthDate: SCALAR,
  },
  AllergyIntolerance: {
    clinicalStatus: CODEABLE_CONCEPT,
    verificationStatus: CODEABLE_CONCEPT,
    type: SCALAR,
    category: SCALAR,
    criticality: SCALAR,
    code: CODEABLE_CONCEPT,
    patient: REFERENCE,
    recordedDate: SCALAR,
    recorder: REFERENCE,
    reaction: { manifestation: CODEABLE_CONCEPT, severity: SCALAR },
  },
  MedicationStatement: {
    status: SCALAR,
    medicationCodeableConcept: CODEABLE_CONCEPT,
    subject: REFERENCE,
    effectivePeriod: PERIOD,
    dateAsserted: SCALAR,
    informationSource: REFERENCE,
    dosage: { text: SCALAR },
  },
  Condition: {
    clinicalStatus: CODEABLE_CONCEPT,
    verificationStatus: CODEABLE_CONCEPT,
    code: CODEABLE_CONCEPT,
    subject: REFERENCE,
    onsetDateTime: SCALAR,
    recordedDate: SCALAR,
    recorder: REFERENCE,
  },
  Observation: {
    status: SCALAR,
    category: CODEABLE_CONCEPT,
    code: CODEABLE_CONCEPT,
    subject: REFERENCE,
    effectiveDateTime: SCALAR,
    performer: REFERENCE,
    valueQuantity: QUANTITY,
    dataAbsentReason: CODEABLE_CONCEPT,
    component: { code: CODEABLE_CONCEPT, valueQuantity: QUANTITY },
    note: ANNOTATION,
  },
  DiagnosticReport: {
    status: SCALAR,
    category: CODEABLE_CONCEPT,
    code: CODEABLE_CONCEPT,
    subject: REFERENCE,
    effectiveDateTime: SCALAR,
    issued: SCALAR,
    performer: REFERENCE,
    conclusion: SCALAR,
  },
  DocumentReference: {
    status: SCALAR,
    type: CODEABLE_CONCEPT,
    subject: REFERENCE,
    date: SCALAR,
    author: REFERENCE,
    description: SCALAR,
    content: { attachment: ATTACHMENT },
  },
  Provenance: {
    target: REFERENCE,
    recorded: SCALAR,
    agent: { type: CODEABLE_CONCEPT, who: REFERENCE },
  },
};

/** resource types a routine clinical category may release */
const CLINICAL_TYPES: readonly ResourceType[] = [
  'AllergyIntolerance',
  'MedicationStatement',
  'Condition',
  'Observation',
  'DiagnosticReport',
  'DocumentReference',
  'Provenance',
];

/**
 * which resource types each category may release; baseline is the patient
 * summary; restricted categories release nothing in the MVP (fail closed)
 */
const CATEGORY_RESOURCE_TYPES: Readonly<
  Record<RecordCategory, readonly ResourceType[]>
> = {
  'baseline': [
    'Patient',
    'AllergyIntolerance',
    'MedicationStatement',
    'Provenance',
  ],
  'cardiac': CLINICAL_TYPES,
  'dental': CLINICAL_TYPES,
  'musculoskeletal': CLINICAL_TYPES,
  'dermatology': CLINICAL_TYPES,
  'mental-health': [],
  'substance-use': [],
};

/**
 * returns the field allowlist for a record of this category and resource type
 * @param category the record's curated category
 * @param resourceType the record's FHIR resource type
 * @returns the allowlist, or undefined when the pair is not releasable
 */
export function fieldAllowlistFor(
  category: RecordCategory,
  resourceType: ResourceType,
): ResourceFieldSpec | undefined {
  return CATEGORY_RESOURCE_TYPES[category].includes(resourceType)
    ? RESOURCE_FIELDS[resourceType]
    : undefined;
}
