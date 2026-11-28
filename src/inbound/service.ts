/**
 * filing a record a clinician hands back (ADR-10); for the verified clinician
 * bound to the task, in order:
 *
 * 1. an active grant, exactly as a poll re-checks one, or the uniform denial;
 * 2. a category within that grant (a suggestion outside it is refused);
 * 3. the record Medissy builds: its own ids and patient reference, inert text,
 *    and nothing pointing at another patient;
 * 4. one upload into the allowed folder of the secure store;
 * 5. in one transaction: the grant re-checked, the import through the
 *    provenance path sync uses, the patient's receipt and the audit event
 *
 * every refusal before step 4 files nothing; every submission that reaches a
 * decision is audited with ids and fixed codes only, never record text
 */
import { randomBytes, randomUUID } from 'node:crypto';

import { SourceAdapterError } from '../box/types';
import {
  appendAuditEvent,
  inTransaction,
  insertImport,
} from '../vault/sources';

import { submissionGrant } from './grant';
import { buildRecord } from './record';

import type { DatabaseSync } from 'node:sqlite';

import type { SecureStore } from '../box/types';
import type {
  AuditEvent,
  GrantableCategory,
  PersonRef,
  SubmissionResult,
  SubmitRecordInput,
} from '../contracts';
import type { Clock } from '../policy/engine';

import type { SubmissionGrant } from './grant';
import type { BuiltRecord } from './record';

/** bytes of randomness in a filed name's short id */
const SHORT_ID_BYTES = 4;

/** why a submission was not filed, for the audit log; fixed codes */
export type SubmissionRefusal =
  | 'no-active-grant'
  | 'category-not-permitted'
  | 'foreign-patient'
  | 'invalid-record'
  | 'store-failed'
  | 'import-failed';

/** what a submission came to */
export type SubmissionOutcome =
  /** filed, imported and receipted */
  | { kind: 'filed'; result: SubmissionResult }
  /** no active grant: the same uniform denial a clinical request gets */
  | { kind: 'denied' }
  /** refused for the clinician's own input; nothing filed */
  | {
      kind: 'refused';
      reason: 'category-not-permitted' | 'foreign-patient' | 'invalid-record';
    }
  /** the store or vault failed; nothing (or only an orphan file) filed */
  | { kind: 'unavailable' };

/** one content-free inbound log entry */
export interface InboundLogEntry {
  event: 'inbound.filed' | 'inbound.refused' | 'inbound.failed';
  code?: string;
  /** error class name only */
  error?: string;
}

/** what files a submission for the task engine */
export interface InboundPort {
  /**
   * files a submission for the verified clinician bound to a task
   * @param input the clinician, the vault patient, the task's request id and
   *   the validated submission
   * @param input.caller the verified clinician bound to the task
   * @param input.patientId the vault patient
   * @param input.requestId the task's own request id
   * @param input.submission the validated `submit-record` input
   * @returns what happened; never throws for a refusal
   */
  submit(input: {
    caller: PersonRef;
    patientId: string;
    requestId: string;
    submission: SubmitRecordInput;
  }): Promise<SubmissionOutcome>;
}

/** what the inbound port is built over */
export interface InboundDeps {
  db: DatabaseSync;
  store: SecureStore;
  clock: Clock;
  logger?: {
    info(entry: InboundLogEntry): void;
    warn(entry: InboundLogEntry): void;
  };
  /** id source (tests) */
  newId?: () => string;
}

/** one submission being processed */
interface Attempt {
  deps: InboundDeps;
  caller: PersonRef;
  patientId: string;
  requestId: string;
  resourceType: string;
}

/**
 * appends the submission's audit event
 * @param attempt the submission being processed
 * @param event the outcome, the record it concerns and scalar details
 * @param event.outcome success, denied or error
 * @param event.recordId the filed record, when there is one
 * @param event.details ids and fixed codes only
 */
function audit(
  attempt: Attempt,
  event: {
    outcome: AuditEvent['outcome'];
    recordId?: string;
    details: AuditEvent['details'];
  },
): void {
  const { deps } = attempt;

  appendAuditEvent(deps.db, {
    id: (deps.newId ?? randomUUID)(),
    occurredAt: deps.clock().toISOString(),
    type: 'record.submitted',
    outcome: event.outcome,
    actor: {
      kind: 'clinician',
      issuer: attempt.caller.issuer,
      subject: attempt.caller.subject,
    },
    patientId: attempt.patientId,
    requestId: attempt.requestId,
    ...(event.recordId
      ? { target: { type: 'record', id: event.recordId } }
      : {}),
    details: { resourceType: attempt.resourceType, ...event.details },
  });
}

/**
 * audits and logs a refusal, returning the outcome to show
 * @param attempt the submission being processed
 * @param reason the fixed refusal code
 * @returns the outcome
 */
function refuse(
  attempt: Attempt,
  reason: Exclude<SubmissionRefusal, 'store-failed' | 'import-failed'>,
): SubmissionOutcome {
  audit(attempt, { outcome: 'denied', details: { reason } });
  attempt.deps.logger?.info({ event: 'inbound.refused', code: reason });

  return reason === 'no-active-grant'
    ? { kind: 'denied' }
    : { kind: 'refused', reason };
}

/**
 * audits and logs a failure of the store or the vault
 * @param attempt the submission being processed
 * @param reason the fixed failure code
 * @param error the failure
 * @returns the outcome
 */
function fail(
  attempt: Attempt,
  reason: 'store-failed' | 'import-failed',
  error: unknown,
): SubmissionOutcome {
  const code = error instanceof SourceAdapterError ? error.code : 'unexpected';

  attempt.deps.logger?.warn({
    event: 'inbound.failed',
    code: reason,
    error: error instanceof Error ? error.name : 'unknown',
  });

  try {
    audit(attempt, { outcome: 'error', details: { reason, cause: code } });
  } catch {
    // the vault itself is failing; the log entry above is all there is
  }

  return { kind: 'unavailable' };
}

/**
 * chooses the category to file under: the suggestion when the grant covers it, else
 * the grant's first category
 * @param grant the active grant
 * @param suggested the clinician's suggestion, if any
 * @returns the category and its grant, or undefined when refused
 */
function chooseCategory(
  grant: SubmissionGrant,
  suggested: GrantableCategory | undefined,
): Choice | undefined {
  return suggested === undefined
    ? grant.categories[0]
    : grant.categories.find((choice) => choice.category === suggested);
}

/** the category a submission is filed under and the grant it rests on */
interface Choice {
  category: GrantableCategory;
  grantId: string;
}

/** a built record on its way into the vault */
interface Filing {
  built: BuiltRecord;
  choice: Choice;
  ids: { submissionId: string; recordId: string };
}

/**
 * writes the patient's receipt for a filed record
 * @param attempt the submission being processed
 * @param filing the record, its category and ids
 * @param row the facts known only once the record is imported
 * @param row.sourceId the record_sources row of the filed file
 * @param row.clinician the registry entry of the submitter
 * @param row.at the filing instant, ISO
 */
function insertReceipt(
  attempt: Attempt,
  filing: Filing,
  row: {
    sourceId: number;
    clinician: SubmissionGrant['clinician'];
    at: string;
  },
): void {
  const { built, choice, ids } = filing;

  attempt.deps.db
    .prepare(
      `INSERT INTO inbound_submissions (id, patient_id, record_id, source_id, request_id, grant_id,
         submitter_issuer, submitter_subject, submitter_name, organization_name, filed_name,
         resource_type, category, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ids.submissionId,
      attempt.patientId,
      ids.recordId,
      row.sourceId,
      attempt.requestId,
      choice.grantId,
      attempt.caller.issuer,
      attempt.caller.subject,
      row.clinician.displayName,
      row.clinician.organizationName ?? null,
      built.name,
      built.resourceType,
      choice.category,
      row.at,
    );
}

/**
 * imports the filed record and writes its receipt and audit event, all in one
 * transaction, after re-checking the grant at that moment
 * @param attempt the submission being processed
 * @param filing the built record, its category and ids
 * @param filed what the store reported for the upload
 * @param filed.fileId the Box file id
 * @param filed.version the Box file version id
 * @returns the result, or undefined when the grant ended in between
 */
function importFiled(
  attempt: Attempt,
  filing: Filing,
  filed: { fileId: string; version: string },
): SubmissionResult | undefined {
  const { deps, caller, patientId } = attempt;
  const { built, choice, ids } = filing;
  const now = deps.clock();
  const at = now.toISOString();

  return inTransaction(deps.db, () => {
    const grant = submissionGrant(deps.db, { person: caller, patientId, now });

    if (!grant?.categories.some((c) => c.category === choice.category)) {
      return undefined;
    }

    const record = built.envelope(filed);
    const imported = insertImport(deps.db, {
      patientId,
      syncRunId: null,
      file: {
        ...filed,
        sha256: built.sha256,
        provider: record.source.provider,
        verification: record.source.verification,
        records: [record],
      },
    });

    if (imported.status !== 'imported') {
      throw new Error(`inbound import: ${imported.status}`);
    }

    insertReceipt(attempt, filing, {
      sourceId: imported.sourceId,
      clinician: grant.clinician,
      at,
    });
    audit(attempt, {
      outcome: 'success',
      recordId: ids.recordId,
      details: {
        submissionId: ids.submissionId,
        category: choice.category,
        filedName: built.name,
        boxFileId: filed.fileId,
      },
    });

    return {
      status: 'filed' as const,
      submissionId: ids.submissionId,
      recordId: ids.recordId,
      resourceType: built.resourceType,
      category: choice.category,
      filedName: built.name,
      filedAt: at,
    };
  });
}

/**
 * uploads a built record, then imports it; a grant that ended between the
 * check and the import leaves the uploaded file unimported (a later sync
 * shows it unclassified); nothing is released from it
 * @param attempt the submission being processed
 * @param filing the built record, its category and ids
 * @returns the outcome
 */
async function file(
  attempt: Attempt,
  filing: Filing,
): Promise<SubmissionOutcome> {
  let filed: { fileId: string; version: string };

  try {
    filed = await attempt.deps.store.upload({
      name: filing.built.name,
      bytes: filing.built.bytes,
    });
  } catch (error) {
    return fail(attempt, 'store-failed', error);
  }

  let result: SubmissionResult | undefined;

  try {
    result = importFiled(attempt, filing, {
      fileId: filed.fileId,
      version: filed.version,
    });
  } catch (error) {
    return fail(attempt, 'import-failed', error);
  }

  if (!result) {
    return refuse(attempt, 'no-active-grant');
  }

  attempt.deps.logger?.info({ event: 'inbound.filed', code: result.category });

  return { kind: 'filed', result };
}

/**
 * builds the inbound port over the vault and a secure store
 * @param deps the vault, the secure store, the clock and a logger
 * @returns the port the task engine files submissions through
 */
export function createInboundPort(deps: InboundDeps): InboundPort {
  return {
    submit: async ({ caller, patientId, requestId, submission }) => {
      const attempt: Attempt = {
        deps,
        caller,
        patientId,
        requestId,
        resourceType: submission.record?.resourceType ?? 'DocumentReference',
      };
      const now = deps.clock();
      const grant = submissionGrant(deps.db, {
        person: caller,
        patientId,
        now,
      });

      if (!grant) {
        return refuse(attempt, 'no-active-grant');
      }

      const choice = chooseCategory(grant, submission.category);

      if (!choice) {
        return refuse(attempt, 'category-not-permitted');
      }

      const newId = deps.newId ?? randomUUID;
      const ids = {
        submissionId: `sub-${newId()}`,
        recordId: `inbound-${newId()}`,
        shortId: randomBytes(SHORT_ID_BYTES).toString('hex'),
      };
      const built = buildRecord(submission, {
        patientId,
        category: choice.category,
        ids,
        now: now.toISOString(),
      });

      return typeof built === 'string'
        ? refuse(attempt, built)
        : file(attempt, { built, choice, ids });
    },
  };
}
