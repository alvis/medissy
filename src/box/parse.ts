import { z } from 'zod';

import { recordEnvelopeSchema, resourceTypeSchema } from '../contracts';

import { resourceKey } from './curation';
import {
  ALIAS_TOKEN,
  DEFAULT_LIMITS,
  checkPatients,
  decodeText,
  sha256Hex,
} from './ingest';

import type { RecordEnvelope } from '../contracts';

import type { Curation } from './curation';
import type { BundleResource, IngestLimits } from './ingest';
import type { RejectionReason, SourceFileEntry } from './types';

/**
 * labels for content the catalogue does not vouch for; the closed category set
 * has no "unclassified" member, so any copy of such content that must be parked
 * beside an existing record carries the most restrictive labels; it is never in
 * `records`, so no grant can release it; whoever accepts it later must
 * re-classify it
 */
export const UNVOUCHED_LABELS = {
  category: 'mental-health',
  sensitivity: 'restricted',
} as const;

/** a validated file whose bytes match a curated digest, ready to persist */
export interface ParsedFile {
  fileId: string;
  version: string;
  sha256: string;
  provider: string;
  verification: RecordEnvelope['source']['verification'];
  records: RecordEnvelope[];
}

/** a structurally valid file whose digest the catalogue does not list */
export interface UncuratedFile {
  fileId: string;
  version: string;
  sha256: string;
  /** bundle resources, or null for a plain-text file */
  resources: readonly BundleResource[] | null;
}

export type ParseOutcome =
  | { ok: true; kind: 'curated'; file: ParsedFile }
  | { ok: true; kind: 'uncurated'; file: UncuratedFile }
  | { ok: false; reason: RejectionReason };

interface ParseContext {
  curation: Curation;
  limits?: IngestLimits;
  importedAt: string;
}

interface InspectContext {
  curation: Curation;
  limits: IngestLimits;
}

const bundleSchema = z.looseObject({
  resourceType: z.literal('Bundle'),
  type: z.literal('collection'),
  entry: z.array(
    z.looseObject({
      resource: z.looseObject({ resourceType: z.string(), id: z.string() }),
    }),
  ),
});

/**
 * parses a FHIR collection Bundle body into its resources
 * @param text the decoded body
 * @param limits size caps
 * @returns resources, or a rejection reason
 */
function parseBundle(
  text: string,
  limits: IngestLimits,
): BundleResource[] | RejectionReason {
  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch {
    return 'malformed-json';
  }

  const bundle = bundleSchema.safeParse(json);

  if (!bundle.success) {
    return 'malformed-structure';
  }

  const resources = bundle.data.entry.map((entry) => entry.resource);

  if (resources.length === 0) {
    return 'empty';
  }

  return resources.length > limits.maxEntriesPerFile
    ? 'too-many-entries'
    : resources;
}

/**
 * runs structural checks on a Bundle that need no catalogue: supported resource
 * types, one patient only, no repeated resource
 * @param text the decoded body
 * @param context the catalogue and size caps
 * @returns the resources, or a rejection reason
 */
function inspectBundle(
  text: string,
  context: InspectContext,
): BundleResource[] | RejectionReason {
  const resources = parseBundle(text, context.limits);

  if (typeof resources === 'string') {
    return resources;
  }

  if (
    !resources.every(
      (r) => resourceTypeSchema.safeParse(r.resourceType).success,
    )
  ) {
    return 'unsupported-resource';
  }

  const problem = checkPatients(resources, context.curation.patientId);

  if (problem) {
    return problem;
  }

  const keys = resources.map((r) => resourceKey(r.resourceType, r.id));

  return new Set(keys).size === keys.length
    ? resources
    : 'duplicate-resource-id';
}

/**
 * checks a plain-text file, which is never parsed or acted on; it only has to carry the
 * right patient marker
 * @param text the decoded body
 * @param curation the curated catalogue
 * @returns a rejection reason, or undefined when the marker is right
 */
function inspectText(
  text: string,
  curation: Curation,
): RejectionReason | undefined {
  const markers = [...text.matchAll(ALIAS_TOKEN)].map((m) => m[0]);

  if (markers.some((marker) => !curation.patientAliases.has(marker))) {
    return 'foreign-patient';
  }

  return markers.length === 0 ? 'missing-patient-marker' : undefined;
}

/**
 * stamps each envelope with the provenance of this download and validates it
 * @param envelopes curated envelopes for this digest
 * @param file the download facts: file id, version and digest
 * @param importedAt the import instant
 * @returns validated envelopes, or `invalid-record`
 */
function withProvenance(
  envelopes: readonly RecordEnvelope[],
  file: Pick<UncuratedFile, 'fileId' | 'version' | 'sha256'>,
  importedAt: string,
): RecordEnvelope[] | RejectionReason {
  const result: RecordEnvelope[] = [];

  for (const envelope of envelopes) {
    const parsed = recordEnvelopeSchema.safeParse({
      ...envelope,
      source: {
        ...envelope.source,
        boxFileId: file.fileId,
        version: file.version,
        sha256: file.sha256,
        importedAt,
      },
    });

    if (!parsed.success) {
      return 'invalid-record';
    }

    result.push(parsed.data);
  }

  return result;
}

/**
 * validates a downloaded file; pure: no I/O, no clock, and the body is only
 * ever treated as data; a file is labelled from the catalogue only when its
 * SHA-256 equals a digest the catalogue lists; any other valid file comes back
 * `uncurated` and is never labelled
 * @param input the entry facts and the downloaded bytes
 * @param input.entry the metadata entry, already through `checkEntry`
 * @param input.bytes the downloaded body
 * @param context the catalogue, caps and import instant
 * @returns the parsed file, or the rejection reason
 */
export function parseSourceFile(
  input: { entry: SourceFileEntry; bytes: Uint8Array },
  context: ParseContext,
): ParseOutcome {
  const { entry, bytes } = input;
  const limits = context.limits ?? DEFAULT_LIMITS;
  const early =
    bytes.length === 0
      ? 'empty'
      : bytes.length > limits.maxFileBytes
        ? 'oversized'
        : bytes.length === entry.size
          ? undefined
          : 'size-mismatch';
  const text = decodeText(bytes);

  if (early) {
    return { ok: false, reason: early };
  }

  if (text === undefined) {
    return { ok: false, reason: 'not-utf8' };
  }

  const isJson = entry.name.toLowerCase().endsWith('.json');
  const inspected = isJson
    ? inspectBundle(text, { curation: context.curation, limits })
    : inspectText(text, context.curation);

  if (typeof inspected === 'string') {
    return { ok: false, reason: inspected };
  }

  const sha256 = sha256Hex(bytes);
  const base = { fileId: entry.id, version: entry.version, sha256 };
  const curated = context.curation.byDigest.get(sha256);

  if (!curated) {
    return {
      ok: true,
      kind: 'uncurated',
      file: { ...base, resources: Array.isArray(inspected) ? inspected : null },
    };
  }

  const records = withProvenance(curated, base, context.importedAt);

  if (typeof records === 'string') {
    return { ok: false, reason: records };
  }

  const [first] = records;

  return {
    ok: true,
    kind: 'curated',
    file: {
      ...base,
      provider: first?.source.provider ?? '',
      verification: first?.source.verification ?? 'unverified',
      records,
    },
  };
}

/**
 * builds conflict copies of changed content for records already imported from
 * the same Box file; the changed resource replaces the old one, provenance
 * points at the incoming download, and the labels are `UNVOUCHED_LABELS`,
 * never the existing record's
 * @param existing the envelopes already stored for the file
 * @param draft the uncurated incoming file
 * @param importedAt the import instant
 * @returns validated incoming envelopes, or `invalid-record`
 */
export function incomingCopies(
  existing: readonly RecordEnvelope[],
  draft: UncuratedFile,
  importedAt: string,
): RecordEnvelope[] | RejectionReason {
  const copies: RecordEnvelope[] = [];

  for (const old of existing) {
    const key = resourceKey(old.resourceType, old.resource.id);
    const resource = draft.resources
      ? draft.resources.find((r) => resourceKey(r.resourceType, r.id) === key)
      : old.resource;

    if (resource) {
      const parsed = recordEnvelopeSchema.safeParse({
        ...old,
        ...UNVOUCHED_LABELS,
        resource,
        status: 'current',
        source: {
          ...old.source,
          boxFileId: draft.fileId,
          version: draft.version,
          sha256: draft.sha256,
          importedAt,
        },
      });

      if (!parsed.success) {
        return 'invalid-record';
      }

      copies.push(parsed.data);
    }
  }

  return copies;
}
