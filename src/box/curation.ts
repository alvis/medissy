import { readFileSync } from 'node:fs';

import { recordEnvelopeSchema } from '../contracts';

import type { RecordEnvelope } from '../contracts';

const DIGEST_PREFIX = 12;

/**
 * the curated catalogue the import classifies against (brief §6: curated
 * categories, not a diagnosis algorithm); it is keyed by the SHA-256 of each
 * source file, never by Box file id: a file's curated category and sensitivity
 * are accepted only when the downloaded bytes hash to a digest the catalogue
 * lists; any other content is never labelled from the catalogue
 */
export interface Curation {
  readonly patientId: string;
  /** external identifiers of the patient that may appear in text bodies */
  readonly patientAliases: ReadonlySet<string>;
  /** curated records by the digest of the file they came from */
  readonly byDigest: ReadonlyMap<string, readonly RecordEnvelope[]>;
}

/**
 * builds the lookup key of a FHIR resource: its type and id
 * @param resourceType FHIR type such as Observation
 * @param resourceId id unique within that type
 * @returns a `Type/id` string used as a map key
 */
export function resourceKey(resourceType: string, resourceId: string): string {
  return `${resourceType}/${resourceId}`;
}

/**
 * collects the external identifiers of the patient resource
 * @param envelopes the curated envelopes
 * @returns identifier values such as `SYNTH-0001`
 */
function aliasesOf(envelopes: readonly RecordEnvelope[]): Set<string> {
  const aliases = new Set<string>();

  for (const envelope of envelopes) {
    const identifiers = envelope.resource.identifier;

    if (envelope.resourceType === 'Patient' && Array.isArray(identifiers)) {
      for (const identifier of identifiers) {
        const value = (identifier as { value?: unknown } | null)?.value;

        if (typeof value === 'string') {
          aliases.add(value);
        }
      }
    }
  }

  return aliases;
}

/**
 * requires every record of one digest to share a provider and verification,
 * since `record_sources` stores one of each per file
 * @param digest the file digest
 * @param records the digest's curated records
 */
function assertUniformSource(
  digest: string,
  records: readonly RecordEnvelope[],
): void {
  const [first] = records;
  const uniform = records.every(
    (record) =>
      record.source.provider === first?.source.provider &&
      record.source.verification === first.source.verification,
  );

  if (!uniform) {
    throw new Error(
      `curation: digest ${digest.slice(0, DIGEST_PREFIX)} mixes providers or verification`,
    );
  }
}

/**
 * validates and indexes the curated catalogue
 * @param raw the curated envelopes, as parsed JSON
 * @param patientId the one patient the vault holds
 * @returns the indexed catalogue
 */
export function buildCuration(
  raw: readonly unknown[],
  patientId: string,
): Curation {
  const byDigest = new Map<string, RecordEnvelope[]>();
  const keys = new Set<string>();
  const ids = new Set<string>();
  const all = raw.map((item) => recordEnvelopeSchema.parse(item));

  for (const envelope of all) {
    const key = resourceKey(envelope.resourceType, envelope.resource.id);

    if (envelope.patientId !== patientId) {
      throw new Error(`curation: ${envelope.id} belongs to another patient`);
    }

    if (keys.has(key) || ids.has(envelope.id)) {
      throw new Error(
        `curation: duplicate resource or record id ${envelope.id}`,
      );
    }

    keys.add(key);
    ids.add(envelope.id);
    byDigest.set(envelope.source.sha256, [
      ...(byDigest.get(envelope.source.sha256) ?? []),
      envelope,
    ]);
  }

  for (const [digest, records] of byDigest) {
    assertUniformSource(digest, records);
  }

  return { patientId, patientAliases: aliasesOf(all), byDigest };
}

/**
 * loads the curated catalogue from a JSON file of record envelopes
 * @param path the catalogue file
 * @param patientId the one patient the vault holds
 * @returns the indexed catalogue
 */
export function loadCuration(path: string, patientId: string): Curation {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));

  if (!Array.isArray(parsed)) {
    throw new Error('curation: expected a JSON array of record envelopes');
  }

  return buildCuration(parsed, patientId);
}
