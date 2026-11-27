import { toRun } from '../vault/sources';

import type { DatabaseSync } from 'node:sqlite';

import type { SyncRunRow } from '../vault/sources';

/**
 * read model over imported sources: the file-to-record mapping, the last sync,
 * known sources, gaps and held-back conflicts; read-only; writes live in
 * `src/vault/sources.ts`
 */

type Row = Record<string, unknown>;

/** reason code of the run-level summary event when every file was rejected */
const ALL_REJECTED = 'all-files-rejected';

export interface SourceRecordMap {
  boxFileId: string;
  version: string;
  sha256: string;
  provider: string;
  verification: string;
  importedAt: string;
  records: Array<{ id: string; category: string; sensitivity: string }>;
}

export interface SyncGap {
  /** the Box file id, or null when the whole run failed */
  fileId: string | null;
  reason: string;
}

/** an open `record_conflicts` row: the stored record and the incoming version */
export interface SourceConflict {
  id: string;
  recordId: string;
  fileId: string;
  incomingVersion: string;
  incomingSha256: string;
  detectedAt: string;
}

export interface SyncOverview {
  lastRun: SyncRunRow | null;
  lastSuccessfulAt: string | null;
  sources: SourceRecordMap[];
  /** files the latest run could not import, with reason codes only */
  gaps: SyncGap[];
}

/**
 * lists every imported source file version with the records it contains, so a file
 * that spans several categories stays mappable to each of its records
 * @param db an open vault
 * @param patientId the vault patient
 * @returns sources in import order, each with its records
 */
export function listSourceRecordMap(
  db: DatabaseSync,
  patientId: string,
): SourceRecordMap[] {
  const sources = db
    .prepare('SELECT * FROM record_sources WHERE patient_id = ? ORDER BY id')
    .all(patientId) as Row[];
  const records = db.prepare(
    'SELECT id, category, sensitivity FROM records WHERE source_id = ? ORDER BY rowid',
  );

  return sources.map((source) => ({
    boxFileId: source.box_file_id as string,
    version: source.version as string,
    sha256: source.sha256 as string,
    provider: source.provider as string,
    verification: source.verification as string,
    importedAt: source.imported_at as string,
    records: records.all(source.id as number) as SourceRecordMap['records'],
  }));
}

/**
 * lists the ids of every record imported from one Box file
 * @param db an open vault
 * @param boxFileId the numeric Box file id of the source
 * @returns ids of the records in that file, in import order
 */
export function recordIdsForFile(
  db: DatabaseSync,
  boxFileId: string,
): string[] {
  const rows = db
    .prepare(
      `SELECT r.id FROM records r JOIN record_sources s ON s.id = r.source_id
       WHERE s.box_file_id = ? ORDER BY r.rowid`,
    )
    .all(boxFileId) as Array<{ id: string }>;

  return rows.map((row) => row.id);
}

/**
 * lists the Box files that contain any of the given records
 * @param db an open vault
 * @param recordIds the ids to look up
 * @returns distinct Box file ids
 */
export function filesForRecords(
  db: DatabaseSync,
  recordIds: readonly string[],
): string[] {
  const statement = db.prepare(
    `SELECT s.box_file_id AS file FROM records r JOIN record_sources s ON s.id = r.source_id WHERE r.id = ?`,
  );
  const files = new Set<string>();

  for (const id of recordIds) {
    const row = statement.get(id) as { file: string } | undefined;

    if (row) {
      files.add(row.file);
    }
  }

  return [...files];
}

/**
 * lists the Box files whose every record is inside a set of allowed record ids; the
 * download gate's test, since a file is a single unit of disclosure
 * @param db an open vault
 * @param patientId the vault patient
 * @param allowedRecordIds the record ids in scope
 * @returns Box file ids that may be downloaded
 */
export function filesFullyWithin(
  db: DatabaseSync,
  patientId: string,
  allowedRecordIds: ReadonlySet<string>,
): string[] {
  return listSourceRecordMap(db, patientId)
    .filter(
      (source) =>
        source.records.length > 0 &&
        source.records.every((record) => allowedRecordIds.has(record.id)),
    )
    .map((source) => source.boxFileId);
}

/**
 * lists the content-free failures of one run (per-file rejections or a whole-run
 * listing failure), from the audit log
 * @param db an open vault
 * @param runId the sync run id
 * @returns file ids (null for a whole-run failure) with reason codes
 */
export function listRunFailures(db: DatabaseSync, runId: string): SyncGap[] {
  const rows = db
    .prepare(
      `SELECT target_id AS fileId, json_extract(details, '$.reason') AS reason FROM audit_events
       WHERE request_id = ? AND type = 'sync.failed'
         AND json_extract(details, '$.reason') <> ?
       ORDER BY seq`,
    )
    .all(runId, ALL_REJECTED) as unknown as SyncGap[];

  return rows.map((row) => ({ fileId: row.fileId, reason: row.reason }));
}

/**
 * lists open conflicts held back from the vault, oldest first; they stay here until
 * the owner resolves them; nothing resolves them silently
 * @param db an open vault
 * @param patientId the vault patient
 * @returns open conflicts against this patient's records
 */
export function listConflicts(
  db: DatabaseSync,
  patientId: string,
): SourceConflict[] {
  return db
    .prepare(
      `SELECT c.id AS id, c.record_id AS recordId, c.box_file_id AS fileId,
              c.incoming_version AS incomingVersion, c.incoming_sha256 AS incomingSha256,
              c.detected_at AS detectedAt
       FROM record_conflicts c JOIN records r ON r.id = c.record_id
       WHERE r.patient_id = ? AND c.status = 'open'
       ORDER BY c.detected_at, c.id`,
    )
    .all(patientId) as unknown as SourceConflict[];
}

/**
 * returns the last sync, known sources and gaps for the owner's source list
 * @param db an open vault
 * @param patientId the vault patient
 * @returns the last run, last success time, known sources and gaps
 */
export function getSyncOverview(
  db: DatabaseSync,
  patientId: string,
): SyncOverview {
  const last = db
    .prepare(
      'SELECT * FROM sync_runs WHERE patient_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1',
    )
    .get(patientId);
  const success = db
    .prepare(
      `SELECT finished_at AS finishedAt FROM sync_runs WHERE patient_id = ? AND status IN ('succeeded', 'partial')
       ORDER BY finished_at DESC LIMIT 1`,
    )
    .get(patientId) as { finishedAt: string } | undefined;
  const lastRun = last ? toRun(last) : null;

  return {
    lastRun,
    lastSuccessfulAt: success?.finishedAt ?? null,
    sources: listSourceRecordMap(db, patientId),
    gaps: lastRun ? listRunFailures(db, lastRun.id) : [],
  };
}
