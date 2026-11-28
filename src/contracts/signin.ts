import { createHash } from 'node:crypto';

import { z } from 'zod';

import { LIMITS, timestampSchema } from './common';
import { taskIdSchema } from './task';

import type { TaskId } from './task';

/**
 * lifecycle of an in-task device sign-in (migration 0007, `pending_signins`);
 * a row starts `pending` and moves exactly once to a terminal status:
 *
 * - `verified`: the clinician approved and the token verified; the principal
 *   was handed to the caller once and never stored
 * - `denied`: the clinician cancelled at the issuer
 * - `expired`: the device code lapsed; start a new sign-in
 * - `failed`: the issuer errored or the token did not verify
 * - `superseded`: a newer sign-in was started for the same task
 */
export const SIGNIN_STATUSES = [
  'pending',
  'verified',
  'denied',
  'expired',
  'failed',
  'superseded',
] as const;
export const signInStatusSchema = z.enum(SIGNIN_STATUSES);
export type SignInStatus = z.infer<typeof signInStatusSchema>;

/** hex characters of the task digest shown to the clinician */
const TASK_DIGEST_CHARS = 12;
/** shortest and longest poll interval the issuer may ask for, in seconds */
export const SIGNIN_INTERVAL_BOUNDS = { min: 1, max: 300 } as const;

/**
 * a short, non-reversible digest of a task id that the agent and the
 * issuer's confirmation page both show, so the clinician can check the code
 * belongs to their task; never the task id itself (that is a D10 bearer
 * capability)
 */
export const taskDigestSchema = z
  .string()
  .regex(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
export type TaskDigest = z.infer<typeof taskDigestSchema>;

/**
 * computes the display digest of a task id
 * @param taskId the task whose digest both sides display
 * @returns twelve upper-case hex characters in groups of four
 */
export function taskDigest(taskId: TaskId): TaskDigest {
  const hex = createHash('sha256')
    .update(`medissy-signin:${taskId}`)
    .digest('hex')
    .slice(0, TASK_DIGEST_CHARS)
    .toUpperCase();

  return hex.replace(/(.{4})(?!$)/g, '$1-');
}

/**
 * builds the schema for text shown on the issuer's confirmation page: one line, no control or
 * format characters (bidi overrides could disguise it), always escaped when
 * rendered
 * @param max the maximum length
 * @returns the schema
 */
function displayText(max: number): z.ZodString {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u);
}

/**
 * what the clinician sees when confirming a device sign-in, so a code relayed
 * from someone else's task is recognisable as foreign
 */
export const signInContextSchema = z.strictObject({
  taskDigest: taskDigestSchema,
  /** the encounter the request belongs to, as the clinician knows it */
  encounterLabel: displayText(LIMITS.label),
  /** one-line summary of the clinician's question */
  question: displayText(LIMITS.line),
});
export type SignInContext = z.infer<typeof signInContextSchema>;

/**
 * device-authorization request parameters carrying the context to the
 * issuer's confirmation page; the demo IdP requires them from the agent
 * client; an external IdP must be configured to accept and show them
 */
export const SIGNIN_CONTEXT_PARAMS: Readonly<
  Record<keyof SignInContext, string>
> = {
  taskDigest: 'medissy_task_digest',
  encounterLabel: 'medissy_encounter',
  question: 'medissy_question',
};

/**
 * a `pending_signins` row as application code sees it; the device code is
 * deliberately absent: it never leaves the device-flow module
 */
export const pendingSignInSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{22,86}$/),
  taskId: taskIdSchema,
  status: signInStatusSchema,
  intervalSeconds: z
    .number()
    .int()
    .min(SIGNIN_INTERVAL_BOUNDS.min)
    .max(SIGNIN_INTERVAL_BOUNDS.max),
  nextPollAt: timestampSchema,
  expiresAt: timestampSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type PendingSignIn = z.infer<typeof pendingSignInSchema>;
