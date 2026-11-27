/**
 * the disclosure pipeline (brief §7): policy → filter → selector → pairing →
 * guard → receipt transaction → result; it is a pure orchestration over
 * injected dependencies, so the A2A task engine can call `disclose` once per
 * task and `redisclose` on every poll
 *
 * decision D10: releases are decided for the clinician bound to the task by
 * the institution device sign-in (ADR-9), never for an identity named in message text
 * every path re-authorises: a duplicate request id or a poll replays the
 * stored receipt's records only after a fresh re-check, and never writes a
 * second release receipt
 *
 * fail closed: any error, guard violation or audit failure releases nothing
 * and returns a fixed denial; logs carry stage, codes, counts and latency
 * only; never record ids, question text, field values or error messages
 */
import { clinicalRequestSchema } from '../contracts';

import { draftRelease, draftReplay } from './draft';
import { findReceipt, readLastSyncAt } from './ledger';
import { commitRelease } from './receipt';
import { renderDenial, renderResult } from './result';
import {
  deny,
  discloseInputSchema,
  fail,
  rediscloseInputSchema,
  rejectInput,
  requestDigestOf,
  requestIdOf,
  start,
  unavailable,
} from './run';

import type {
  ClinicalRequest,
  DisclosureResult,
  PersonRef,
  Principal,
} from '../contracts';
import type { PolicyAllow } from '../policy/decide';

import type { StoredReceipt } from './ledger';
import type { ConflictMarker } from './pairing';
import type { SelectionPath } from './receipt';
import type { DeniedOutcome, DisclosureDeps, ReleaseDraft, Run } from './run';

export type {
  DeniedOutcome,
  DisclosureDeps,
  DisclosureLogEntry,
  DisclosureLogger,
} from './run';

/** a first request on a task */
export interface DiscloseInput {
  /** the principal verified by the device sign-in that bound the task */
  principal: Principal;
  /** the vault patient the task addresses */
  patientId: string;
  /** the parsed request; its question is untrusted data */
  request: ClinicalRequest;
}

/** a poll or retry of a request that already has a receipt */
export interface RediscloseInput {
  /** the verified person bound to the task */
  caller: PersonRef;
  patientId: string;
  requestId: string;
}

/** a release, with what the strict result contract cannot carry */
export interface ReleasedOutcome {
  kind: 'released';
  result: DisclosureResult;
  policyVersion: string;
  selection: SelectionPath;
  conflicts: ConflictMarker[];
  /** true when an existing receipt was re-served */
  replay: boolean;
}

export type PipelineOutcome = ReleasedOutcome | DeniedOutcome;

/**
 * re-authorises a new request and looks for a receipt the request id already has
 * @param run the per-call state, with the request digest set
 * @param call the input and its parsed request
 * @param call.input the bound principal, the patient and the request
 * @param call.request the parsed clinical request
 * @returns the fresh allow decision and any stored receipt, or a denial
 */
function authorise(
  run: Run,
  call: { input: DiscloseInput; request: ClinicalRequest },
):
  DeniedOutcome | { decision: PolicyAllow; stored: StoredReceipt | undefined } {
  const { input, request } = call;
  const decision = run.engine.evaluate({ principal: input.principal, request });
  const attempt = {
    encounterId: request.encounterId,
    writeReceipt: true,
    stage: 'policy' as const,
    outcome: 'denied' as const,
  };

  if (decision.effect === 'deny') {
    return deny(run, {
      ...attempt,
      code: 'not-permitted',
      rationaleCode: decision.rationaleCode,
    });
  }

  if (decision.patientId !== input.patientId) {
    return deny(run, {
      ...attempt,
      code: 'not-permitted',
      rationaleCode: 'encounter-mismatch',
    });
  }

  const stored = findReceipt(run.deps.db, {
    caller: run.caller,
    requestId: run.requestId,
  });

  if (stored && stored.requestDigest !== run.requestDigest) {
    // the id was used for a different request: never replay another release
    return deny(run, {
      ...attempt,
      writeReceipt: false,
      code: 'invalid-request',
      rationaleCode: 'duplicate-request',
      stage: 'request',
      receiptOf: stored.id,
    });
  }

  return { decision, stored };
}

/**
 * runs the pipeline for a new request from the bound clinician
 * @param deps the vault, clock, selector client and logger
 * @param input the bound principal, the patient and the request
 * @returns a grounded release or a safe denial; never throws
 */
export async function disclose(
  deps: DisclosureDeps,
  input: DiscloseInput,
): Promise<PipelineOutcome> {
  const unknown: unknown = input;
  const requestId = requestIdOf(
    typeof unknown === 'object' && unknown !== null && 'request' in unknown
      ? (unknown.request as { requestId?: unknown } | null)?.requestId
      : undefined,
  );
  let run: Run | undefined;

  try {
    if (!discloseInputSchema.safeParse(input).success) {
      return rejectInput(deps, requestId);
    }

    const { principal } = input;
    const caller = { issuer: principal.issuer, subject: principal.subject };

    run = start(deps, caller, requestId);

    const parsed = clinicalRequestSchema.safeParse(input.request);

    if (!parsed.success) {
      return deny(run, {
        code: 'invalid-request',
        rationaleCode: 'invalid-request',
        stage: 'request',
        outcome: 'denied',
      });
    }

    const request = parsed.data;

    run.requestDigest = requestDigestOf(request);

    const checked = authorise(run, { input, request });

    if ('kind' in checked) {
      return checked;
    }

    const { decision, stored } = checked;

    return stored
      ? replay(run, stored, decision.patientId)
      : await release(run, decision, request.question);
  } catch (error) {
    return failSafely(run, requestId, error);
  }
}

/**
 * re-serves a stored release after re-checking it for the bound person, as
 * every poll and duplicate request must. Nothing new is selected and no
 * receipt is written; the replay is audited before it is returned
 * @param deps the vault, clock, selector client and logger
 * @param input the bound person, the patient and the request id
 * @returns the re-checked release or a safe denial; never throws
 */
export function redisclose(
  deps: DisclosureDeps,
  input: RediscloseInput,
): PipelineOutcome {
  const unknown: unknown = input;
  const requestId = requestIdOf(
    typeof unknown === 'object' && unknown !== null && 'requestId' in unknown
      ? unknown.requestId
      : undefined,
  );
  let run: Run | undefined;

  try {
    if (!rediscloseInputSchema.safeParse(input).success) {
      return rejectInput(deps, requestId);
    }

    run = start(deps, input.caller, requestId);

    const stored = findReceipt(deps.db, {
      caller: input.caller,
      requestId: input.requestId,
    });

    return stored
      ? replay(run, stored, input.patientId)
      : deny(run, {
          code: 'not-permitted',
          rationaleCode: 'duplicate-request',
          stage: 'replay',
          outcome: 'denied',
        });
  } catch (error) {
    return failSafely(run, requestId, error);
  }
}

/**
 * drafts a new release and commits it
 * @param run the per-call state
 * @param decision the fresh allow decision
 * @param question the clinician's untrusted question
 * @returns the outcome
 */
async function release(
  run: Run,
  decision: PolicyAllow,
  question: string,
): Promise<PipelineOutcome> {
  const drafted = await draftRelease(run, decision, question);

  return 'kind' in drafted ? drafted : commit(run, drafted);
}

/**
 * re-checks a stored release and commits its replay
 * @param run the per-call state
 * @param stored the requester's receipt for this request id
 * @param patientId the vault patient the task addresses
 * @returns the stored records re-served, or a denial when any is no longer releasable
 */
function replay(
  run: Run,
  stored: StoredReceipt,
  patientId: string,
): PipelineOutcome {
  const drafted = draftReplay(run, stored, patientId);

  return 'kind' in drafted ? drafted : commit(run, drafted);
}

/**
 * renders, then commits through the receipt transaction, then returns; the
 * result is rendered and validated before anything is written, so a render
 * failure never leaves a receipt for data that was not released
 * @param run the per-call state
 * @param draft the guarded release
 * @returns the outcome
 */
function commit(run: Run, draft: ReleaseDraft): PipelineOutcome {
  const { deps, engine } = run;

  render(run, draft, {
    decision: draft.prior,
    issuedAt: engine.now().toISOString(),
  });

  const outcome = commitRelease(engine, deps.db, {
    prior: draft.prior,
    caller: run.caller,
    requestId: run.requestId,
    records: draft.projections.map((projection) => ({
      recordId: projection.recordId,
      sourceVersion: projection.source.version,
    })),
    selection: draft.selection,
    receipt: draft.receipt,
    auditId: run.newId(),
    requestDigest: run.requestDigest,
  });

  if (outcome.kind === 'duplicate') {
    const stored = findReceipt(deps.db, run);

    return stored
      ? replay(run, stored, draft.prior.patientId)
      : fail(run, new Error('receipt vanished'));
  }

  if (outcome.kind === 'denied') {
    deps.logger.info({
      event: 'disclosure.denied',
      request: run.digest,
      stage: 'receipt',
      rationaleCode: outcome.rationaleCode,
    });

    return {
      kind: 'denied',
      denial: renderDenial(run.requestId, 'not-permitted'),
    };
  }

  const replayed = draft.receipt.mode === 'replay';

  deps.logger.info({
    event: 'disclosure.released',
    request: run.digest,
    selection: draft.selection,
    releasedCount: draft.projections.length,
    replay: replayed,
  });

  return {
    kind: 'released',
    result: render(run, draft, outcome),
    policyVersion: outcome.decision.policyVersion,
    selection: draft.selection,
    conflicts: draft.markers,
    replay: replayed,
  };
}

/**
 * renders the grounded result for a guarded release
 * @param run the per-call state
 * @param draft the guarded release
 * @param at the decision the release is (or will be) committed under, and when
 * @param at.decision the allow decision to state as the result's scope
 * @param at.issuedAt the commit time
 * @returns a result validated against its contract
 */
function render(
  run: Run,
  draft: ReleaseDraft,
  at: { decision: PolicyAllow; issuedAt: string },
): DisclosureResult {
  const { decision, issuedAt } = at;

  return renderResult({
    requestId: run.requestId,
    receiptId: draft.receipt.id,
    decision,
    projections: draft.projections,
    markers: draft.markers,
    selection: draft.selection,
    lastSyncAt: readLastSyncAt(run.deps.db, draft.prior.patientId),
    issuedAt,
  });
}

/**
 * turns a thrown error into an audited denial, or into a fixed denial when no
 * caller was bound yet or recording the failure throws too
 * @param run the per-call state, once started
 * @param requestId the caller's request id, or `UNKNOWN_REQUEST_ID`
 * @param error what was thrown
 * @returns a `temporarily-unavailable` denial; never throws
 */
function failSafely(
  run: Run | undefined,
  requestId: string,
  error: unknown,
): DeniedOutcome {
  try {
    return run ? fail(run, error) : unavailable(requestId);
  } catch {
    return unavailable(requestId);
  }
}
