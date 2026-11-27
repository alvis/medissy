/**
 * the FHIR R4 `collection` Bundle of a release; entries carry absolute
 * `urn:uuid:` fullUrls derived from the receipt and the resource, and every
 * internal reference points at an entry's fullUrl, so the bundle resolves on
 * its own and a replay of the same receipt yields the same bundle
 */
import { createHash } from 'node:crypto';

import type { FhirCollectionBundle } from '../contracts';
import type {
  ProjectedResource,
  ProjectedValue,
  RecordProjection,
} from '../vault/filter';

/** regex splitting 32 hex digits into UUID fields; the version digit is replaced */
const UUID_FIELDS =
  /^([0-9a-f]{8})([0-9a-f]{4})[0-9a-f]([0-9a-f]{3})([0-9a-f])([0-9a-f]{3})([0-9a-f]{12}).*$/u;

/** RFC 9562 variant `10xx` as a leading hex digit */
const VARIANT_DIGITS = '89ab';

const HEX_RADIX = 16;

/**
 * builds the FHIR R4 collection bundle of the released resources; each entry gets
 * an absolute `urn:uuid:` fullUrl derived from the receipt and the resource,
 * so a replay of the same receipt yields the same bundle, and every internal
 * `Type/id` reference is rewritten to its entry's fullUrl
 * @param projections the released, reference-closed projections
 * @param meta the bundle timestamp and the receipt the URNs derive from
 * @param meta.issuedAt the bundle timestamp
 * @param meta.receiptId the release receipt
 * @returns a `collection` Bundle with one entry per released resource
 */
export function toBundle(
  projections: readonly RecordProjection[],
  meta: { issuedAt: string; receiptId: string },
): FhirCollectionBundle {
  const urls = new Map(
    projections.map(({ resource }) => {
      const key = `${resource.resourceType}/${resource.id}`;

      return [key, entryUrn(meta.receiptId, key)];
    }),
  );

  return {
    resourceType: 'Bundle',
    type: 'collection',
    timestamp: meta.issuedAt,
    entry: projections.map(({ resource }) => ({
      fullUrl: urls.get(`${resource.resourceType}/${resource.id}`),
      resource: rewriteReferences(resource, urls) as ProjectedResource,
    })),
  };
}

/**
 * builds a deterministic RFC 9562 version-8 UUID URN for one bundle entry
 * @param receiptId the release receipt
 * @param key the entry's `Type/id`
 * @returns `urn:uuid:` and a UUID derived from both
 */
function entryUrn(receiptId: string, key: string): string {
  const hex = createHash('sha256').update(`${receiptId}\n${key}`).digest('hex');

  return `urn:uuid:${hex.replace(
    UUID_FIELDS,
    (
      ...[, a, b, c, v, d, e]: [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    ) =>
      `${a}-${b}-8${c}-${VARIANT_DIGITS.charAt(Number.parseInt(v, HEX_RADIX) % VARIANT_DIGITS.length)}${d}-${e}`,
  )}`;
}

/**
 * rewrites every FHIR Reference whose `reference` names a bundled resource to
 * that entry's fullUrl; the guard has already dropped any that do not
 * @param value a projected value
 * @param urls fullUrl by `Type/id`
 * @returns the value with internal references rewritten
 */
function rewriteReferences(
  value: ProjectedValue,
  urls: ReadonlyMap<string, string>,
): ProjectedValue {
  if (Array.isArray(value)) {
    return value.map((item: ProjectedValue) => rewriteReferences(item, urls));
  }

  if (typeof value !== 'object' || value === null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === 'reference' && typeof item === 'string' && urls.has(item)
        ? (urls.get(item) ?? item)
        : rewriteReferences(item, urls),
    ]),
  );
}
