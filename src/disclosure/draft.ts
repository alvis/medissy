/**
 * the drafting steps of the disclosure pipeline: they re-check, select, pair
 * and guard the records of a release, and stop before the receipt
 * transaction; `pipeline.ts` commits what they return
 */
import { filterVault } from '../vault/filter';

import { guardRelease } from './guard';
import { priorFromReceipt } from './ledger';
import { markConflicts, pairConflicts } from './pairing';
import { deny, selectFor } from './run';

import type { RationaleCode } from '../contracts';
import type { PolicyAllow } from '../policy/decide';

import type { StoredReceipt } from './ledger';
import type { DeniedOutcome, ReleaseDraft, Run } from './run';

/**
 * filters, selects, pairs and guards a new release, without committing it
 * @param run the per-call state
 * @param decision the fresh allow decision
 * @param question the clinician's untrusted question
 * @returns the guarded release to commit, or a denial
 */
export async function draftRelease(
  run: Run,
  decision: PolicyAllow,
  question: string,
): Promise<ReleaseDraft | DeniedOutcome> {
  const { deps, engine, caller } = run;
  const filtered = filterVault(engine, { decision, caller });
  const attempt = {
    encounterId: decision.encounterId,
    writeReceipt: true,
    outcome: 'denied' as const,
  };

  if (filtered.kind === 'denied') {
    return deny(run, {
      ...attempt,
      code: 'not-permitted',
      rationaleCode: filtered.decision.rationaleCode,
      stage: 'filter',
    });
  }

  const { projections } = filtered;
  const selection = await selectFor(run, projections, question);
  const paired = pairConflicts({
    selectedIds: selection.selectedIds,
    // a fallback releases the baseline only, so pairing may not widen it
    projections:
      selection.path === 'fallback'
        ? projections.filter((item) => item.category === 'baseline')
        : projections,
    links: deps.conflictLinks ?? [],
  });
  const released = guardRelease({
    recordIds: paired.recordIds,
    decision: filtered.decision,
    projections,
  });

  if (released.length === 0) {
    return deny(run, {
      encounterId: decision.encounterId,
      code: 'temporarily-unavailable',
      rationaleCode: 'selector-fallback',
      stage: 'selector',
      outcome: 'error',
    });
  }

  return {
    prior: filtered.decision,
    projections: released,
    markers: markConflicts(
      new Set(released.map((projection) => projection.recordId)),
      released,
      deps.conflictLinks ?? [],
    ),
    selection: selection.path,
    receipt: { mode: 'new', id: run.newId() },
  };
}

/**
 * re-checks the records of a stored release receipt, without committing; every
 * stored record must still be releasable, or nothing is
 * @param run the per-call state
 * @param stored the requester's receipt for this request id
 * @param patientId the vault patient the task addresses
 * @returns the stored records to re-serve, or a denial when any is no longer releasable
 */
export function draftReplay(
  run: Run,
  stored: StoredReceipt,
  patientId: string,
): ReleaseDraft | DeniedOutcome {
  const { deps, engine, caller } = run;
  const refuse = (rationaleCode: RationaleCode): DeniedOutcome =>
    deny(run, {
      encounterId: stored.encounterId,
      code: 'not-permitted',
      rationaleCode,
      stage: 'replay',
      outcome: 'denied',
      receiptOf: stored.id,
    });

  if (stored.decision !== 'released') {
    return refuse('duplicate-request');
  }

  const prior = priorFromReceipt(deps.db, { stored, caller, patientId });

  if (!prior) {
    return refuse('category-not-permitted');
  }

  const filtered = filterVault(engine, { decision: prior, caller });

  if (filtered.kind === 'denied') {
    return refuse(filtered.decision.rationaleCode);
  }

  const ids = stored.records.map((record) => record.recordId);
  const projected = new Set(filtered.projections.map((item) => item.recordId));

  if (ids.some((id) => !projected.has(id))) {
    return refuse('category-not-permitted');
  }

  const released = guardRelease({
    recordIds: ids,
    decision: filtered.decision,
    projections: filtered.projections,
  });

  if (released.length !== ids.length) {
    return refuse('category-not-permitted');
  }

  return {
    prior: filtered.decision,
    projections: released,
    markers: markConflicts(new Set(ids), released, deps.conflictLinks ?? []),
    selection:
      stored.rationaleCode === 'selector-fallback' ? 'fallback' : 'model',
    receipt: { mode: 'replay', id: stored.id },
  };
}
