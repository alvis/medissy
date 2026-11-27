/**
 * the `pending_signins` table (migration 0007): durable state of in-task
 * device sign-ins, so a poll after a restart finds its sign-in; only the
 * device-flow module uses it; the device code never leaves this pair
 */
import { randomBytes } from 'node:crypto';

import type { DatabaseSync, StatementSync } from 'node:sqlite';

import type { SignInStatus } from '../contracts/signin';

const ID_BYTES = 16;
const MS_PER_SECOND = 1000;

/** a pending row as the device flow needs it (includes the device code) */
export interface StoredSignIn {
  id: string;
  taskId: string;
  deviceCode: string;
  intervalSeconds: number;
  nextPollAt: string;
  expiresAt: string;
}

/** terminal statuses a pending sign-in can move to */
export type FinalStatus = Exclude<SignInStatus, 'pending'>;

/** data access for `pending_signins` */
export interface SignInStore {
  /** counts pending sign-ins that have not expired */
  countLive(at: Date): number;
  /**
   * supersedes any pending sign-in of the task and inserts a new one, in one
   * transaction
   */
  replace(input: {
    taskId: string;
    deviceCode: string;
    intervalSeconds: number;
    expiresAt: Date;
    at: Date;
  }): void;
  /** returns the task's pending sign-in, if any */
  findPending(taskId: string): StoredSignIn | undefined;
  /**
   * reserves the next token-endpoint call: succeeds for exactly one caller
   * once `next_poll_at` has passed, and moves it one interval ahead
   */
  claimPoll(id: string, intervalSeconds: number, at: Date): boolean;
  /** raises the interval after `slow_down` (or a 429) and pushes the next poll */
  slowDown(id: string, intervalSeconds: number, at: Date): void;
  /** moves a pending sign-in to a terminal status; false if already final */
  finish(id: string, status: FinalStatus, at: Date): boolean;
}

type StatementName =
  | 'countLive'
  | 'supersede'
  | 'insert'
  | 'findPending'
  | 'claim'
  | 'slowDown'
  | 'finish';

/**
 * adds seconds to an instant
 * @param at the instant
 * @param seconds seconds to add
 * @returns the ISO timestamp
 */
function plus(at: Date, seconds: number): string {
  return new Date(at.getTime() + seconds * MS_PER_SECOND).toISOString();
}

/**
 * prepares the store's statements
 * @param db the vault
 * @returns the statements by name
 */
function prepare(db: DatabaseSync): Record<StatementName, StatementSync> {
  return {
    countLive: db.prepare(
      "SELECT count(*) AS n FROM pending_signins WHERE status = 'pending' AND expires_at > ?",
    ),
    supersede: db.prepare(
      "UPDATE pending_signins SET status = 'superseded', updated_at = ? WHERE task_id = ? AND status = 'pending'",
    ),
    insert: db.prepare(
      `INSERT INTO pending_signins
         (id, task_id, device_code, status, interval_seconds, next_poll_at, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
    ),
    findPending: db.prepare(
      `SELECT id, task_id AS taskId, device_code AS deviceCode, interval_seconds AS intervalSeconds,
              next_poll_at AS nextPollAt, expires_at AS expiresAt
       FROM pending_signins WHERE task_id = ? AND status = 'pending'`,
    ),
    claim: db.prepare(
      `UPDATE pending_signins SET next_poll_at = ?, updated_at = ?
       WHERE id = ? AND status = 'pending' AND next_poll_at <= ?`,
    ),
    slowDown: db.prepare(
      `UPDATE pending_signins SET interval_seconds = ?, next_poll_at = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
    ),
    finish: db.prepare(
      "UPDATE pending_signins SET status = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
    ),
  };
}

/**
 * builds the store over a vault opened through `openVault`
 * @param db the vault
 * @returns a store that keeps sign-ins in the vault
 */
export function createSignInStore(db: DatabaseSync): SignInStore {
  const sql = prepare(db);

  return {
    countLive: (at) =>
      Number((sql.countLive.get(at.toISOString()) as { n: number }).n),
    /**
     * supersedes any pending sign-in of the task and stores a new one
     * @param input the task, device code, interval and expiry
     */
    replace(input) {
      const now = input.at.toISOString();

      db.exec('BEGIN IMMEDIATE');

      try {
        sql.supersede.run(now, input.taskId);
        sql.insert.run(
          randomBytes(ID_BYTES).toString('base64url'),
          input.taskId,
          input.deviceCode,
          input.intervalSeconds,
          now,
          input.expiresAt.toISOString(),
          now,
          now,
        );
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    findPending: (taskId) =>
      sql.findPending.get(taskId) as StoredSignIn | undefined,
    claimPoll: (id, intervalSeconds, at) =>
      Number(
        sql.claim.run(
          plus(at, intervalSeconds),
          at.toISOString(),
          id,
          at.toISOString(),
        ).changes,
      ) === 1,
    /**
     * slows a sign-in's polling after the provider asked to
     * @param id the sign-in id
     * @param intervalSeconds the new minimum seconds between polls
     * @param at the current time
     */
    slowDown(id, intervalSeconds, at) {
      sql.slowDown.run(
        intervalSeconds,
        plus(at, intervalSeconds),
        at.toISOString(),
        id,
      );
    },
    finish: (id, status, at) =>
      Number(sql.finish.run(status, at.toISOString(), id).changes) === 1,
  };
}
