import { createHash } from 'node:crypto';

import type { RejectionReason, SourceFileEntry } from './types';

/** low demo caps; the connector allows far more (64 MiB), the demo needs far less */
export const DEFAULT_LIMITS = {
  maxFileBytes: 262_144,
  maxFiles: 100,
  maxEntriesPerFile: 100,
} as const;
export type IngestLimits = { [K in keyof typeof DEFAULT_LIMITS]: number };

const FILE_ID = /^\d{1,32}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,119}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const EXTENSION = /\.(json|txt)$/i;
const PATIENT_REFERENCE = /Patient\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})/;
export const ALIAS_TOKEN = /\bSYNTH-\d+\b/g;

/** where a file's metadata places it, against the allowed folder */
export interface Placement {
  parentId: string;
  folderId: string;
  limits?: IngestLimits;
}

/** a bundle entry's resource: any FHIR resource with a type and an id */
export type BundleResource = Record<string, unknown> & {
  resourceType: string;
  id: string;
};

/**
 * checks whether a string is a plain numeric Box file id (no paths, links or names)
 * @param id an untrusted id
 * @returns true for 1-32 digits
 */
export function isFileId(id: string): boolean {
  return FILE_ID.test(id);
}

/**
 * computes the lower-case hex SHA-256 of a body
 * @param bytes the body
 * @returns the digest
 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * checks what the listing and metadata say about a file before downloading it;
 * only a numeric id from the allowed folder can ever reach a download call, so
 * names, paths and links cannot steer the fetch
 * @param entry the untrusted metadata entry
 * @param placement where the metadata puts the file, the allowed folder and
 * the size caps
 * @returns the rejection reason, or undefined when the file may be fetched
 */
export function checkEntry(
  entry: SourceFileEntry,
  placement: Placement,
): RejectionReason | undefined {
  const { parentId, folderId, limits = DEFAULT_LIMITS } = placement;

  if (!isFileId(entry.id)) {
    return 'invalid-file-id';
  }

  if (!VERSION.test(entry.version)) {
    return 'invalid-version';
  }

  if (!SAFE_NAME.test(entry.name) || entry.name.includes('..')) {
    return 'unsafe-name';
  }

  if (!EXTENSION.test(entry.name)) {
    return 'unsupported-type';
  }

  if (parentId !== folderId) {
    return 'not-in-allowed-folder';
  }

  if (!Number.isInteger(entry.size) || entry.size < 0) {
    return 'malformed-structure';
  }

  return entry.size > limits.maxFileBytes ? 'oversized' : undefined;
}

/**
 * collects every patient id a value refers to through FHIR `reference` strings
 * @param value any JSON value
 * @returns patient ids found in `Patient/<id>` references
 */
function patientReferences(value: unknown): Set<string> {
  const found = new Set<string>();

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
    } else if (typeof node === 'object' && node !== null) {
      for (const [key, child] of Object.entries(node)) {
        const match =
          key === 'reference' && typeof child === 'string'
            ? PATIENT_REFERENCE.exec(child)
            : null;

        if (match?.[1]) {
          found.add(match[1]);
        } else {
          visit(child);
        }
      }
    }
  };

  visit(value);

  return found;
}

/**
 * returns the patient ids one resource speaks for: its own id when it is a Patient,
 * otherwise whoever it references
 * @param resource the bundle entry's resource
 * @returns every patient id the resource is or points to
 */
function patientIdsOf(resource: BundleResource): Set<string> {
  const ids = patientReferences(resource);

  if (resource.resourceType === 'Patient') {
    ids.add(resource.id);
  }

  return ids;
}

/**
 * decides whether a set of resources belongs to the expected patient alone
 * @param resources the file's resources
 * @param expected the expected patient id
 * @returns a rejection reason, or undefined when every reference is the patient's
 */
export function checkPatients(
  resources: readonly BundleResource[],
  expected: string,
): RejectionReason | undefined {
  const ids = resources.flatMap((resource) => [...patientIdsOf(resource)]);
  const foreign = ids.some((id) => id !== expected);

  if (!foreign) {
    return undefined;
  }

  return ids.includes(expected) ? 'mixed-patient' : 'foreign-patient';
}

/**
 * decodes a body as strict UTF-8 text without NUL bytes
 * @param bytes the body
 * @returns the text, or undefined when it is not clean UTF-8
 */
export function decodeText(bytes: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);

    return text.includes('\u0000') ? undefined : text;
  } catch {
    return undefined;
  }
}
