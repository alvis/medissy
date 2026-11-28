/**
 * per-call plumbing for the disclosure pipeline: the injected dependencies,
 * the content-free log shape, and the shared deny and fail paths; logs carry
 * stage, codes, counts and latency only; never record ids, question text,
 * field values or error messages
 */
import { createHash, randomUUID } from 'node:crypto';

import { z } from 'zod';

import { idSchema, issuerSchema, subjectSchema } from '../contracts';

import { POLICY_VERSION } from '../policy/decide';
import { PolicyEngine } from '../policy/engine';
import { readPatientId } from '../policy/repository';
import { toModelInput } from '../vault/filter';

import { recordDenial } from './receipt';
import { renderDenial } from './result';
import { selectRelevantRecords } from './selector';

import type { DatabaseSync } from 'node:sqlite';

import type {
  ClinicalRequest,
  DisclosureDenial,
  PersonRef,
  RationaleCode,
} from '../contracts';
import type { PolicyAllow } from '../policy/decide';
import type { Clock } from '../policy/engine';
import type { RecordProjection } from '../vault/filter';

import type { ConflictLink, ConflictMarker } from './pairing';
import type { DisclosureStage, ReleasePlan, SelectionPath } from './receipt';
import type { DenialCode } from './result';
import type {
  FallbackReason,
  SelectionResult,
  SelectorClient,
} from './selector';

/** hex characters of the request-id digest written to logs */
const DIGEST_LENGTH = 12;

/** the request id echoed in a denial when the caller's request id is not a valid id */
export const UNKNOWN_REQUEST_ID = 'unknown-request';

/** the verified person a call is made for; extra principal fields pass */
const boundPersonSchema = z.looseObject({
  issuer: issuerSchema,
  subject: subjectSchema,
});

/** what `disclose` needs before anything runs; the request is parsed later */
export const discloseInputSchema = z.looseObject({
  principal: boundPersonSchema,
  patientId: idSchema,
  request: z.unknown(),
});

/** what `redisclose` needs before anything runs */
export const rediscloseInputSchema = z.looseObject({
  caller: boundPersonSchema,
  patientId: idSchema,
  requestId: idSchema,
});

/** one content-free log entry */
export interface DisclosureLogEntry {
  event:
    | 'disclosure.released'
    | 'disclosure.denied'
    | 'disclosure.failed'
    | 'disclosure.selector'
    | 'policy.invalid-grant';
  /** a short digest of the request id, never the id itself */
  request?: string;
  stage?: DisclosureStage;
  rationaleCode?: RationaleCode;
  selection?: SelectionPath;
  fallbackReason?: FallbackReason;
  releasedCount?: number;
  allowedCount?: number;
  latencyMs?: number;
  /** the error class name only; messages may quote stored data */
  error?: string;
  grantId?: string;
  grantVersion?: number;
  replay?: boolean;
}

/** the logger the pipeline writes to; a pino logger satisfies it */
export interface DisclosureLogger {
  info(entry: DisclosureLogEntry): void;
  error(entry: DisclosureLogEntry): void;
}

/** what the pipeline is bound to */
export interface DisclosureDeps {
  /** an open vault from `openVault` */
  db: DatabaseSync;
  /** the server clock */
  clock: Clock;
  /** the relevance model; undefined when no key is configured */
  selectorClient: SelectorClient | undefined;
  logger: DisclosureLogger;
  /** curated conflict links (see `parseConflictLinks`) */
  conflictLinks?: readonly ConflictLink[];
  /** the minter of receipt and audit ids; defaults to random UUIDs */
  newId?: () => string;
}

/** a safe denial; nothing was released */
export interface DeniedOutcome {
  kind: 'denied';
  denial: DisclosureDenial;
}

/** per-call state shared by the steps */
export interface Run {
  deps: DisclosureDeps;
  engine: PolicyEngine;
  caller: PersonRef;
  requestId: string;
  digest: string;
  newId: () => string;
  /** the request digest, set once the request parses; binds new receipts to the request */
  requestDigest?: string;
}

/** what a release step hands to the receipt transaction and renderer */
export interface ReleaseDraft {
  prior: PolicyAllow;
  projections: RecordProjection[];
  markers: ConflictMarker[];
  selection: SelectionPath;
  receipt: ReleasePlan['receipt'];
}

/** what a denial records */
export interface DenyParams {
  code: DenialCode;
  /** absent for an internal failure, which has no authorization rationale */
  rationaleCode?: RationaleCode;
  /** absent when the failing stage is unknown */
  stage?: DisclosureStage;
  outcome: 'denied' | 'error';
  /** as attempted, once the request passed validation */
  encounterId?: string;
  /** whether to also write a denial receipt when the request id is unused */
  writeReceipt?: boolean;
  /** the caller's existing receipt this attempt re-used */
  receiptOf?: string;
}

/**
 * builds the per-call state
 * @param deps the injected dependencies
 * @param caller the person bound to the task
 * @param requestId the caller's correlation id
 * @returns the dependencies, a policy engine, the log digest and an id minter
 */
export function start(
  deps: DisclosureDeps,
  caller: PersonRef,
  requestId: string,
): Run {
  return {
    deps,
    caller,
    requestId,
    digest: createHash('sha256')
      .update(requestId)
      .digest('hex')
      .slice(0, DIGEST_LENGTH),
    newId: deps.newId ?? randomUUID,
    engine: new PolicyEngine({
      db: deps.db,
      clock: deps.clock,
      onInvalidGrant: (signal) => {
        deps.logger.error({
          event: 'policy.invalid-grant',
          grantId: signal.grantId,
          grantVersion: signal.version,
        });
      },
    }),
  };
}

/**
 * records a denial (audit, and a denial receipt when asked) and returns the
 * fixed denial; a failure to record is logged; nothing is released anyway
 * @param run the per-call state
 * @param params the code, rationale and stage
 * @returns a denial carrying no ids or counts
 */
export function deny(run: Run, params: DenyParams): DeniedOutcome {
  const { deps, engine } = run;

  deps.logger.info({
    event: 'disclosure.denied',
    request: run.digest,
    stage: params.stage,
    rationaleCode: params.rationaleCode,
  });

  try {
    recordDenial(deps.db, engine.now(), {
      auditId: run.newId(),
      receiptId:
        params.writeReceipt && params.rationaleCode ? run.newId() : undefined,
      caller: run.caller,
      patientId: readPatientId(deps.db),
      requestId: run.requestId,
      encounterId: params.encounterId,
      purpose: 'direct-treatment',
      policyVersion: POLICY_VERSION,
      rationaleCode: params.rationaleCode,
      stage: params.stage,
      outcome: params.outcome,
      requestDigest: run.requestDigest,
      receiptOf: params.receiptOf,
    });
  } catch (error) {
    deps.logger.error({
      event: 'disclosure.failed',
      request: run.digest,
      stage: 'receipt',
      error: errorName(error),
    });
  }

  return { kind: 'denied', denial: renderDenial(run.requestId, params.code) };
}

/**
 * turns any thrown error into a logged, audited, content-free denial
 * @param run the per-call state
 * @param error what was thrown
 * @returns a `temporarily-unavailable` denial
 */
export function fail(run: Run, error: unknown): DeniedOutcome {
  run.deps.logger.error({
    event: 'disclosure.failed',
    request: run.digest,
    error: errorName(error),
  });

  return deny(run, { code: 'temporarily-unavailable', outcome: 'error' });
}

/**
 * refuses input that never reached a verified caller: logged, not audited,
 * since there is no trusted actor to attribute it to
 * @param deps the injected dependencies
 * @param requestId the caller's request id, or `UNKNOWN_REQUEST_ID`
 * @returns an `invalid-request` denial
 */
export function rejectInput(
  deps: DisclosureDeps,
  requestId: string,
): DeniedOutcome {
  deps.logger.info({
    event: 'disclosure.denied',
    stage: 'request',
    rationaleCode: 'invalid-request',
  });

  return {
    kind: 'denied',
    denial: renderDenial(requestId, 'invalid-request'),
  };
}

/**
 * builds the last resort when even recording a failure throws: a fixed denial with
 * no logging, audit or vault access
 * @param requestId the caller's request id, or `UNKNOWN_REQUEST_ID`
 * @returns a `temporarily-unavailable` denial
 */
export function unavailable(requestId: string): DeniedOutcome {
  return {
    kind: 'denied',
    denial: renderDenial(requestId, 'temporarily-unavailable'),
  };
}

/**
 * returns a request id safe to echo and audit
 * @param value whatever the caller sent as its request id
 * @returns the id when it is a valid id, else `UNKNOWN_REQUEST_ID`
 */
export function requestIdOf(value: unknown): string {
  const parsed = idSchema.safeParse(value);

  return parsed.success ? parsed.data : UNKNOWN_REQUEST_ID;
}

/**
 * computes the digest a receipt is bound to: the encounter selector and the question;
 * a reused request id must carry the same digest to replay its receipt
 * @param request a parsed request
 * @returns lower-case hex SHA-256 of the canonical request
 */
export function requestDigestOf(request: ClinicalRequest): string {
  const canonical = JSON.stringify([
    request.encounterId,
    request.purpose,
    request.requestedCategories
      ? [...request.requestedCategories].sort()
      : null,
    request.question,
  ]);

  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * reads the class name of a thrown value; never its message
 * @param error what was thrown
 * @returns the `name` of an Error, else the `typeof` of the value
 */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * asks the relevance model which allowed records answer the question, falling
 * back to the baseline on any failure
 * @param run the per-call state
 * @param projections the filtered, allowed records
 * @param question the clinician's untrusted question
 * @returns ids drawn from the allowed set and the path that chose them
 */
export async function selectFor(
  run: Run,
  projections: readonly RecordProjection[],
  question: string,
): Promise<SelectionResult> {
  const { deps } = run;

  return selectRelevantRecords({
    question,
    evidence: toModelInput(projections),
    allowedIds: projections.map((projection) => projection.recordId),
    baseline: projections
      .filter((projection) => projection.category === 'baseline')
      .map((projection) => projection.recordId),
    client: deps.selectorClient,
    clock: deps.clock,
    log: (entry) => {
      deps.logger.info({
        event: 'disclosure.selector',
        request: run.digest,
        selection: entry.path,
        fallbackReason: entry.fallbackReason,
        allowedCount: entry.allowedCount,
        releasedCount: entry.selectedCount,
        latencyMs: entry.latencyMs,
      });
    },
  });
}
