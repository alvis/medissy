/**
 * writing a committed release inside the open receipt transaction: the owner
 * audit event first, then, for a new release, the receipt and its per-record
 * grant rows; `receipt.ts` owns the transaction around these writes
 */
import {
  grantDetails,
  insertAudit,
  insertReceipt,
  repeatsLast,
} from './ledger';

import type { DatabaseSync } from 'node:sqlite';

import type {
  AuditEvent,
  PersonRef,
  RationaleCode,
  Receipt,
} from '../contracts';
import type { PolicyAllow } from '../policy/decide';

/** how the released records were chosen */
export type SelectionPath = 'model' | 'fallback';

/** one release about to be committed */
export interface ReleasePlan {
  /** the allow decision the filter narrowed; re-checked again here */
  prior: PolicyAllow;
  /** the verified person bound to the task */
  caller: PersonRef;
  requestId: string;
  /** the guarded record ids with the source version each came from */
  records: ReadonlyArray<{ recordId: string; sourceVersion: string }>;
  selection: SelectionPath;
  /** a new receipt to insert, or the existing receipt a replay re-serves */
  receipt: { mode: 'new' | 'replay'; id: string };
  auditId: string;
  /** the request digest a new receipt is bound to; unused on a replay */
  requestDigest?: string;
}

/**
 * builds the owner audit event for a release; ids and counts only
 * @param plan the records, selection path and ids being committed
 * @param decision the re-checked, narrowed decision
 * @param issuedAt the commit time
 * @returns a `disclosure.released` event carrying ids, codes and a count
 */
function releaseAudit(
  plan: ReleasePlan,
  decision: PolicyAllow,
  issuedAt: string,
): AuditEvent {
  return {
    id: plan.auditId,
    occurredAt: issuedAt,
    type: 'disclosure.released',
    outcome: 'success',
    actor: { kind: 'clinician', ...plan.caller },
    patientId: decision.patientId,
    requestId: plan.requestId,
    receiptId: plan.receipt.id,
    target: { type: 'encounter', id: decision.encounterId },
    details: {
      rationaleCode: rationaleFor(plan),
      policyVersion: decision.policyVersion,
      releasedCount: decision.records.length,
      selection: plan.selection,
      replay: plan.receipt.mode === 'replay',
      ...grantDetails(decision),
    },
  };
}

/**
 * builds the receipt for a new release
 * @param plan the release plan
 * @param decision the re-checked, narrowed decision
 * @param issuedAt the commit time
 * @returns a `released` receipt naming each record, source version and grant
 */
function newReceipt(
  plan: ReleasePlan,
  decision: PolicyAllow,
  issuedAt: string,
): Receipt {
  const versions = new Map(
    plan.records.map((record) => [record.recordId, record.sourceVersion]),
  );

  return {
    id: plan.receipt.id,
    issuedAt,
    requestId: plan.requestId,
    requester: {
      issuer: decision.caller.issuer,
      subject: decision.caller.subject,
    },
    organizationId: decision.caller.organizationId,
    roles: [...decision.caller.roles],
    encounterId: decision.encounterId,
    purpose: decision.purpose,
    policyVersion: decision.policyVersion,
    approvedCategories: decision.approvedCategories,
    releasedRecords: decision.records.map((record) => ({
      recordId: record.recordId,
      sourceVersion: versions.get(record.recordId) ?? '',
      grant: record.grant,
    })),
    decision: 'released',
    rationaleCode: rationaleFor(plan),
  };
}

/**
 * returns the rationale a release is recorded under
 * @param plan the release plan
 * @returns `duplicate-request` for a replay, `selector-fallback` for a
 * baseline fallback, else `granted`
 */
function rationaleFor(plan: ReleasePlan): RationaleCode {
  if (plan.receipt.mode === 'replay') {
    return 'duplicate-request';
  }

  return plan.selection === 'fallback' ? 'selector-fallback' : 'granted';
}

/**
 * writes a committed release inside the open transaction: the audit event
 * first (skipped for a replay that would repeat the receipt's latest event),
 * then, for a new release, the receipt and its per-record grant rows
 * @param db the vault, inside the transaction
 * @param release the plan, the re-checked decision and the commit time
 * @param release.plan what is being committed
 * @param release.decision the re-checked, narrowed decision
 * @param release.issuedAt the commit time
 */
export function writeRelease(
  db: DatabaseSync,
  release: { plan: ReleasePlan; decision: PolicyAllow; issuedAt: string },
): void {
  const { plan, decision, issuedAt } = release;
  const audit = releaseAudit(plan, decision, issuedAt);

  if (plan.receipt.mode === 'new' || !repeatsLast(db, plan.receipt.id, audit)) {
    insertAudit(db, audit);
  }

  if (plan.receipt.mode === 'new') {
    insertReceipt(db, {
      patientId: decision.patientId,
      receipt: newReceipt(plan, decision, issuedAt),
      requestDigest: plan.requestDigest,
    });
  }
}
