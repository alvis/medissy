import { z } from 'zod';

/**
 * size bounds shared by every contract, so each string and list is bounded and
 * no schema invents its own limit
 */
export const LIMITS = {
  listTiny: 8,
  listSmall: 16,
  listShort: 20,
  listMedium: 32,
  listLarge: 500,
  name: 64,
  label: 80,
  title: 120,
  id: 128,
  line: 200,
  subject: 255,
  scalar: 256,
  sentence: 300,
  url: 512,
  paragraph: 1000,
  textPart: 50_000,
} as const;

/** canonical purpose of use; the MVP supports only direct treatment (brief §5) */
export const PURPOSES = ['direct-treatment'] as const;
export const purposeSchema = z.enum(PURPOSES);
export type Purpose = z.infer<typeof purposeSchema>;

/** sensitivity labels, ordered from least to most sensitive */
export const SENSITIVITIES = ['routine', 'restricted'] as const;
export const sensitivitySchema = z.enum(SENSITIVITIES);
export type Sensitivity = z.infer<typeof sensitivitySchema>;

/**
 * numeric rank of each sensitivity; a grant with `maxSensitivity` M covers a
 * record of sensitivity S only when `SENSITIVITY_RANK[S] <= SENSITIVITY_RANK[M]`
 */
export const SENSITIVITY_RANK: Readonly<Record<Sensitivity, number>> = {
  routine: 0,
  restricted: 1,
};

/**
 * the closed set of curated record categories; `baseline` is the patient's
 * approved baseline summary and is released only through a grant's
 * `allowBaseline` flag, never through `categories`
 */
export const GRANTABLE_CATEGORIES = [
  'cardiac',
  'dental',
  'musculoskeletal',
  'dermatology',
  'mental-health',
  'substance-use',
] as const;

/** categories a grant can list explicitly (everything except `baseline`) */
export const grantableCategorySchema = z.enum(GRANTABLE_CATEGORIES);
export type GrantableCategory = z.infer<typeof grantableCategorySchema>;

export const RECORD_CATEGORIES = ['baseline', ...GRANTABLE_CATEGORIES] as const;
export const recordCategorySchema = z.enum(RECORD_CATEGORIES);
export type RecordCategory = z.infer<typeof recordCategorySchema>;

/**
 * categories whose records must always be labelled `restricted`; the envelope
 * schema rejects a routine record in one of these, so a mislabelled import
 * fails closed instead of reaching a routine-level grant
 */
export const ALWAYS_RESTRICTED_CATEGORIES: readonly RecordCategory[] = [
  'mental-health',
  'substance-use',
];

/** FHIR R4 resource types the vault accepts; anything else fails closed */
export const RESOURCE_TYPES = [
  'Patient',
  'AllergyIntolerance',
  'MedicationStatement',
  'Condition',
  'Observation',
  'DiagnosticReport',
  'DocumentReference',
  'Provenance',
] as const;
export const resourceTypeSchema = z.enum(RESOURCE_TYPES);
export type ResourceType = z.infer<typeof resourceTypeSchema>;

/** how trustworthy the origin of an imported record is */
export const VERIFICATIONS = [
  'synthetic-provider',
  'patient-entered',
  'unverified',
] as const;
export const verificationSchema = z.enum(VERIFICATIONS);
export type Verification = z.infer<typeof verificationSchema>;

/** scopes carried by Medissy access tokens */
export const SCOPE_REQUEST = 'medissy:request';
export const SCOPE_OWNER = 'medissy:owner';

/**
 * an ISO 8601 instant; offsets are accepted on input; persistence layers
 * normalise to the canonical UTC form (`YYYY-MM-DDTHH:MM:SS.sssZ`)
 */
export const timestampSchema = z.iso.datetime({ offset: true });

/**
 * an opaque internal identifier (records, grants, encounters, requests);
 * restricted to a safe alphabet so it cannot smuggle markup or paths
 */
export const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

/** an OIDC issuer: an absolute http(s) URL */
export const issuerSchema = z
  .url()
  .max(LIMITS.url)
  .refine((value) => /^https?:\/\//.test(value), 'issuer must be http(s)');

/** an OIDC subject: opaque, non-empty, bounded */
export const subjectSchema = z.string().min(1).max(LIMITS.subject);

/** a lower-case hex SHA-256 digest */
export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/** a verified or untrusted organisation identifier from the registry */
export const organizationIdSchema = idSchema;

/** a role name from the verified registry */
export const roleSchema = z.string().min(1).max(LIMITS.name);

/** a person identified by the issuer that vouches for them */
export const personRefSchema = z.strictObject({
  issuer: issuerSchema,
  subject: subjectSchema,
});
export type PersonRef = z.infer<typeof personRefSchema>;

/** JSON-safe scalar used where free-form structure is not allowed */
export const jsonScalarSchema = z.union([
  z.string().max(LIMITS.scalar),
  z.number(),
  z.boolean(),
  z.null(),
]);
export type JsonScalar = z.infer<typeof jsonScalarSchema>;
