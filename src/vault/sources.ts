import { auditEventSchema } from '../contracts';

import type { DatabaseSync } from 'node:sqlite';

import type { AuditEvent, RecordEnvelope } from '../contracts';

/**
 * ingestion repository: sync runs, imported Box file versions, the curated
 * record copies and the file-to-record mapping; callers open the database
 * with `openVault`; nothing here opens or migrates one
 */

export type SyncStatus = 'running' | 'succeeded' | 'partial' | 'failed';

export interface SyncRunRow {
  id: string;
  patientId: string;
  trigger: 'owner' | 'seed' | 'test';
  adapter: 'box-connector' | 'fixture';
  folderId: string;
  status: SyncStatus;
  startedAt: string;
  finishedAt: string | null;
  filesSeen: number;
  filesImported: number;
  filesDuplicate: number;
  filesRejected: number;
  errorSummary: string | null;
}

export interface SyncRunStart {
  id: string;
  patientId: string;
  idempotencyKey?: string;
  trigger: SyncRunRow['trigger'];
  adapter: SyncRunRow['adapter'];
  folderId: string;
  startedAt: string;
}

export interface SyncRunFinish {
  status: Exclude<SyncStatus, 'running'>;
  finishedAt: string;
  filesSeen: number;
  filesImported: number;
  filesDuplicate: number;
  filesRejected: number;
  errorSummary: string | null;
}

/** a validated file, as `src/box/ingest.ts` produces it */
export interface ImportableFile {
  fileId: string;
  version: string;
  sha256: string;
  provider: string;
  verification: RecordEnvelope['source']['verification'];
  records: readonly RecordEnvelope[];
}

export type ImportOutcome =
  | { status: 'imported'; sourceId: number; recordCount: number }
  | { status: 'duplicate' }
  | { status: 'collision'; recordIds: string[] };

type Row = Record<string, unknown>;

/**
 * runs a body inside one `BEGIN IMMEDIATE` transaction
 * @param db an open vault
 * @param body the work to do atomically
 * @returns whatever the body returns
 */
export function inTransaction<T>(db: DatabaseSync, body: () => T): T {
  db.exec('BEGIN IMMEDIATE');

  try {
    const result = body();

    db.exec('COMMIT');

    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * maps a `sync_runs` row
 * @param row the raw row
 * @returns the typed run
 */
export function toRun(row: Row): SyncRunRow {
  return {
    id: row.id as string,
    patientId: row.patient_id as string,
    trigger: row.trigger as SyncRunRow['trigger'],
    adapter: row.adapter as SyncRunRow['adapter'],
    folderId: row.folder_id as string,
    status: row.status as SyncStatus,
    startedAt: row.started_at as string,
    finishedAt: row.finished_at as string | null,
    filesSeen: row.files_seen as number,
    filesImported: row.files_imported as number,
    filesDuplicate: row.files_duplicate as number,
    filesRejected: row.files_rejected as number,
    errorSummary: row.error_summary as string | null,
  };
}

/**
 * opens a sync run, or returns the earlier run with the same idempotency key
 * @param db an open vault
 * @param start the run's identity and trigger
 * @returns the run and whether it replays an earlier one
 */
export function startSyncRun(
  db: DatabaseSync,
  start: SyncRunStart,
): { run: SyncRunRow; replayed: boolean } {
  return inTransaction(db, () => {
    const key = start.idempotencyKey ?? null;
    const earlier =
      key === null
        ? undefined
        : db
            .prepare('SELECT * FROM sync_runs WHERE idempotency_key = ?')
            .get(key);

    if (earlier) {
      return { run: toRun(earlier), replayed: true };
    }

    db.prepare(
      `INSERT INTO sync_runs (id, patient_id, idempotency_key, trigger, adapter, folder_id, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
    ).run(
      start.id,
      start.patientId,
      key,
      start.trigger,
      start.adapter,
      start.folderId,
      start.startedAt,
    );

    const inserted = db
      .prepare('SELECT * FROM sync_runs WHERE id = ?')
      .get(start.id);

    return { run: toRun(inserted as Row), replayed: false };
  });
}

/**
 * closes a sync run with its counts
 * @param db an open vault
 * @param id the id of the run to close
 * @param finish the outcome and counts
 */
export function finishSyncRun(
  db: DatabaseSync,
  id: string,
  finish: SyncRunFinish,
): void {
  db.prepare(
    `UPDATE sync_runs SET status = ?, finished_at = ?, files_seen = ?, files_imported = ?,
       files_duplicate = ?, files_rejected = ?, error_summary = ? WHERE id = ?`,
  ).run(
    finish.status,
    finish.finishedAt,
    finish.filesSeen,
    finish.filesImported,
    finish.filesDuplicate,
    finish.filesRejected,
    finish.errorSummary,
    id,
  );
}

/**
 * appends an audit event; details are scalars only (log ids and counts)
 * @param db an open vault
 * @param event the event, validated against the contract before insert
 */
export function appendAuditEvent(db: DatabaseSync, event: AuditEvent): void {
  const valid = auditEventSchema.parse(event);

  db.prepare(
    `INSERT INTO audit_events (id, occurred_at, type, outcome, actor_kind, actor_issuer, actor_subject,
       patient_id, request_id, receipt_id, target_type, target_id, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    valid.id,
    new Date(valid.occurredAt).toISOString(),
    valid.type,
    valid.outcome,
    valid.actor.kind,
    valid.actor.issuer ?? null,
    valid.actor.subject ?? null,
    valid.patientId ?? null,
    valid.requestId ?? null,
    valid.receiptId ?? null,
    valid.target?.type ?? null,
    valid.target?.id ?? null,
    JSON.stringify(valid.details),
  );
}

/**
 * decides what an incoming file version means next to what is stored
 * @param db an open vault
 * @param file the incoming file
 * @returns the non-import outcome, or undefined when the file is new
 */
function existingOutcome(
  db: DatabaseSync,
  file: ImportableFile,
): Exclude<ImportOutcome, { status: 'imported' }> | undefined {
  const known = db
    .prepare('SELECT version, sha256 FROM record_sources WHERE box_file_id = ?')
    .all(file.fileId) as Array<{ version: string; sha256: string }>;

  if (known.some((source) => source.sha256 === file.sha256)) {
    // same digest: the content is already here, whatever the version label
    return { status: 'duplicate' };
  }

  const taken = db.prepare('SELECT 1 FROM records WHERE id = ?');
  const recordIds = file.records
    .filter((record) => taken.get(record.id))
    .map((record) => record.id);

  return recordIds.length > 0 ? { status: 'collision', recordIds } : undefined;
}

/** what one import writes: the patient, the run (none for a submission) and the file */
export interface ImportInput {
  patientId: string;
  /** the sync run, or null for a record a clinician submitted (ADR-10) */
  syncRunId: string | null;
  file: ImportableFile;
}

/**
 * writes one validated file's source row and records; the caller must hold a
 * transaction (`inTransaction`), so the import commits with whatever else
 * belongs to it
 * @param db an open vault inside a transaction
 * @param input the patient, the run and the file
 * @returns what happened
 */
export function insertImport(
  db: DatabaseSync,
  input: ImportInput,
): ImportOutcome {
  const { patientId, syncRunId, file } = input;
  const outcome = existingOutcome(db, file);

  if (outcome) {
    return outcome;
  }

  const importedAt =
    file.records[0]?.source.importedAt ?? new Date().toISOString();
  const source = db
    .prepare(
      `INSERT INTO record_sources (patient_id, sync_run_id, provider, box_file_id, version, sha256, verification, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      patientId,
      syncRunId,
      file.provider,
      file.fileId,
      file.version,
      file.sha256,
      file.verification,
      new Date(importedAt).toISOString(),
    );
  const sourceId = Number(source.lastInsertRowid);
  const insert = db.prepare(
    `INSERT INTO records (id, patient_id, source_id, resource_type, resource, category, sensitivity, status, authored_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const record of file.records) {
    const authoredAt = record.source.authoredAt;

    insert.run(
      record.id,
      patientId,
      sourceId,
      record.resourceType,
      JSON.stringify(record.resource),
      record.category,
      record.sensitivity,
      record.status,
      authoredAt ? new Date(authoredAt).toISOString() : null,
    );
  }

  return { status: 'imported', sourceId, recordCount: file.records.length };
}

/**
 * persists one validated file: its source row and every record, atomically;
 * deduplicates on file id + digest; a record id that is already held is
 * reported as a collision and left untouched, never overwritten (the caller
 * parks the incoming copy in `record_conflicts`)
 * @param db an open vault
 * @param input the patient, the run and the file
 * @returns what happened
 */
export function recordImport(
  db: DatabaseSync,
  input: ImportInput,
): ImportOutcome {
  return inTransaction(db, () => insertImport(db, input));
}

/**
 * checks whether a Box file version with this digest was filed by Medissy itself
 * from a clinician's submission (ADR-10); a sync treats it as already
 * imported, before any catalogue lookup
 * @param db an open vault
 * @param file the Box file id and the digest of its downloaded bytes
 * @param file.fileId the Box file id
 * @param file.sha256 the digest of the downloaded bytes
 * @param provider the provider label submissions are stored under
 * @returns true when the same bytes were imported as a submission
 */
export function isSubmittedSource(
  db: DatabaseSync,
  file: { fileId: string; sha256: string },
  provider: string,
): boolean {
  return (
    db
      .prepare(
        'SELECT 1 FROM record_sources WHERE box_file_id = ? AND sha256 = ? AND provider = ? AND sync_run_id IS NULL',
      )
      .get(file.fileId, file.sha256, provider) !== undefined
  );
}

/**
 * fails the runs a crash left in `running` that started before the cutoff, so an
 * interrupted sync is never shown as in progress forever
 * @param db an open vault
 * @param stale the cutoff and closing instants
 * @param stale.startedBefore runs that started before this instant are stale
 * @param stale.finishedAt the instant recorded as their end
 * @returns the ids of the runs that were failed
 */
export function failStaleRuns(
  db: DatabaseSync,
  stale: { startedBefore: string; finishedAt: string },
): string[] {
  const rows = db
    .prepare(
      `UPDATE sync_runs SET status = 'failed', finished_at = ?, error_summary = 'interrupted:1'
       WHERE status = 'running' AND started_at < ? RETURNING id`,
    )
    .all(stale.finishedAt, stale.startedBefore) as Array<{ id: string }>;

  return rows.map((row) => row.id);
}
