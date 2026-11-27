/**
 * the audit-before-release receipt transaction (brief §7 step 6, §8); one
 * `BEGIN IMMEDIATE` transaction re-checks the decision at use for the bound
 * person, verifies each record's grant app-side (grantee, category, latest
 * live version), then writes the owner audit event first and the receipt with
 * its per-record grant rows after it. Any failure rolls the whole transaction
 * back, so nothing is released without a durable audit event (A10)
 *
 * denials write an owner-only audit event and, when the request id is still
 * unused, a denial receipt carrying the rationale code only
 *
 * nothing here logs or throws record content: errors carry the SQLite or
 * schema failure only, and callers report their class name, never a message
 */
import {
  grantCoversRecord,
  granteeMatches,
  isGrantInForce,
} from '../contracts';
import { readGrants } from '../policy/repository';
import { readRecordLabels } from '../vault/records';

import { findReceipt, insertAudit, insertReceipt, repeatsLast } from './ledger';

import { writeRelease } from './release-write';

import type { DatabaseSync } from 'node:sqlite';

import type {
  AuditEvent,
  Grant,
  GrantCaller,
  PersonRef,
  Purpose,
  RationaleCode,
} from '../contracts';
import type {
  PolicyAllow,
  RecordLabel,
  ReleasedRecordDecision,
} from '../policy/decide';
import type { PolicyEngine } from '../policy/engine';

import type { ReleasePlan, SelectionPath } from './release-write';

export type { ReleasePlan, SelectionPath };

/** where in the pipeline an event happened; content-free */
export type DisclosureStage =
  'request' | 'policy' | 'filter' | 'selector' | 'guard' | 'receipt' | 'replay';

/** the outcome of the receipt transaction */
export type CommitOutcome =
  | { kind: 'committed'; decision: PolicyAllow; issuedAt: string }
  | { kind: 'denied'; rationaleCode: RationaleCode }
  | { kind: 'duplicate' };

/** a denial to record */
export interface DenialRecord {
  auditId: string;
  /** the id of a denial receipt to write when the request id is unused */
  receiptId?: string;
  caller: PersonRef;
  /** the vault patient; without one only the audit event is written */
  patientId?: string;
  requestId: string;
  /** as attempted; only set once the request passed schema validation */
  encounterId?: string;
  purpose: Purpose;
  policyVersion: string;
  /** required for a denial receipt; absent for an internal failure */
  rationaleCode?: RationaleCode;
  /** absent when the failing stage is unknown */
  stage?: DisclosureStage;
  /** `denied` for an authorization outcome, `error` for a failed attempt */
  outcome: 'denied' | 'error';
  /** the request digest a denial receipt is bound to */
  requestDigest?: string;
  /**
   * the existing receipt this attempt re-used; the audit event is linked to
   * it, and skipped when it would repeat that receipt's latest event
   */
  receiptOf?: string;
}

/** what `verifyReleaseGrants` checks */
export interface GrantCheckParams {
  /** the re-checked release, record by record with its grant version */
  records: readonly ReleasedRecordDecision[];
  /** the effective (highest-version) grants read inside the transaction */
  grants: readonly Grant[];
  /** current labels of the patient's releasable records */
  labels: readonly RecordLabel[];
  /** the caller the re-check admitted */
  caller: GrantCaller;
  encounterId: string;
  now: Date;
}

/**
 * commits a release: re-checks, verifies grants, then audits first and writes
 * the receipt second, all in one transaction; a replay writes the audit event only
 * @param engine the policy engine over the vault
 * @param db the same vault
 * @param plan what is about to be released
 * @returns committed with the re-checked decision, a recorded denial when the
 * re-check no longer covers every record, or duplicate when the request id
 * already has a receipt (nothing written)
 * @throws {Error} when any read or write fails; the transaction is rolled back first
 */
export function commitRelease(
  engine: PolicyEngine,
  db: DatabaseSync,
  plan: ReleasePlan,
): CommitOutcome {
  return transaction(db, (): CommitOutcome => {
    if (plan.receipt.mode === 'new' && findReceipt(db, plan)) {
      return { kind: 'duplicate' };
    }

    const now = engine.now();
    const current = engine.recheck({ prior: plan.prior, caller: plan.caller });
    const denial = (rationaleCode: RationaleCode): CommitOutcome => {
      writeDenial(db, now, {
        auditId: plan.auditId,
        receiptId: plan.receipt.mode === 'new' ? plan.receipt.id : undefined,
        caller: plan.caller,
        patientId: plan.prior.patientId,
        requestId: plan.requestId,
        encounterId: plan.prior.encounterId,
        purpose: plan.prior.purpose,
        policyVersion: plan.prior.policyVersion,
        rationaleCode,
        stage: 'receipt',
        outcome: 'denied',
        requestDigest: plan.requestDigest,
        receiptOf: plan.receipt.mode === 'replay' ? plan.receipt.id : undefined,
      });

      return { kind: 'denied', rationaleCode };
    };

    if (current.effect === 'deny') {
      return denial(current.rationaleCode);
    }

    const byId = new Map(current.records.map((item) => [item.recordId, item]));
    const records = plan.records.map(({ recordId }) => byId.get(recordId));

    if (records.some((record) => record === undefined)) {
      return denial('category-not-permitted');
    }

    const released = records.filter((record) => record !== undefined);
    const decision = narrowTo(current, released);
    const grantsHold = verifyReleaseGrants({
      records: released,
      grants: readGrants(db, decision.patientId).grants,
      labels: readRecordLabels(db, decision.patientId),
      caller: decision.caller,
      encounterId: decision.encounterId,
      now,
    });

    if (!grantsHold) {
      return denial('category-not-permitted');
    }

    const issuedAt = now.toISOString();

    writeRelease(db, { plan, decision, issuedAt });

    return { kind: 'committed', decision, issuedAt };
  });
}

/**
 * records a denial: an owner-only audit event, plus a denial receipt when a
 * receipt id is given, the vault has a patient and the request id is unused
 * @param db the vault
 * @param now the server time
 * @param denial what was denied and why
 * @throws {Error} when a write fails; the transaction is rolled back first
 */
export function recordDenial(
  db: DatabaseSync,
  now: Date,
  denial: DenialRecord,
): void {
  transaction(db, () => {
    writeDenial(db, now, denial);
  });
}

/**
 * checks the app-side grant at use (FND02 P3): every released record's grant
 * is the latest live allow version, names this caller, belongs to this
 * encounter and covers the record's current category and sensitivity
 * @param params the re-checked records, current grants, labels and caller
 * @returns true only when every record passes
 */
export function verifyReleaseGrants(params: GrantCheckParams): boolean {
  const { records, caller, encounterId, now } = params;
  const grants = new Map(params.grants.map((grant) => [grant.id, grant]));
  const labels = new Map(params.labels.map((label) => [label.id, label]));

  return records.every((record) => {
    const grant = grants.get(record.grant.id);
    const label = labels.get(record.recordId);

    return (
      grant !== undefined &&
      label !== undefined &&
      grant.version === record.grant.version &&
      grant.effect === 'allow' &&
      grant.encounterId === encounterId &&
      isGrantInForce(grant, now) &&
      granteeMatches(grant.grantee, caller) &&
      label.category === record.category &&
      grantCoversRecord(grant, label)
    );
  });
}

/**
 * runs writes in one `BEGIN IMMEDIATE` transaction, rolling back on any error
 * @param db the vault
 * @param work the reads and writes
 * @returns what the work returned
 */
function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');

  try {
    const result = work();

    db.exec('COMMIT');

    return result;
  } catch (error) {
    db.exec('ROLLBACK');

    throw error;
  }
}

/**
 * writes a denial inside an open transaction: audit first, then the receipt
 * @param db the vault
 * @param now the server time
 * @param denial what was denied and why
 */
function writeDenial(db: DatabaseSync, now: Date, denial: DenialRecord): void {
  const issuedAt = now.toISOString();
  const { caller, patientId, encounterId, receiptId, rationaleCode } = denial;
  const withReceipt =
    receiptId !== undefined &&
    rationaleCode !== undefined &&
    patientId !== undefined &&
    encounterId !== undefined &&
    !findReceipt(db, denial);

  const audit: AuditEvent = {
    id: denial.auditId,
    occurredAt: issuedAt,
    type: 'disclosure.denied',
    outcome: denial.outcome,
    actor: { kind: 'clinician', ...caller },
    patientId,
    requestId: denial.requestId,
    receiptId: withReceipt ? receiptId : denial.receiptOf,
    target: encounterId ? { type: 'encounter', id: encounterId } : undefined,
    details: {
      policyVersion: denial.policyVersion,
      ...(rationaleCode ? { rationaleCode } : {}),
      ...(denial.stage ? { stage: denial.stage } : {}),
    },
  };

  if (
    withReceipt ||
    denial.receiptOf === undefined ||
    !repeatsLast(db, denial.receiptOf, audit)
  ) {
    insertAudit(db, audit);
  }

  if (withReceipt) {
    insertReceipt(db, {
      patientId,
      requestDigest: denial.requestDigest,
      receipt: {
        id: receiptId,
        issuedAt,
        requestId: denial.requestId,
        requester: { issuer: caller.issuer, subject: caller.subject },
        roles: [],
        encounterId,
        purpose: denial.purpose,
        policyVersion: denial.policyVersion,
        approvedCategories: [],
        releasedRecords: [],
        decision: 'denied',
        rationaleCode,
      },
    });
  }
}

/**
 * narrows a re-checked allow to exactly the released records
 * @param decision the re-checked allow
 * @param records the released subset of its records
 * @returns the allow listing those records and their categories only
 */
function narrowTo(
  decision: PolicyAllow,
  records: ReleasedRecordDecision[],
): PolicyAllow {
  const categories = new Set(records.map((record) => record.category));

  return {
    ...decision,
    approvedCategories: decision.approvedCategories.filter((category) =>
      categories.has(category),
    ),
    records,
  };
}
