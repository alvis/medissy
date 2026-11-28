import { recordConflictSchema, recordEnvelopeSchema } from '../contracts';

import type { DatabaseSync } from 'node:sqlite';

import type { RecordEnvelope } from '../contracts';

const SHA_PREFIX = 12;

type Row = Record<string, unknown>;

/** provider recorded for content the catalogue does not vouch for */
export const UNCLASSIFIED_PROVIDER = 'unclassified';

/**
 * rebuilds the envelopes already stored for one Box file, across versions
 * @param db an open vault
 * @param fileId the numeric Box file id
 * @returns the stored envelopes
 */
export function loadFileEnvelopes(
  db: DatabaseSync,
  fileId: string,
): RecordEnvelope[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.patient_id, r.resource_type, r.resource, r.category, r.sensitivity, r.status,
              r.authored_at, s.provider, s.box_file_id, s.version, s.sha256, s.verification, s.imported_at
       FROM records r JOIN record_sources s ON s.id = r.source_id
       WHERE s.box_file_id = ? AND s.provider <> ? ORDER BY r.id`,
    )
    .all(fileId, UNCLASSIFIED_PROVIDER) as Row[];

  return rows.map((row) =>
    recordEnvelopeSchema.parse({
      id: row.id,
      patientId: row.patient_id,
      resourceType: row.resource_type,
      resource: JSON.parse(row.resource as string),
      category: row.category,
      sensitivity: row.sensitivity,
      status: row.status,
      source: {
        provider: row.provider,
        boxFileId: row.box_file_id,
        version: row.version,
        sha256: row.sha256,
        verification: row.verification,
        importedAt: row.imported_at,
        ...(row.authored_at ? { authoredAt: row.authored_at } : {}),
      },
    }),
  );
}

/**
 * parks incoming envelopes beside the stored records they collide with; rows
 * are inserted `open` and nothing stored is touched; a conflict already
 * recorded for the same (record, version, digest) is left as it is
 * @param db an open vault
 * @param input the incoming envelopes and the detection instant
 * @param input.incoming incoming envelopes; each `id` names the stored record
 * it collides with
 * @param input.detectedAt when the conflict was found
 * @returns how many new conflict rows were written
 */
export function recordConflicts(
  db: DatabaseSync,
  input: { incoming: readonly RecordEnvelope[]; detectedAt: string },
): number {
  const exists = db.prepare(
    `SELECT 1 FROM record_conflicts
     WHERE record_id = ? AND incoming_version = ? AND incoming_sha256 = ?`,
  );
  const insert = db.prepare(
    `INSERT INTO record_conflicts (id, record_id, box_file_id, incoming_version, incoming_sha256, incoming_record, detected_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`,
  );
  let written = 0;

  for (const envelope of input.incoming) {
    const { source } = envelope;
    const detectedAt = new Date(input.detectedAt).toISOString();
    const conflict = recordConflictSchema.parse({
      id: `cf:${envelope.id}:${source.sha256.slice(0, SHA_PREFIX)}:${source.version}`,
      recordId: envelope.id,
      boxFileId: source.boxFileId,
      incomingVersion: source.version,
      incomingSha256: source.sha256,
      incoming: envelope,
      detectedAt,
      status: 'open',
    });

    if (!exists.get(envelope.id, source.version, source.sha256)) {
      insert.run(
        conflict.id,
        conflict.recordId,
        conflict.boxFileId,
        conflict.incomingVersion,
        conflict.incomingSha256,
        JSON.stringify(conflict.incoming),
        detectedAt,
      );
      written += 1;
    }
  }

  return written;
}

/**
 * remembers that a file with this digest was seen but not vouched for; only
 * the source row is kept; there is no record row, so nothing is releasable
 * @param db an open vault
 * @param input the file facts
 * @param input.patientId the vault patient
 * @param input.syncRunId the run that saw it
 * @param input.file the file id, version and digest
 * @param input.file.fileId the numeric Box file id
 * @param input.file.version the source version label
 * @param input.file.sha256 the body digest
 * @param input.seenAt when it was seen
 * @returns true when a new source row was written
 */
export function recordUnclassifiedSource(
  db: DatabaseSync,
  input: {
    patientId: string;
    syncRunId: string;
    file: { fileId: string; version: string; sha256: string };
    seenAt: string;
  },
): boolean {
  const { file } = input;
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO record_sources (patient_id, sync_run_id, provider, box_file_id, version, sha256, verification, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, 'unverified', ?)`,
    )
    .run(
      input.patientId,
      input.syncRunId,
      UNCLASSIFIED_PROVIDER,
      file.fileId,
      file.version,
      file.sha256,
      new Date(input.seenAt).toISOString(),
    );

  return Number(result.changes) > 0;
}
