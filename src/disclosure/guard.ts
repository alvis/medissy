/**
 * the release guard (brief §7 step 6); it runs at the last moment before the
 * receipt transaction and reconstructs the release from authorised
 * projections only: every id must be in the allowed decision and in the
 * filter's output, or the whole release fails closed; it then closes the
 * release over its references: a reference to a resource that is not released
 * (including the patient, when the patient resource is not released) is
 * stripped, and a Provenance that would lose a target is withheld, repeating
 * until nothing more drops, so the bundle can only ever reference resources
 * inside itself; each survivor must agree with its decision entry
 *
 * errors are content-free: they never name a record id or echo a field
 */
import type { PolicyAllow } from '../policy/decide';
import type {
  ProjectedResource,
  ProjectedValue,
  RecordProjection,
} from '../vault/filter';

/** error raised when a release would contain anything not authorised */
export class ReleaseGuardError extends Error {
  /** @param message a fixed description that never contains record content */
  constructor(message: string) {
    super(message);
    this.name = 'ReleaseGuardError';
  }
}

/** what the guard checks */
export interface GuardParams {
  /** the ids about to be released (selection plus pairing) */
  recordIds: readonly string[];
  /** the allow decision the filter re-checked and narrowed */
  decision: PolicyAllow;
  /** the filter's projections for that decision */
  projections: readonly RecordProjection[];
}

/**
 * reconstructs the release from authorised projections and closes it over its
 * references
 * @param params the ids, the allow decision and the filter's projections
 * @returns the released projections in filter order, references closed; may
 * be empty when closure withheld everything
 * @throws {ReleaseGuardError} when any id is not allowed, not projected or
 * repeated, or a projection disagrees with its decision entry
 */
export function guardRelease(params: GuardParams): RecordProjection[] {
  const { recordIds, decision, projections } = params;
  const decided = new Map(
    decision.records.map((record) => [record.recordId, record]),
  );
  const projected = new Set(
    projections.map((projection) => projection.recordId),
  );

  if (new Set(recordIds).size !== recordIds.length) {
    throw new ReleaseGuardError('a record id is repeated in the release');
  }

  if (recordIds.some((id) => !decided.has(id) || !projected.has(id))) {
    throw new ReleaseGuardError('a release id is outside the allowed set');
  }

  const wanted = new Set(recordIds);
  const closed = closeReferences(
    projections.filter((projection) => wanted.has(projection.recordId)),
  );
  const categories = new Set(decision.approvedCategories);

  for (const projection of closed) {
    const record = decided.get(projection.recordId);

    if (
      record?.category !== projection.category ||
      record.grant.id !== projection.grant.id ||
      record.grant.version !== projection.grant.version ||
      !categories.has(projection.category)
    ) {
      throw new ReleaseGuardError('a projection disagrees with its decision');
    }
  }

  return closed;
}

/**
 * strips every reference that does not resolve inside the set, and withholds
 * each Provenance that loses a target, until the set is stable
 * @param projections the candidate projections
 * @returns the closed projections, in input order
 */
export function closeReferences(
  projections: readonly RecordProjection[],
): RecordProjection[] {
  let current = [...projections];

  for (;;) {
    const keys = keysOf(current);
    const next = current.flatMap((projection): RecordProjection[] => {
      const resource = stripResource(projection.resource, keys);

      return resource ? [{ ...projection, resource }] : [];
    });

    if (
      next.length === current.length &&
      next.every((item, index) => item.resource === current[index]?.resource)
    ) {
      return next;
    }

    current = next;
  }
}

/**
 * collects the `Type/id` key of every resource in a set
 * @param projections the candidate release
 * @returns a `Type/id` key per released resource
 */
function keysOf(projections: readonly RecordProjection[]): ReadonlySet<string> {
  return new Set(
    projections.map(
      ({ resource }) => `${resource.resourceType}/${resource.id}`,
    ),
  );
}

/**
 * strips unresolved references from one resource
 * @param resource the projected resource
 * @param keys the resolvable `Type/id` keys
 * @returns the same object when nothing changed, a stripped copy, or
 * undefined when a Provenance lost a target
 */
function stripResource(
  resource: ProjectedResource,
  keys: ReadonlySet<string>,
): ProjectedResource | undefined {
  const { resourceType, id, ...fields } = resource;
  let changed = false;
  const kept: Record<string, ProjectedValue> = {};

  for (const [field, value] of Object.entries(fields)) {
    const stripped = stripValue(value, keys);

    if (stripped !== value) {
      changed = true;
    }

    if (stripped !== undefined) {
      kept[field] = stripped;
    }
  }

  if (!changed) {
    return resource;
  }

  if (resourceType === 'Provenance') {
    return undefined;
  }

  return { ...kept, resourceType, id };
}

/**
 * strips unresolved references from a value; a FHIR Reference is an object
 * with a string `reference`; it is kept only when that resolves
 * @param value the projected value
 * @param keys the resolvable `Type/id` keys
 * @returns the value itself when unchanged, a stripped copy, or undefined
 * when nothing remains
 */
function stripValue(
  value: ProjectedValue,
  keys: ReadonlySet<string>,
): ProjectedValue | undefined {
  if (Array.isArray(value)) {
    return stripArray(value as readonly ProjectedValue[], keys);
  }

  if (typeof value !== 'object' || value === null) {
    return value;
  }

  const object = value as Readonly<Record<string, ProjectedValue>>;

  if (typeof object.reference === 'string') {
    return keys.has(object.reference) ? value : undefined;
  }

  let changed = false;
  const kept: Record<string, ProjectedValue> = {};

  for (const [field, child] of Object.entries(object)) {
    const stripped = stripValue(child, keys);

    changed ||= stripped !== child;

    if (stripped !== undefined) {
      kept[field] = stripped;
    }
  }

  if (!changed) {
    return value;
  }

  return Object.keys(kept).length > 0 ? kept : undefined;
}

/**
 * strips unresolved references from each array element; an emptied array is
 * dropped
 * @param items the array elements
 * @param keys the resolvable `Type/id` keys
 * @returns the array itself when unchanged, a stripped copy, or undefined
 */
function stripArray(
  items: readonly ProjectedValue[],
  keys: ReadonlySet<string>,
): ProjectedValue | undefined {
  const kept = items.flatMap((item) => {
    const stripped = stripValue(item, keys);

    return stripped === undefined ? [] : [stripped];
  });

  if (
    kept.length === items.length &&
    kept.every((item, index) => item === items[index])
  ) {
    return items;
  }

  return kept.length > 0 ? kept : undefined;
}
