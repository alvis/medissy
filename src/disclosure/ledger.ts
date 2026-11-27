/**
 * the disclosure ledger: validated reads and writes of owner audit events and
 * receipts. Every write validates against its contract first and runs inside
 * the caller's transaction; nothing here opens one; reads return contract
 * shapes; errors never echo stored content
 */
import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  auditEventSchema,
  idSchema,
  LIMITS,
  purposeSchema,
  receiptSchema,
  recordCategorySchema,
} from '../contracts';
import { POLICY_VERSION } from '../policy/decide';
import { readPatientId } from '../policy/repository';
import { readRecordLabels } from '../vault/records';

import type { DatabaseSync } from 'node:sqlite';

import type { AuditEvent, PersonRef, Receipt } from '../contracts';
import type { PolicyAllow } from '../policy/decide';

/** a stored receipt as the replay path needs it */
const storedReceiptSchema = z.strictObject({
  id: idSchema,
  decision: z.enum(['released', 'denied']),
  policyVersion: z.string().min(1),
  encounterId: z.string().min(1),
  purpose: purposeSchema,
  rationaleCode: z.string().min(1),
  issuedAt: z.string().min(1),
  approvedCategories: z.array(recordCategorySchema),
  /** the request digest; absent on receipts from before migration 0008 */
  requestDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  records: z.array(
    z.strictObject({
      recordId: idSchema,
      grantId: idSchema,
      grantVersion: z.number().int().min(1),
    }),
  ),
});
export type StoredReceipt = z.infer<typeof storedReceiptSchema>;

/** the latest audit event written for a receipt, as dedupe compares it */
export interface LastAudit {
  type: string;
  outcome: string;
  details: Record<string, unknown>;
}

/** a receipt to insert, with the request digest it answers */
export interface ReceiptWrite {
  patientId: string;
  receipt: Receipt;
  /** absent only when the request never parsed */
  requestDigest?: string;
}

/**
 * looks up the receipt a requester already holds for a request id
 * @param db the vault
 * @param key the requester and request id
 * @param key.caller the verified requester
 * @param key.requestId the requester's correlation id
 * @returns the stored receipt with its released records, if any
 */
export function findReceipt(
  db: DatabaseSync,
  key: { caller: PersonRef; requestId: string },
): StoredReceipt | undefined {
  const row = db
    .prepare(
      `SELECT id, decision, policy_version, encounter_id, purpose, rationale_code, issued_at, approved_categories,
         request_digest
       FROM receipts WHERE requester_issuer = ? AND requester_subject = ? AND request_id = ?`,
    )
    .get(key.caller.issuer, key.caller.subject, key.requestId);

  if (!row) {
    return undefined;
  }

  const records = db
    .prepare(
      `SELECT record_id, grant_id, grant_version FROM receipt_records
       WHERE receipt_id = ? ORDER BY record_id`,
    )
    .all(String(row.id));

  return storedReceiptSchema.parse({
    id: row.id,
    decision: row.decision,
    policyVersion: row.policy_version,
    encounterId: row.encounter_id,
    purpose: row.purpose,
    rationaleCode: row.rationale_code,
    issuedAt: row.issued_at,
    approvedCategories: JSON.parse(String(row.approved_categories)),
    requestDigest: row.request_digest ?? undefined,
    records: records.map((item) => ({
      recordId: item.record_id,
      grantId: item.grant_id,
      grantVersion: item.grant_version,
    })),
  });
}

/**
 * reads the time of the patient's latest successful (or partial) source sync
 * @param db the vault
 * @param patientId the vault patient
 * @returns the finish time, or undefined when nothing was synced
 */
export function readLastSyncAt(
  db: DatabaseSync,
  patientId: string,
): string | undefined {
  const row = db
    .prepare(
      `SELECT MAX(finished_at) AS at FROM sync_runs
       WHERE patient_id = ? AND status IN ('succeeded', 'partial')`,
    )
    .get(patientId);

  return typeof row?.at === 'string' ? row.at : undefined;
}

/**
 * validates and inserts one audit event
 * @param db the vault, inside a transaction
 * @param event an event, validated against its contract first
 */
export function insertAudit(db: DatabaseSync, event: AuditEvent): void {
  const valid = auditEventSchema.parse(event);

  db.prepare(
    `INSERT INTO audit_events (id, occurred_at, type, outcome, actor_kind, actor_issuer, actor_subject,
       patient_id, request_id, receipt_id, target_type, target_id, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    valid.id,
    valid.occurredAt,
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
 * reads the latest audit event linked to a receipt, so a replay can skip writing
 * an event that would repeat it
 * @param db the vault
 * @param receiptId the receipt the events are linked to
 * @returns the event's type, outcome and parsed details, if any
 */
export function readLastAudit(
  db: DatabaseSync,
  receiptId: string,
): LastAudit | undefined {
  const row = db
    .prepare(
      `SELECT type, outcome, details FROM audit_events
       WHERE receipt_id = ? ORDER BY seq DESC LIMIT 1`,
    )
    .get(receiptId);

  return row
    ? {
        type: String(row.type),
        outcome: String(row.outcome),
        details: z
          .record(z.string(), z.unknown())
          .parse(JSON.parse(String(row.details))),
      }
    : undefined;
}

/**
 * validates and inserts a receipt and, for a release, one row per record
 * @param db the vault, inside a transaction
 * @param write the patient, the receipt (validated against its contract
 * first) and the request digest
 */
export function insertReceipt(db: DatabaseSync, write: ReceiptWrite): void {
  const { patientId, requestDigest } = write;
  const valid = receiptSchema.parse(write.receipt);

  db.prepare(
    `INSERT INTO receipts (id, patient_id, issued_at, request_id, requester_issuer, requester_subject,
       organization_id, roles, encounter_id, purpose, policy_version, approved_categories,
       released_count, decision, rationale_code, request_digest)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    valid.id,
    patientId,
    valid.issuedAt,
    valid.requestId,
    valid.requester.issuer,
    valid.requester.subject,
    valid.organizationId ?? null,
    JSON.stringify(valid.roles),
    valid.encounterId,
    valid.purpose,
    valid.policyVersion,
    JSON.stringify(valid.approvedCategories),
    valid.releasedRecords.length,
    valid.decision,
    valid.rationaleCode,
    requestDigest ?? null,
  );

  const insertRecord = db.prepare(
    `INSERT INTO receipt_records (receipt_id, record_id, source_version, grant_id, grant_version)
     VALUES (?, ?, ?, ?, ?)`,
  );

  for (const record of valid.releasedRecords) {
    insertRecord.run(
      valid.id,
      record.recordId,
      record.sourceVersion,
      record.grant.id,
      record.grant.version,
    );
  }
}

/**
 * rebuilds the allow decision a stored receipt was released under, so the
 * policy re-check can narrow it; records whose labels are no longer readable
 * (withheld by a stricter open conflict) make the rebuild fail closed
 * @param db the vault
 * @param params the release receipt, the bound person and the task's patient
 * @param params.stored the requester's release receipt
 * @param params.caller the person bound to the task
 * @param params.patientId the vault patient the task addresses
 * @returns the prior decision, or undefined when it cannot be rebuilt as-is
 */
export function priorFromReceipt(
  db: DatabaseSync,
  params: { stored: StoredReceipt; caller: PersonRef; patientId: string },
): PolicyAllow | undefined {
  const { stored, caller, patientId } = params;

  if (
    stored.policyVersion !== POLICY_VERSION ||
    readPatientId(db) !== patientId
  ) {
    return undefined;
  }

  const labels = new Map(
    readRecordLabels(db, patientId).map((label) => [label.id, label]),
  );
  const records = stored.records.flatMap((record) => {
    const label = labels.get(record.recordId);

    return label
      ? [
          {
            recordId: record.recordId,
            category: label.category,
            grant: { id: record.grantId, version: record.grantVersion },
          },
        ]
      : [];
  });

  if (records.length !== stored.records.length) {
    return undefined;
  }

  return {
    effect: 'allow',
    rationaleCode: 'granted',
    policyVersion: stored.policyVersion,
    decidedAt: stored.issuedAt,
    patientId,
    encounterId: stored.encounterId,
    purpose: stored.purpose,
    // only issuer and subject are read by the re-check, which rebuilds the
    // caller, categories and expiry from current state
    caller: { ...caller, roles: [] },
    approvedCategories: stored.approvedCategories,
    records,
    expiresAt: stored.issuedAt,
  };
}

/**
 * the details that make an audit event worth writing again: a replay whose
 * outcome and these details match the receipt's latest event adds nothing
 */
const DEDUPE_KEYS: Readonly<Record<string, readonly string[]>> = {
  'disclosure.released': ['policyVersion', 'grantsDigest'],
  'disclosure.denied': ['policyVersion', 'rationaleCode', 'stage'],
};

/**
 * checks whether an event would repeat the latest event already linked to the
 * receipt: same type, same outcome and the same deduplicated details
 * @param db the vault, inside the transaction
 * @param receiptId the receipt the event is linked to
 * @param event the event about to be written
 * @returns true when writing it would add nothing to the log
 */
export function repeatsLast(
  db: DatabaseSync,
  receiptId: string,
  event: AuditEvent,
): boolean {
  const last = readLastAudit(db, receiptId);
  const keys = DEDUPE_KEYS[event.type] ?? [];

  return (
    last !== undefined &&
    keys.length > 0 &&
    last.type === event.type &&
    last.outcome === event.outcome &&
    keys.every((key) => last.details[key] === event.details[key])
  );
}

/**
 * builds the grant details a release relies on, for its audit event; `grants` lists each
 * distinct grant version (omitted when it would exceed a scalar); the digest
 * binds every record to its grant version, since details hold scalars only
 * @param decision the re-checked, narrowed decision
 * @returns `grants` (`id@version`, comma-separated) and `grantsDigest`
 */
export function grantDetails(decision: PolicyAllow): Record<string, string> {
  const versions = [
    ...new Set(
      decision.records.map(({ grant }) => `${grant.id}@${grant.version}`),
    ),
  ].sort();
  const perRecord = decision.records
    .map(({ recordId, grant }) => `${recordId}=${grant.id}@${grant.version}`)
    .sort();
  const grants = versions.join(',');

  return {
    ...(grants.length <= LIMITS.scalar ? { grants } : {}),
    grantsDigest: createHash('sha256')
      .update(perRecord.join('\n'))
      .digest('hex'),
  };
}
