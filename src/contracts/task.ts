import { randomBytes } from 'node:crypto';

import { z } from 'zod';

/** minimum entropy of a task id, in bits */
export const TASK_ID_MIN_BITS = 128;

const BITS_PER_BYTE = 8;
const TASK_ID_BYTES = TASK_ID_MIN_BITS / BITS_PER_BYTE;
/** base64url length of `TASK_ID_BYTES` random bytes, without padding */
const TASK_ID_MIN_LENGTH = 22;
const TASK_ID_MAX_LENGTH = 86;

/** A2A 1.0 task states, exactly as the protocol names them */
export const TASK_STATES = [
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_REJECTED',
  'TASK_STATE_AUTH_REQUIRED',
] as const;
export const taskStateSchema = z.enum(TASK_STATES);
export type TaskState = z.infer<typeof taskStateSchema>;

/**
 * an A2A task id; decision D10: Medissy has no per-client credential, so a
 * calling agent addresses a task by its id alone; the id is therefore a bearer
 * capability and must be unguessable:
 *
 * - it is minted by the server only, from at least 128 bits of
 *   cryptographically secure randomness (`newTaskId`), encoded as base64url;
 *   callers never choose it, and it is never derived from a message id, a
 *   timestamp or a counter
 * - a poll (GetTask) carries no caller identity, so whoever holds the id can
 *   read the task until it expires: the id is the only check on polls; this
 *   is the accepted D10 limitation, recorded as A08 partial/FAIL in
 *   docs/SECURITY.md
 * - a task created in `TASK_STATE_AUTH_REQUIRED` is unbound until a sign-in
 *   at the trusted institution (/institution-idp, ADR-9) binds the clinician,
 *   once (the binding then never changes); releases are decided for that bound
 *   clinician, never for the poller
 * - every poll re-checks the bound clinician's grant and encounter before
 *   returning artifacts; a revoked or expired grant returns no evidence;
 *   artifacts are served only until the task's `expires_at`
 * - a creating message whose id collides with an existing unbound task gets
 *   an error, never the existing task (that would hand out its id)
 * - logs and audit events must not contain a raw task id; record a short
 *   digest instead
 */
export const taskIdSchema = z
  .string()
  .min(TASK_ID_MIN_LENGTH)
  .max(TASK_ID_MAX_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/);
export type TaskId = z.infer<typeof taskIdSchema>;

/**
 * mints a task id from 128 random bits
 * @returns a 22-character base64url id
 */
export function newTaskId(): TaskId {
  return randomBytes(TASK_ID_BYTES).toString('base64url');
}
