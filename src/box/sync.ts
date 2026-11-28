import { randomUUID } from 'node:crypto';

import {
  appendAuditEvent,
  failStaleRuns,
  finishSyncRun,
  startSyncRun,
} from '../vault/sources';

import { importOne } from './file-import';
import { DEFAULT_LIMITS, isFileId } from './ingest';

import type { DatabaseSync } from 'node:sqlite';

import type { AuditEvent } from '../contracts';
import type { SyncRunRow } from '../vault/sources';

import type { Curation } from './curation';
import type { FileReport, RunContext } from './file-import';
import type { IngestLimits } from './ingest';
import type {
  RejectionReason,
  SourceAdapter,
  SourceFileEntry,
  SourceListing,
} from './types';

const SHA_PREFIX = 12;
const MAX_SUMMARY_CHARS = 500;
const MAX_VERSION_CHARS = 64;
const STALE_RUN_MS = 600_000;

/** run-level audit reason when every file in a run was rejected */
export const ALL_REJECTED_REASON = 'all-files-rejected';

export interface SyncDeps {
  db: DatabaseSync;
  adapter: SourceAdapter;
  curation: Curation;
  /** the vault patient; imports accept this patient and nobody else */
  patientId: string;
  limits?: IngestLimits;
  now?: () => Date;
  newId?: () => string;
}

export interface SyncRequest {
  /** who started it; authorising the owner is the caller's job */
  trigger: SyncRunRow['trigger'];
  /** a repeated key returns the earlier run instead of starting another */
  idempotencyKey?: string;
  actor?: AuditEvent['actor'];
}

export interface SyncSummary {
  runId: string;
  replayed: boolean;
  adapter: SyncRunRow['adapter'];
  status: SyncRunRow['status'];
  filesSeen: number;
  imported: number;
  duplicate: number;
  rejected: number;
  rejections: Array<{
    fileId: string | null;
    reason: RejectionReason | 'listing-failed';
  }>;
}

interface FileOutcome {
  entry: SourceFileEntry;
  report: FileReport;
}

interface Tally {
  imported: number;
  duplicate: number;
  rejected: Array<{ fileId: string | null; reason: RejectionReason }>;
}

/**
 * describes a run for the caller
 * @param run the stored run
 * @param replayed whether it was an idempotent replay
 * @param rejections the in-memory rejection list (empty on a replay)
 * @returns the summary
 */
function summarise(
  run: SyncRunRow,
  replayed: boolean,
  rejections: SyncSummary['rejections'],
): SyncSummary {
  return {
    runId: run.id,
    replayed,
    adapter: run.adapter,
    status: run.status,
    filesSeen: run.filesSeen,
    imported: run.filesImported,
    duplicate: run.filesDuplicate,
    rejected: run.filesRejected,
    rejections,
  };
}

/**
 * builds a content-free summary of reason codes for `sync_runs.error_summary`
 * @param reasons reason codes, one per failed file
 * @returns `reason:count` pairs, or null when nothing failed
 */
function errorSummary(reasons: readonly string[]): string | null {
  const counts = new Map<string, number>();

  for (const reason of reasons) {
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }

  const text = [...counts].map(([reason, n]) => `${reason}:${n}`).join(',');

  return text === '' ? null : text.slice(0, MAX_SUMMARY_CHARS);
}

/**
 * decides a finished run's status from its tallies
 * @param tally the per-file outcomes
 * @returns the run status
 */
function statusOf(tally: Tally): 'succeeded' | 'partial' | 'failed' {
  if (tally.rejected.length === 0) {
    return 'succeeded';
  }

  return tally.imported + tally.duplicate === 0 ? 'failed' : 'partial';
}

/**
 * counts a file's outcome and audits a rejection with ids and reason codes only
 * @param ctx the run context
 * @param tally the running tally
 * @param file the listing entry and the report for it
 */
function tallyFile(ctx: RunContext, tally: Tally, file: FileOutcome): void {
  const { entry, report } = file;
  const { result } = report;

  if (result.kind === 'imported') {
    tally.imported += 1;

    return;
  }

  if (result.kind === 'duplicate') {
    tally.duplicate += 1;

    return;
  }

  const known = isFileId(entry.id);

  tally.rejected.push({
    fileId: known ? entry.id : null,
    reason: result.reason,
  });
  ctx.audit({
    type: 'sync.failed',
    outcome: 'denied',
    details: {
      reason: result.reason,
      version: report.version.slice(0, MAX_VERSION_CHARS),
      ...(report.sha256
        ? { sha256Prefix: report.sha256.slice(0, SHA_PREFIX) }
        : {}),
      adapter: ctx.deps.adapter.kind,
    },
    target: { type: 'box-file', id: known ? entry.id : 'invalid-id' },
  });
}

/**
 * closes a run with its counts and a run-level audit event
 * @param ctx the run context
 * @param tally the per-file outcomes
 * @param seen the number of files examined
 * @returns the finished run row
 */
function closeRun(ctx: RunContext, tally: Tally, seen: number): SyncRunRow {
  const status = statusOf(tally);
  const finished: SyncRunRow = {
    ...ctx.run,
    status,
    filesSeen: seen,
    filesImported: tally.imported,
    filesDuplicate: tally.duplicate,
    filesRejected: tally.rejected.length,
  };

  finishSyncRun(ctx.deps.db, ctx.run.id, {
    status,
    finishedAt: ctx.now().toISOString(),
    filesSeen: seen,
    filesImported: tally.imported,
    filesDuplicate: tally.duplicate,
    filesRejected: tally.rejected.length,
    errorSummary: errorSummary(tally.rejected.map((r) => r.reason)),
  });

  const failed = status === 'failed';

  ctx.audit({
    type: failed ? 'sync.failed' : 'sync.completed',
    outcome: failed ? 'error' : 'success',
    details: {
      ...(failed ? { reason: ALL_REJECTED_REASON } : {}),
      status,
      seen,
      imported: tally.imported,
      duplicate: tally.duplicate,
      rejected: tally.rejected.length,
      adapter: ctx.deps.adapter.kind,
    },
  });

  return finished;
}

/**
 * lists the folder; when listing fails, closes the run as failed and says why
 * @param ctx the run context
 * @returns the entries, or undefined once the run has been failed
 */
async function listOrFail(ctx: RunContext): Promise<SourceListing | undefined> {
  try {
    return await ctx.deps.adapter.list();
  } catch {
    finishSyncRun(ctx.deps.db, ctx.run.id, {
      status: 'failed',
      finishedAt: ctx.now().toISOString(),
      filesSeen: 0,
      filesImported: 0,
      filesDuplicate: 0,
      filesRejected: 0,
      errorSummary: 'listing-failed:1',
    });
    ctx.audit({
      type: 'sync.failed',
      outcome: 'error',
      details: { reason: 'listing-failed', adapter: ctx.deps.adapter.kind },
    });

    return undefined;
  }
}

/**
 * fails runs that a crash left `running` long ago, one audit event each
 * @param ctx the run context of the sync that is starting
 */
function recoverStaleRuns(ctx: RunContext): void {
  const now = ctx.now();
  const ids = failStaleRuns(ctx.deps.db, {
    startedBefore: new Date(now.getTime() - STALE_RUN_MS).toISOString(),
    finishedAt: now.toISOString(),
  });

  for (const id of ids) {
    ctx.audit({
      type: 'sync.failed',
      outcome: 'error',
      details: { reason: 'interrupted', adapter: ctx.deps.adapter.kind },
      target: { type: 'sync-run', id },
    });
  }
}

/**
 * reports files the run could not even look at because the listing was cut
 * @param ctx the run context
 * @param tally the running tally
 */
function reportTruncation(ctx: RunContext, tally: Tally): void {
  tally.rejected.push({ fileId: null, reason: 'listing-truncated' });
  ctx.audit({
    type: 'sync.failed',
    outcome: 'denied',
    details: { reason: 'listing-truncated', adapter: ctx.deps.adapter.kind },
  });
}

/**
 * builds the run context, including the audit writer bound to this run
 * @param deps the sync dependencies
 * @param run the opened run
 * @param actor who triggered it
 * @returns the run context with an audit writer bound to the run
 */
function contextFor(
  deps: SyncDeps,
  run: SyncRunRow,
  actor: AuditEvent['actor'],
): RunContext {
  const now = deps.now ?? ((): Date => new Date());
  const newId = deps.newId ?? randomUUID;

  return {
    deps,
    run,
    now,
    limits: deps.limits ?? DEFAULT_LIMITS,
    audit: ({ type, outcome, details, target }) => {
      appendAuditEvent(deps.db, {
        id: newId(),
        occurredAt: now().toISOString(),
        type,
        outcome,
        actor,
        patientId: deps.patientId,
        requestId: run.id,
        ...(target ? { target } : {}),
        details,
      });
    },
  };
}

/**
 * syncs the allowed folder into the vault; thin orchestration: list, import
 * each file independently so one bad file never blocks the rest, record the
 * run, and audit every failure with ids, counts and reason codes only
 * @param deps the database, adapter, catalogue and clocks
 * @param request who triggered the sync, and an optional idempotency key
 * @returns the run summary
 */
export async function runSync(
  deps: SyncDeps,
  request: SyncRequest,
): Promise<SyncSummary> {
  const now = deps.now ?? ((): Date => new Date());
  const { run, replayed } = startSyncRun(deps.db, {
    id: (deps.newId ?? randomUUID)(),
    patientId: deps.patientId,
    ...(request.idempotencyKey
      ? { idempotencyKey: request.idempotencyKey }
      : {}),
    trigger: request.trigger,
    adapter: deps.adapter.kind,
    folderId: deps.adapter.folderId,
    startedAt: now().toISOString(),
  });

  if (replayed) {
    return summarise(run, true, []);
  }

  const ctx = contextFor(deps, run, request.actor ?? { kind: 'system' });
  recoverStaleRuns(ctx);

  const listing = await listOrFail(ctx);

  if (!listing) {
    return summarise({ ...run, status: 'failed' }, false, [
      { fileId: null, reason: 'listing-failed' },
    ]);
  }

  const batch = listing.entries.slice(0, ctx.limits.maxFiles);
  const tally: Tally = { imported: 0, duplicate: 0, rejected: [] };

  for (const entry of batch) {
    tallyFile(ctx, tally, { entry, report: await importOne(ctx, entry) });
  }

  if (listing.truncated || listing.entries.length > batch.length) {
    reportTruncation(ctx, tally);
  }

  return summarise(closeRun(ctx, tally, batch.length), false, tally.rejected);
}
