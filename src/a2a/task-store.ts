/**
 * durable A2A task store over `a2a_tasks` (migration 0005), replacing the
 * SDK's in-memory store; writes are INSERT (create) then UPDATE (change);
 * never an upsert; the state column and `status_json` are always written
 * together (the migration checks they agree); the binding goes NULL ->
 * (issuer, subject) once and only from AUTH_REQUIRED, a terminal task is
 * frozen, the expiry only ever shrinks, and artifacts are never persisted:
 * the engine renders them on every poll after a fresh re-check, so a stale
 * artifact cannot be served
 *
 * the origin messageId is unique across all clients, not per client: D10
 * gives a calling agent no identity, so a messageId another client already
 * used is refused (a collision error), never answered with that task
 */
import { z } from 'zod';

import { submitRecordInputSchema, taskStateSchema } from '../contracts';

import type { DatabaseSync } from 'node:sqlite';

import type { PersonRef, TaskId, TaskState } from '../contracts';

/** A2A 1.0 message part in JSON form, as stored in a status message */
export type StoredPart = Record<string, unknown>;

/** the A2A task status as stored in `status_json` */
export const storedStatusSchema = z.strictObject({
  state: taskStateSchema,
  /** agent message shown with the status: parts only, no ids */
  parts: z.array(z.record(z.string(), z.unknown())).optional(),
  timestamp: z.string(),
});
export type StoredStatus = z.infer<typeof storedStatusSchema>;

/** engine bookkeeping in `metadata`; never returned to a caller */
export const taskMetadataSchema = z.strictObject({
  requestId: z.string(),
  /**
   * set for an invitation redemption, a share code or a record submission;
   * absent for a clinical request
   */
  skill: z
    .enum(['redeem-invitation', 'share-code', 'submit-record'])
    .optional(),
  /**
   * the record a clinician hands back (bounded by its contract); held only
   * until the task is decided or ends, then dropped
   */
  submission: submitRecordInputSchema.optional(),
  /** the invitation to redeem (its token's hash only); dropped once decided */
  invitation: z
    .strictObject({ tokenHash: z.string().regex(/^[0-9a-f]{64}$/) })
    .optional(),
  /** the pending request; dropped once the disclosure decision is made */
  pending: z
    .strictObject({
      encounterId: z.string(),
      question: z.string(),
      requestedCategories: z.array(z.string()).optional(),
    })
    .optional(),
});
export type TaskMetadata = z.infer<typeof taskMetadataSchema>;

/** one task as the engine sees it */
export interface TaskRow {
  id: TaskId;
  contextId: string;
  caller: PersonRef | null;
  patientId: string;
  encounterId: string | null;
  receiptId: string | null;
  originMessageId: string;
  state: TaskState;
  status: StoredStatus;
  metadata: TaskMetadata;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

/** what `create` inserts */
export interface NewTask {
  id: TaskId;
  contextId: string;
  patientId: string;
  originMessageId: string;
  status: StoredStatus;
  metadata: TaskMetadata;
  createdAt: string;
  expiresAt: string;
}

/** a change to an existing task */
export interface TaskPatch {
  /** the new status; it also sets the state column */
  status?: StoredStatus;
  metadata?: TaskMetadata;
  encounterId?: string;
  receiptId?: string;
  /**
   * applied only if earlier than the stored expiry; an instant at or before
   * the creation time is clamped to just after it (the task ends at once)
   */
  expiresAt?: string;
}

/** a creating message whose id is already used by a task */
export class MessageIdCollisionError extends Error {
  /** constructs the error; it carries no id */
  constructor() {
    super('a task already exists for this message id');
    this.name = 'MessageIdCollisionError';
  }
}

/** persistence of A2A tasks, their sign-in binding and their status */
export interface TaskStore {
  /**
   * inserts an unbound AUTH_REQUIRED task, refusing a message id any task
   * (bound or not, from any client) already used
   * @throws {MessageIdCollisionError} on a reused message id
   */
  create(task: NewTask): TaskRow;
  find(id: TaskId): TaskRow | undefined;
  /** deletes a task that was never handed out (sign-in failed to start) */
  remove(id: TaskId): void;
  /**
   * binds an unbound AUTH_REQUIRED task to the verified person and moves it to
   * the given (WORKING) status in the same statement
   * @returns false when the task was already bound (by a concurrent poll)
   */
  bind(
    id: TaskId,
    caller: PersonRef,
    change: { status: StoredStatus; at: Date },
  ): boolean;
  /** applies a change; the expiry can only shrink */
  update(id: TaskId, patch: TaskPatch, at: Date): TaskRow;
  /**
   * deletes abandoned tasks: unbound tasks past their expiry, with their
   * sign-in rows and the demo IdP's device codes for them; each is first
   * counted in the patient's `unsigned_requests` day counts
   * @returns how many tasks were deleted
   */
  purgeAbandoned(at: Date): number;
}

type Row = Record<string, unknown>;

/**
 * maps an `a2a_tasks` row
 * @param row the raw row
 * @returns the typed task
 */
function toTask(row: Row): TaskRow {
  const issuer = row.caller_issuer as string | null;
  const subject = row.caller_subject as string | null;

  return {
    id: row.id as string,
    contextId: row.context_id as string,
    caller: issuer && subject ? { issuer, subject } : null,
    patientId: row.patient_id as string,
    encounterId: row.encounter_id as string | null,
    receiptId: row.receipt_id as string | null,
    originMessageId: row.origin_message_id as string,
    state: taskStateSchema.parse(row.state),
    status: storedStatusSchema.parse(JSON.parse(String(row.status_json))),
    metadata: taskMetadataSchema.parse(
      JSON.parse(typeof row.metadata === 'string' ? row.metadata : '{}'),
    ),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    expiresAt: row.expires_at as string,
  };
}

/**
 * clamps a requested expiry to just after the creation time: the migration
 * requires `created_at < expires_at`, and an instant at or before creation
 * means the task has ended already
 * @param requested the requested expiry (ISO)
 * @param createdAt the task's creation time (ISO)
 * @returns the expiry to store (ISO)
 */
function clampExpiry(requested: string, createdAt: string): string {
  const floor = Date.parse(createdAt) + 1;

  return Date.parse(requested) < floor
    ? new Date(floor).toISOString()
    : new Date(Date.parse(requested)).toISOString();
}

/**
 * runs a body inside one `BEGIN IMMEDIATE` transaction
 * @param db the vault
 * @param body the work
 * @returns what the body returns
 */
function immediate<T>(db: DatabaseSync, body: () => T): T {
  db.exec('BEGIN IMMEDIATE');

  try {
    const result = body();

    db.exec('COMMIT');

    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * inserts an unbound AUTH_REQUIRED task, refusing a reused message id
 * @param db the vault
 * @param task the new task
 * @throws {MessageIdCollisionError} on a reused message id
 */
function insertTask(db: DatabaseSync, task: NewTask): void {
  const taken = db
    .prepare('SELECT 1 FROM a2a_tasks WHERE origin_message_id = ? LIMIT 1')
    .get(task.originMessageId);

  if (taken) {
    throw new MessageIdCollisionError();
  }

  db.prepare(
    `INSERT INTO a2a_tasks (id, context_id, patient_id, origin_message_id, state, status_json, metadata, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, 'TASK_STATE_AUTH_REQUIRED', ?, ?, ?, ?, ?)`,
  ).run(
    task.id,
    task.contextId,
    task.patientId,
    task.originMessageId,
    JSON.stringify(task.status),
    JSON.stringify(task.metadata),
    task.createdAt,
    task.createdAt,
    task.expiresAt,
  );
}

/**
 * binds an unbound AUTH_REQUIRED task to a person and a new status
 * @param db the vault
 * @param change which task to bind, to whom, and the status it moves to
 * @param change.id the task to bind
 * @param change.caller the verified person
 * @param change.status the status to store, which is WORKING
 * @param change.at the time of the change
 * @returns false when the task was already bound
 */
function bindTask(
  db: DatabaseSync,
  change: { id: TaskId; caller: PersonRef; status: StoredStatus; at: Date },
): boolean {
  const { id, caller, status: next, at } = change;
  const result = db
    .prepare(
      `UPDATE a2a_tasks SET caller_issuer = ?, caller_subject = ?, state = ?, status_json = ?, updated_at = ?
       WHERE id = ? AND caller_subject IS NULL AND state = 'TASK_STATE_AUTH_REQUIRED'`,
    )
    .run(
      caller.issuer,
      caller.subject,
      next.state,
      JSON.stringify(next),
      at.toISOString(),
      id,
    );

  return Number(result.changes) === 1;
}

/**
 * applies a patch to a task row; unset patch fields keep their stored value
 * @param db the vault
 * @param change the task and the patch to apply
 * @param change.id the task to change
 * @param change.patch the fields to overwrite
 * @param change.expiresAt the already clamped new expiry, or null
 * @param change.at the time of the change
 */
function patchTask(
  db: DatabaseSync,
  change: { id: TaskId; patch: TaskPatch; expiresAt: string | null; at: Date },
): void {
  const { id, patch, expiresAt, at } = change;

  db.prepare(
    `UPDATE a2a_tasks SET
       state = COALESCE(?, state),
       status_json = COALESCE(?, status_json),
       metadata = COALESCE(?, metadata),
       encounter_id = COALESCE(encounter_id, ?),
       receipt_id = COALESCE(receipt_id, ?),
       expires_at = CASE WHEN ? IS NOT NULL AND ? < expires_at THEN ? ELSE expires_at END,
       updated_at = ?
     WHERE id = ?`,
  ).run(
    patch.status?.state ?? null,
    patch.status ? JSON.stringify(patch.status) : null,
    patch.metadata ? JSON.stringify(patch.metadata) : null,
    patch.encounterId ?? null,
    patch.receiptId ?? null,
    expiresAt,
    expiresAt,
    expiresAt,
    at.toISOString(),
    id,
  );
}

/**
 * deletes tasks that never got a caller and have expired, with their device
 * codes, after adding them to the patient's day counts of requests that
 * stopped at sign-in (`unsigned_requests`; content-free, one row per day and
 * skill)
 * @param db the vault
 * @param at the current time
 * @returns how many tasks were deleted
 */
function purgeAbandonedTasks(db: DatabaseSync, at: Date): number {
  const now = at.toISOString();

  // a task without a skill in its metadata is a clinical request
  db.prepare(
    `INSERT INTO unsigned_requests (patient_id, day, skill, stopped)
       SELECT patient_id, substr(created_at, 1, 10),
              COALESCE(json_extract(metadata, '$.skill'), 'clinical-evidence-request'), COUNT(*)
       FROM a2a_tasks WHERE caller_subject IS NULL AND expires_at <= ?
       GROUP BY 1, 2, 3
     ON CONFLICT (patient_id, day, skill) DO UPDATE SET stopped = stopped + excluded.stopped`,
  ).run(now);

  // the IdP keeps its own device code row until it lapses; drop it with
  // the task (pending_signins goes by ON DELETE CASCADE)
  db.prepare(
    `DELETE FROM idp_store WHERE model = 'DeviceCode' AND id IN (
       SELECT s.device_code FROM pending_signins s
       JOIN a2a_tasks t ON t.id = s.task_id
       WHERE t.caller_subject IS NULL AND t.expires_at <= ?)`,
  ).run(now);

  const result = db
    .prepare(
      'DELETE FROM a2a_tasks WHERE caller_subject IS NULL AND expires_at <= ?',
    )
    .run(now);

  return Number(result.changes);
}

/**
 * builds the store over an open vault
 * @param db a vault opened through `openVault`
 * @returns the store backed by that vault
 */
export function createTaskStore(db: DatabaseSync): TaskStore {
  const select = db.prepare('SELECT * FROM a2a_tasks WHERE id = ?');
  const find = (id: TaskId): TaskRow | undefined => {
    const row = select.get(id);

    return row ? toTask(row) : undefined;
  };
  const load = (id: TaskId): TaskRow => {
    const task = find(id);

    if (!task) {
      throw new Error('task vanished');
    }

    return task;
  };

  return {
    find,
    create: (task) =>
      immediate(db, () => {
        insertTask(db, task);

        return load(task.id);
      }),
    remove: (id) => {
      db.prepare(
        'DELETE FROM a2a_tasks WHERE id = ? AND caller_subject IS NULL',
      ).run(id);
    },
    bind: (id, caller, change) => bindTask(db, { id, caller, ...change }),
    update: (id, patch, at) => {
      const expiresAt = patch.expiresAt
        ? clampExpiry(patch.expiresAt, load(id).createdAt)
        : null;

      patchTask(db, { id, patch, expiresAt, at });

      return load(id);
    },
    purgeAbandoned: (at) => immediate(db, () => purgeAbandonedTasks(db, at)),
  };
}
