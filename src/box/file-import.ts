import { SUBMISSION_PROVIDER } from '../contracts';
import { isSubmittedSource, recordImport } from '../vault/sources';

import {
  loadFileEnvelopes,
  recordConflicts,
  recordUnclassifiedSource,
} from './conflicts';
import { checkEntry, isFileId, sha256Hex } from './ingest';
import { incomingCopies, parseSourceFile } from './parse';

import { SourceAdapterError } from './types';

import type { AuditEvent } from '../contracts';
import type { SyncRunRow } from '../vault/sources';

import type { IngestLimits } from './ingest';
import type { ParsedFile, UncuratedFile } from './parse';
import type { SyncDeps } from './sync';
import type { RejectionReason, SourceFileEntry } from './types';

export interface AuditInput {
  type: AuditEvent['type'];
  outcome: AuditEvent['outcome'];
  details: AuditEvent['details'];
  target?: { type: string; id: string };
}

export interface RunContext {
  deps: SyncDeps;
  run: SyncRunRow;
  limits: IngestLimits;
  now: () => Date;
  audit: (input: AuditInput) => void;
}

export type FileResult =
  | { kind: 'imported' }
  | { kind: 'duplicate' }
  | { kind: 'rejected'; reason: RejectionReason };

export interface FileReport {
  result: FileResult;
  version: string;
  sha256?: string;
}

type Fetched =
  | { ok: true; entry: SourceFileEntry; bytes: Uint8Array }
  | { ok: false; reason: RejectionReason; version: string };

/**
 * builds a rejected-file report
 * @param reason why the file was not imported
 * @param version the source version label
 * @param sha256 the body digest when a body was read
 * @returns the report
 */
function reject(
  reason: RejectionReason,
  version: string,
  sha256?: string,
): FileReport {
  return { result: { kind: 'rejected', reason }, version, sha256 };
}

/**
 * checks a listed file's metadata, then downloads it within the size cap
 * @param ctx the run context
 * @param entry the untrusted listing entry
 * @returns the verified entry and bytes, or the rejection
 */
async function fetchFile(
  ctx: RunContext,
  entry: SourceFileEntry,
): Promise<Fetched> {
  if (!isFileId(entry.id)) {
    return { ok: false, reason: 'invalid-file-id', version: entry.version };
  }

  const { adapter } = ctx.deps;
  let checked = entry;

  try {
    const metadata = await adapter.metadata(entry.id);

    checked = metadata;

    const problem = checkEntry(metadata, {
      parentId: metadata.parentId,
      folderId: adapter.folderId,
      limits: ctx.limits,
    });

    if (problem) {
      return { ok: false, reason: problem, version: metadata.version };
    }

    const bytes = await adapter.download(
      entry.id,
      ctx.limits.maxFileBytes,
      metadata.versionId,
    );

    return { ok: true, entry: checked, bytes };
  } catch (error) {
    const oversized =
      error instanceof SourceAdapterError && error.code === 'too-large';

    return {
      ok: false,
      reason: oversized ? 'oversized' : 'fetch-failed',
      version: checked.version,
    };
  }
}

/**
 * persists a curated file; a record id that is already held parks the incoming
 * copy as an open conflict instead of replacing anything
 * @param ctx the run context
 * @param file the curated file with provenance stamped
 * @returns the report
 */
function storeCurated(ctx: RunContext, file: ParsedFile): FileReport {
  const { db, patientId } = ctx.deps;
  const outcome = recordImport(db, { patientId, syncRunId: ctx.run.id, file });
  const base = { version: file.version, sha256: file.sha256 };

  if (outcome.status !== 'collision') {
    return { result: { kind: outcome.status }, ...base };
  }

  recordConflicts(db, {
    incoming: file.records.filter((r) => outcome.recordIds.includes(r.id)),
    detectedAt: ctx.now().toISOString(),
  });

  return reject('version-conflict', file.version, file.sha256);
}

/**
 * handles a valid file the catalogue does not vouch for; if the file was
 * imported before, the changed content is parked as open conflicts; otherwise
 * only a source row is kept and nothing is labelled or releasable
 * @param ctx the run context
 * @param file the valid file whose digest is not listed
 * @returns the report
 */
function storeUncurated(ctx: RunContext, file: UncuratedFile): FileReport {
  const { db, patientId } = ctx.deps;
  const existing = loadFileEnvelopes(db, file.fileId);
  const seenAt = ctx.now().toISOString();

  if (existing.length === 0) {
    recordUnclassifiedSource(db, {
      patientId,
      syncRunId: ctx.run.id,
      file,
      seenAt,
    });

    return reject('unclassified-content', file.version, file.sha256);
  }

  const incoming = incomingCopies(existing, file, seenAt);

  if (typeof incoming === 'string') {
    return reject(incoming, file.version, file.sha256);
  }

  recordConflicts(db, { incoming, detectedAt: seenAt });

  return reject('version-conflict', file.version, file.sha256);
}

/**
 * imports one listed file: metadata check, bounded download, validation, store
 * @param ctx the run context
 * @param entry the untrusted listing entry
 * @returns the file's report
 */
export async function importOne(
  ctx: RunContext,
  entry: SourceFileEntry,
): Promise<FileReport> {
  const fetched = await fetchFile(ctx, entry);

  if (!fetched.ok) {
    return reject(fetched.reason, fetched.version);
  }

  const sha256 = sha256Hex(fetched.bytes);

  // a record a clinician submitted is filed and imported by Medissy itself
  // (ADR-10); the same bytes coming back through the folder are a duplicate,
  // never re-classified, rejected or imported twice
  if (
    isSubmittedSource(
      ctx.deps.db,
      { fileId: fetched.entry.id, sha256 },
      SUBMISSION_PROVIDER,
    )
  ) {
    return {
      result: { kind: 'duplicate' },
      version: fetched.entry.version,
      sha256,
    };
  }

  const parsed = parseSourceFile(
    { entry: fetched.entry, bytes: fetched.bytes },
    {
      curation: ctx.deps.curation,
      limits: ctx.limits,
      importedAt: ctx.now().toISOString(),
    },
  );

  if (!parsed.ok) {
    return reject(parsed.reason, fetched.entry.version, sha256);
  }

  return parsed.kind === 'curated'
    ? storeCurated(ctx, parsed.file)
    : storeUncurated(ctx, parsed.file);
}
