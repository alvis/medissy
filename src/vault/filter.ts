/**
 * the pre-model vault filter (brief §7 step 3); it re-checks a policy allow at
 * the moment of use, reads the bodies of the still-allowed records only, and
 * projects each onto its category's field allowlist; everything outside that
 * projection, including narrative text, metadata, attachment links and any
 * reference to a resource outside the release, never leaves this module, so
 * it cannot reach a model, a result or an error
 */
import { fieldAllowlistFor } from '../policy/fields';

import { readOpenConflicts, readRecords, VaultReadError } from './records';

import type {
  PersonRef,
  RecordCategory,
  RecordEnvelope,
  ResourceType,
  Verification,
} from '../contracts';
import type {
  GrantVersion,
  PolicyAllow,
  PolicyDeny,
  ReleasedRecordDecision,
} from '../policy/decide';
import type { PolicyEngine } from '../policy/engine';
import type { FieldSpec, ResourceFieldSpec } from '../policy/fields';

/** a JSON value that survived projection */
export type ProjectedValue =
  | string
  | number
  | boolean
  | null
  | readonly ProjectedValue[]
  | { readonly [field: string]: ProjectedValue };

/** a FHIR resource reduced to its allowlisted fields */
export interface ProjectedResource {
  readonly resourceType: ResourceType;
  readonly id: string;
  readonly [field: string]: ProjectedValue;
}

/** source facts a clinician may see; never Box ids, links or digests */
export interface ProjectedSource {
  provider: string;
  version: string;
  authoredAt?: string;
  importedAt: string;
  verification: Verification;
}

/** one released record as the rest of the pipeline may see it */
export interface RecordProjection {
  recordId: string;
  category: RecordCategory;
  grant: GrantVersion;
  source: ProjectedSource;
  resource: ProjectedResource;
  /**
   * true while the stored file has an unresolved newer copy; the original is
   * what is released; the incoming copy never is
   */
  openConflict: boolean;
}

/** one record as a model may see it: its id and its allowed fields */
export interface ModelEvidence {
  recordId: string;
  fields: ProjectedResource;
}

/** the filter's outcome: projections under a re-checked allow, or a deny */
export type FilterOutcome =
  | { kind: 'released'; decision: PolicyAllow; projections: RecordProjection[] }
  | { kind: 'denied'; decision: PolicyDeny };

/** what `filterVault` needs besides the engine */
export interface FilterParams {
  /** the allow decision to retrieve records for */
  decision: PolicyAllow;
  /** the verified issuer and subject bound to the task */
  caller: PersonRef;
}

/** which references a projection may keep */
export interface ReferenceScope {
  /** the vault patient; `Patient/<patientId>` is always resolvable */
  patientId: string;
  /** `Type/id` of every resource in the release, keyed by FHIR resource id */
  released: ReadonlySet<string>;
}

/** `Type/id` relative reference; absolute URLs and fragments never match */
const RELATIVE_REFERENCE = /^([A-Za-z]+)\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/;

/**
 * retrieves and projects the records of an allow decision; the re-check, the
 * body reads and the conflict read share one snapshot, so a grant revoked or
 * expired since the decision fails closed and no body changes in between;
 * only the re-checked record ids are read, each must still be `current`, and
 * the returned decision lists exactly the projected records
 * @param engine the policy engine bound to the vault and clock
 * @param params the decision and the bound person
 * @returns the projections with their decision, or a deny
 */
export function filterVault(
  engine: PolicyEngine,
  params: FilterParams,
): FilterOutcome {
  return engine.snapshot((db) => {
    const current = engine.recheck({
      prior: params.decision,
      caller: params.caller,
    });

    if (current.effect === 'deny') {
      return { kind: 'denied', decision: current };
    }

    const envelopes = readRecords(
      db,
      current.patientId,
      current.records.map((record) => record.recordId),
    );

    if (envelopes.some((envelope) => envelope.status !== 'current')) {
      throw new VaultReadError('an allowed record is no longer current');
    }

    const conflicts = readOpenConflicts(db, current.patientId);
    const releases = new Map(
      current.records.map((record) => [record.recordId, record]),
    );
    const projections = projectRelease(envelopes, current.patientId).flatMap(
      ([envelope, resource]): RecordProjection[] => {
        const release = releases.get(envelope.id);

        return release
          ? [
              toProjection(envelope, resource, {
                release,
                openConflict: conflicts.has(envelope.id),
              }),
            ]
          : [];
      },
    );

    return narrow(current, projections);
  });
}

/**
 * projects a release so every kept reference resolves inside the final
 * release; withholding one record (a Provenance losing a target) can make
 * another lose a target in turn, so projection repeats over the survivors
 * until none drops out
 * @param envelopes the records allowed for release
 * @param patientId the vault patient
 * @returns each surviving record with its projection, in input order
 */
function projectRelease(
  envelopes: readonly RecordEnvelope[],
  patientId: string,
): Array<[RecordEnvelope, ProjectedResource]> {
  let candidates = envelopes;

  for (;;) {
    const scope: ReferenceScope = {
      patientId,
      released: new Set(
        candidates.map(
          (envelope) => `${envelope.resourceType}/${envelope.resource.id}`,
        ),
      ),
    };
    const projected = candidates.flatMap(
      (envelope): Array<[RecordEnvelope, ProjectedResource]> => {
        const resource = projectResource(envelope, scope);

        return resource ? [[envelope, resource]] : [];
      },
    );

    if (projected.length === candidates.length) {
      return projected;
    }

    candidates = projected.map(([envelope]) => envelope);
  }
}

/**
 * builds the model input from projections only: record ids plus allowed
 * fields, nothing read from the vault directly
 * @param projections the filter's projections
 * @returns one evidence entry per projected record
 */
export function toModelInput(
  projections: readonly RecordProjection[],
): ModelEvidence[] {
  return projections.map((projection) => ({
    recordId: projection.recordId,
    fields: projection.resource,
  }));
}

/**
 * projects one record onto the allowlist of its category and resource type
 * @param envelope the stored record
 * @param scope the references the projection may keep
 * @returns the projected resource, or undefined when the record is not
 * projectable (no allowlist, or a Provenance that would lose a target)
 */
export function projectResource(
  envelope: RecordEnvelope,
  scope: ReferenceScope,
): ProjectedResource | undefined {
  const allowlist = fieldAllowlistFor(envelope.category, envelope.resourceType);

  if (!allowlist) {
    return undefined;
  }

  const fields = projectFields(envelope.resource, allowlist, scope);

  if (
    envelope.resourceType === 'Provenance' &&
    !keepsEveryTarget(envelope, fields)
  ) {
    return undefined;
  }

  return {
    ...fields,
    resourceType: envelope.resourceType,
    id: envelope.resource.id,
  };
}

/**
 * projects the top-level fields of a resource
 * @param resource the stored FHIR resource
 * @param allowlist the allowlist of its category and type
 * @param scope the references the projection may keep
 * @returns the allowed fields that survived projection
 */
function projectFields(
  resource: Readonly<Record<string, unknown>>,
  allowlist: ResourceFieldSpec,
  scope: ReferenceScope,
): Record<string, ProjectedValue> {
  return Object.fromEntries(
    Object.entries(allowlist).flatMap(([field, spec]) => {
      const value = Object.hasOwn(resource, field)
        ? projectValue(resource[field], spec, scope)
        : undefined;

      return value === undefined ? [] : [[field, value]];
    }),
  );
}

/**
 * projects a field value; arrays are projected element by element and an
 * array left empty is dropped
 * @param value the stored value
 * @param spec how the field is projected
 * @param scope the references the projection may keep
 * @returns the projected value, or undefined when nothing is allowed
 */
function projectValue(
  value: unknown,
  spec: FieldSpec,
  scope: ReferenceScope,
): ProjectedValue | undefined {
  if (!Array.isArray(value)) {
    return projectElement(value, spec, scope);
  }

  const items = value.flatMap((item: unknown) => {
    const projected = projectElement(item, spec, scope);

    return projected === undefined ? [] : [projected];
  });

  return items.length > 0 ? items : undefined;
}

/**
 * projects one non-array element; a shape that does not match its spec (an
 * object where a scalar is expected, a nested array, anything else) is
 * dropped, so unexpected structure fails closed
 * @param value the stored element
 * @param spec how the element is projected
 * @param scope the references the projection may keep
 * @returns the projected element, or undefined when nothing is allowed
 */
function projectElement(
  value: unknown,
  spec: FieldSpec,
  scope: ReferenceScope,
): ProjectedValue | undefined {
  if (spec === 'scalar') {
    return isScalar(value) ? value : undefined;
  }

  if (!isPlainObject(value)) {
    return undefined;
  }

  if (spec === 'reference') {
    return projectReference(value, scope);
  }

  const fields = projectFields(value, spec, scope);

  return Object.keys(fields).length > 0 ? fields : undefined;
}

/**
 * projects a FHIR Reference: `reference` and `display` only; the element is
 * kept only when `reference` resolves to the vault patient or a resource in
 * this release; `display` travels only beside such a reference; a
 * display-only or identifier-only (logical) reference is dropped, so its text
 * cannot describe something outside the release
 * @param value the stored Reference
 * @param scope the references the projection may keep
 * @returns the projected Reference, or undefined when it must not be kept
 */
function projectReference(
  value: Readonly<Record<string, unknown>>,
  scope: ReferenceScope,
): ProjectedValue | undefined {
  const { reference, display } = value;

  if (typeof reference !== 'string' || !resolves(reference, scope)) {
    return undefined;
  }

  return typeof display === 'string' ? { reference, display } : { reference };
}

/**
 * checks whether a reference points at the vault patient or a released resource,
 * matched as `Type/id` against FHIR resource ids (not record ids)
 * @param reference the reference string
 * @param scope the references the projection may keep
 * @returns true when the reference may be kept
 */
function resolves(reference: string, scope: ReferenceScope): boolean {
  if (!RELATIVE_REFERENCE.test(reference)) {
    return false;
  }

  return (
    reference === `Patient/${scope.patientId}` || scope.released.has(reference)
  );
}

/**
 * checks whether a projected Provenance kept every stored target
 * @param envelope the stored Provenance record
 * @param fields its projected fields
 * @returns true when no target was dropped
 */
function keepsEveryTarget(
  envelope: RecordEnvelope,
  fields: Readonly<Record<string, ProjectedValue>>,
): boolean {
  const stored = envelope.resource.target;
  const kept = fields.target;

  return (
    Array.isArray(stored) &&
    Array.isArray(kept) &&
    kept.length === stored.length
  );
}

/**
 * builds the projection of one record
 * @param envelope the stored record
 * @param resource its projected resource
 * @param context how the record was released
 * @param context.release the decision entry that released it
 * @param context.openConflict whether the stored file has an open conflict
 * @returns the projection carrying source facts and grant
 */
function toProjection(
  envelope: RecordEnvelope,
  resource: ProjectedResource,
  context: { release: ReleasedRecordDecision; openConflict: boolean },
): RecordProjection {
  const { source } = envelope;
  const { release, openConflict } = context;

  return {
    recordId: envelope.id,
    category: envelope.category,
    grant: release.grant,
    source: {
      provider: source.provider,
      version: source.version,
      authoredAt: source.authoredAt,
      importedAt: source.importedAt,
      verification: source.verification,
    },
    resource,
    openConflict,
  };
}

/**
 * narrows a re-checked allow to the records that were actually projected
 * @param decision the re-checked allow
 * @param projections what was actually projected
 * @returns the release, or a deny when nothing was projectable
 */
function narrow(
  decision: PolicyAllow,
  projections: RecordProjection[],
): FilterOutcome {
  if (projections.length === 0) {
    return {
      kind: 'denied',
      decision: {
        effect: 'deny',
        rationaleCode: 'category-not-permitted',
        policyVersion: decision.policyVersion,
        decidedAt: decision.decidedAt,
      },
    };
  }

  const projected = new Set(
    projections.map((projection) => projection.recordId),
  );
  const records = decision.records.filter((record) =>
    projected.has(record.recordId),
  );
  const categories = new Set(records.map((record) => record.category));

  return {
    kind: 'released',
    decision: {
      ...decision,
      approvedCategories: decision.approvedCategories.filter((category) =>
        categories.has(category),
      ),
      records,
    },
    projections,
  };
}

/**
 * checks whether a value is a JSON scalar
 * @param value any value to test
 * @returns true for strings, finite numbers, booleans and null
 */
function isScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/**
 * checks whether a value is a plain (non-array) object
 * @param value any value to test
 * @returns true for non-null, non-array objects
 */
function isPlainObject(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
