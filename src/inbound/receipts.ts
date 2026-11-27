/**
 * the patient's receipts for records their care team handed back (ADR-10),
 * and the Remove action; removing marks the record `entered-in-error`: the
 * vault keeps it (records are insert-only), policy never releases it again,
 * and a task that released it before stops serving it on its next re-check
 */
import { randomUUID } from 'node:crypto';

import { appendAuditEvent, inTransaction } from '../vault/sources';

import type { DatabaseSync } from 'node:sqlite';

import type { PersonRef } from '../contracts';

/** most receipts the owner page lists */
export const MAX_LISTED_SUBMISSIONS = 50;

/** one receipt as the owner page shows it */
export interface SubmissionReceipt {
  id: string;
  recordId: string;
  submitterName: string;
  organizationName: string | null;
  submittedAt: string;
  filedName: string;
  boxFileId: string;
  category: string;
  resourceType: string;
  /** the record's status: `current` until removed */
  status: string;
  removedAt: string | null;
}

/** what a Remove came to */
export type RemoveOutcome = 'removed' | 'already-removed' | 'not-found';

/**
 * lists the patient's latest receipts, newest first
 * @param db the vault
 * @param patientId the vault patient
 * @returns at most `MAX_LISTED_SUBMISSIONS` receipts
 */
export function listSubmissions(
  db: DatabaseSync,
  patientId: string,
): SubmissionReceipt[] {
  return db
    .prepare(
      `SELECT s.id, s.record_id, s.submitter_name, s.organization_name, s.submitted_at, s.filed_name,
              src.box_file_id, s.category, s.resource_type, r.status, s.removed_at
       FROM inbound_submissions s
       JOIN records r ON r.id = s.record_id
       JOIN record_sources src ON src.id = s.source_id
       WHERE s.patient_id = ?
       ORDER BY s.submitted_at DESC, s.id
       LIMIT ?`,
    )
    .all(patientId, MAX_LISTED_SUBMISSIONS)
    .map((row) => ({
      id: String(row.id),
      recordId: String(row.record_id),
      submitterName: String(row.submitter_name),
      organizationName:
        row.organization_name === null ? null : String(row.organization_name),
      submittedAt: String(row.submitted_at),
      filedName: String(row.filed_name),
      boxFileId: String(row.box_file_id),
      category: String(row.category),
      resourceType: String(row.resource_type),
      status: String(row.status),
      removedAt: row.removed_at === null ? null : String(row.removed_at),
    }));
}

/**
 * removes a received record: marks it `entered-in-error`, records who removed it
 * and audits it, in one transaction; removing twice changes nothing
 * @param db the vault
 * @param input the receipt, the verified owner and the server clock
 * @param input.submissionId the receipt to remove
 * @param input.patientId the vault patient
 * @param input.owner the verified patient owner
 * @param input.now the server clock
 * @returns what happened
 */
export function removeSubmission(
  db: DatabaseSync,
  input: {
    submissionId: string;
    patientId: string;
    owner: PersonRef;
    now: Date;
  },
): RemoveOutcome {
  const { submissionId, patientId, owner, now } = input;
  const at = now.toISOString();

  return inTransaction(db, () => {
    const row = db
      .prepare(
        'SELECT record_id, removed_at FROM inbound_submissions WHERE id = ? AND patient_id = ?',
      )
      .get(submissionId, patientId);

    if (!row) {
      return 'not-found';
    }

    if (row.removed_at !== null) {
      return 'already-removed';
    }

    const recordId = String(row.record_id);

    db.prepare(
      `UPDATE records SET status = 'entered-in-error' WHERE id = ? AND status <> 'entered-in-error'`,
    ).run(recordId);
    db.prepare(
      `UPDATE inbound_submissions SET removed_at = ?, removed_by_issuer = ?, removed_by_subject = ?
       WHERE id = ?`,
    ).run(at, owner.issuer, owner.subject, submissionId);
    appendAuditEvent(db, {
      id: randomUUID(),
      occurredAt: at,
      type: 'record.removed',
      outcome: 'success',
      actor: { kind: 'owner', issuer: owner.issuer, subject: owner.subject },
      patientId,
      target: { type: 'record', id: recordId },
      details: { submissionId, status: 'entered-in-error' },
    });

    return 'removed';
  });
}
