/**
 * what the owner dashboard reads: sources and sync status, the full receipt
 * ledger and the audit log; the owner may inspect everything (brief §8), so
 * these reads are owner-only and never reach a clinician page
 */
import type { DatabaseSync } from 'node:sqlite';

const RECENT_RECEIPTS = 50;
const RECENT_EVENTS = 100;
/** most day-and-skill rows of requests that never signed in shown */
const RECENT_UNSIGNED = 60;

/** one imported source provider */
export interface SourceSummary {
  provider: string;
  files: number;
  records: number;
  lastImportedAt: string;
}

/** the latest sync run */
export interface SyncStatus {
  status: string;
  adapter: string;
  startedAt: string;
  finishedAt?: string;
}

/** one receipt as the owner ledger shows it */
export interface LedgerReceipt {
  id: string;
  issuedAt: string;
  requester: string;
  encounterId: string;
  decision: string;
  rationaleCode: string;
  recordIds: string[];
}

/** requests of one skill on one UTC day that stopped at sign-in */
export interface UnsignedDay {
  day: string;
  skill: string;
  stopped: number;
}

/** requests that never signed in, as the owner ledger shows them */
export interface UnsignedRequests {
  /** ended without a sign-in, newest day first */
  days: UnsignedDay[];
  /** still waiting for a sign-in now */
  waiting: number;
}

/** one audit event as the owner ledger shows it */
export interface LedgerEvent {
  occurredAt: string;
  type: string;
  outcome: string;
  actor: string;
  target?: string;
}

/**
 * reads imported sources grouped by provider
 * @param db the vault
 * @returns one summary per provider
 */
export function readSources(db: DatabaseSync): SourceSummary[] {
  return db
    .prepare(
      `SELECT s.provider AS provider, COUNT(DISTINCT s.box_file_id) AS files, COUNT(r.id) AS records,
              MAX(s.imported_at) AS last
       FROM record_sources s LEFT JOIN records r ON r.source_id = s.id
       GROUP BY s.provider ORDER BY s.provider`,
    )
    .all()
    .map((row) => ({
      provider: String(row.provider),
      files: Number(row.files),
      records: Number(row.records),
      lastImportedAt: String(row.last),
    }));
}

/**
 * reads the most recent sync run
 * @param db the vault
 * @returns its status, or undefined before any sync
 */
export function readLatestSync(db: DatabaseSync): SyncStatus | undefined {
  const row = db
    .prepare(
      'SELECT status, adapter, started_at, finished_at FROM sync_runs ORDER BY started_at DESC LIMIT 1',
    )
    .get();

  return row
    ? {
        status: String(row.status),
        adapter: String(row.adapter),
        startedAt: String(row.started_at),
        ...(row.finished_at ? { finishedAt: String(row.finished_at) } : {}),
      }
    : undefined;
}

/**
 * reads the most recent receipts with the records each released
 * @param db the vault
 * @returns newest first
 */
export function readReceipts(db: DatabaseSync): LedgerReceipt[] {
  return db
    .prepare(
      `SELECT r.id, r.issued_at, r.requester_issuer, r.requester_subject, r.encounter_id, r.decision,
              r.rationale_code, (SELECT json_group_array(record_id) FROM receipt_records WHERE receipt_id = r.id) AS records
       FROM receipts r ORDER BY r.issued_at DESC, r.id LIMIT ?`,
    )
    .all(RECENT_RECEIPTS)
    .map((row) => ({
      id: String(row.id),
      issuedAt: String(row.issued_at),
      requester: `${String(row.requester_subject)} @ ${String(row.requester_issuer)}`,
      encounterId: String(row.encounter_id),
      decision: String(row.decision),
      rationaleCode: String(row.rationale_code),
      recordIds: (JSON.parse(String(row.records)) as unknown[]).map(String),
    }));
}

/**
 * reads the most recent audit events
 * @param db the vault
 * @returns newest first
 */
export function readLedger(db: DatabaseSync): LedgerEvent[] {
  return db
    .prepare(
      `SELECT occurred_at, type, outcome, actor_kind, actor_subject, target_type, target_id
       FROM audit_events ORDER BY seq DESC LIMIT ?`,
    )
    .all(RECENT_EVENTS)
    .map((row) => ({
      occurredAt: String(row.occurred_at),
      type: String(row.type),
      outcome: String(row.outcome),
      actor: row.actor_subject
        ? `${String(row.actor_kind)}: ${String(row.actor_subject)}`
        : String(row.actor_kind),
      ...(row.target_type
        ? { target: `${String(row.target_type)} ${String(row.target_id)}` }
        : {}),
    }));
}

/**
 * reads the requests that stopped at sign-in: the purged day counts plus the
 * expired unbound tasks not purged yet, and how many still wait for a sign-in;
 * only counts, nothing about any caller exists to show
 * @param db the vault
 * @param at the current time
 * @returns day counts, newest first, and the number waiting
 */
export function readUnsignedRequests(
  db: DatabaseSync,
  at: Date,
): UnsignedRequests {
  const now = at.toISOString();
  // a task without a skill in its metadata is a clinical request, as in the purge
  const days = db
    .prepare(
      `SELECT day, skill, SUM(n) AS stopped FROM (
         SELECT day, skill, stopped AS n FROM unsigned_requests
         UNION ALL
         SELECT substr(created_at, 1, 10) AS day,
                COALESCE(json_extract(metadata, '$.skill'), 'clinical-evidence-request') AS skill, 1 AS n
         FROM a2a_tasks WHERE caller_subject IS NULL AND expires_at <= ?)
       GROUP BY day, skill ORDER BY day DESC, skill LIMIT ?`,
    )
    .all(now, RECENT_UNSIGNED)
    .map((row) => ({
      day: String(row.day),
      skill: String(row.skill),
      stopped: Number(row.stopped),
    }));
  const waiting = db
    .prepare(
      'SELECT COUNT(*) AS n FROM a2a_tasks WHERE caller_subject IS NULL AND expires_at > ?',
    )
    .get(now);

  return { days, waiting: Number(waiting?.n ?? 0) };
}
