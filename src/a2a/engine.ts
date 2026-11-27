/**
 * the A2A task engine (D8, D10); a clinical request creates an unbound
 * AUTH_REQUIRED task and starts a device sign-in at the trusted institution
 * (`/institution-idp`, ADR-9); polls advance it:
 *
 * - unbound: poll the sign-in; a verified clinician binds the task once and
 *   the disclosure pipeline decides for that clinician;
 * - completed: re-check the grant on every poll and render fresh artifacts,
 *   or show "access ended" with none;
 * - past `expires_at`: never any artifacts
 *
 * an invitation redemption takes the same AUTH_REQUIRED and bind path; once
 * bound, the invitation is redeemed for the verified clinician and the task
 * ends with "pending patient confirmation" and no data
 *
 * a record submission (ADR-10) takes the same AUTH_REQUIRED and bind path;
 * once bound, the record is filed only for a clinician with an active grant
 * (otherwise the uniform denial), and the task ends with the receipt
 *
 * a share code takes the same path through the owner-scoped sign-in
 * (`medissy:owner`); only the patient owner of record binds it; anyone else
 * ends it REJECTED, unbound, with no invitation; the owner gets a new
 * single-use invitation as an artifact of that one response: the token is
 * never stored, so later polls show the outcome without it
 *
 * A2A terminal states are immutable, so a released task whose access ends
 * stays COMPLETED: it serves no artifacts, its status message says access
 * ended, and its expiry moves to now
 *
 * abuse limits: each client (IP, IPv6 /64) may hold a few unbound sign-ins
 * at once, each IPv6 /48 a few more across its /64s, and
 * unbound tasks past their expiry are purged with their device codes, so one
 * client cannot fill the device flow's global pending cap
 *
 * the engine is SDK-free; the request handler adapts it to JSON-RPC; polls of
 * one task are serialised in-process so a sign-in result is consumed once;
 * logs carry a task digest and fixed codes only, never a task id, token,
 * device code, user code or question text
 *
 * this file builds the engine; its steps live in `engine-flow.ts`,
 * `engine-endings.ts`, `engine-open.ts` and `engine-limits.ts`
 */
import { taskIdSchema } from '../contracts';

import { poll, recheckOnce } from './engine-flow';
import {
  createAnswerCache,
  createSignInLimits,
  keyedLock,
} from './engine-limits';
import {
  clinicalOpen,
  openTask,
  redeemOpen,
  shareOpen,
  submitOpen,
} from './engine-open';
import {
  DEFAULT_MAX_PENDING_PER_CLIENT,
  DEFAULT_MAX_PENDING_PER_NETWORK,
  DEFAULT_POLL_THROTTLE_MS,
  DEFAULT_TASK_TTL_MS,
  EngineError,
} from './engine-types';
import { nextStep } from './transitions';

import type { AnswerCache, KeyedLock } from './engine-limits';
import type { EngineDeps, TaskEngine } from './engine-types';
import type { TaskJson } from './view';

export * from './engine-types';
export { networkOf } from './engine-limits';

/**
 * polls a task under its lock, serving a fresh cached answer when there is one
 * @param deps the engine's dependencies
 * @param shared the lock and the answer cache
 * @param shared.lock the per-task serialiser
 * @param shared.answers the answer cache
 * @param taskId the task to poll
 * @returns the view
 * @throws {EngineError} `not-found` for an unknown or malformed id
 */
async function getTask(
  deps: EngineDeps,
  shared: { lock: KeyedLock; answers: AnswerCache },
  taskId: string,
): Promise<TaskJson> {
  const { lock, answers } = shared;

  if (!taskIdSchema.safeParse(taskId).success) {
    throw new EngineError('not-found');
  }

  return lock(taskId, async () => {
    const now = deps.clock().getTime();
    const hit = answers.cached(taskId, now);

    if (hit) {
      return hit;
    }

    const task = deps.store.find(taskId);

    if (!task) {
      throw new EngineError('not-found');
    }

    return answers.remember(taskId, now, await poll(deps, task));
  });
}

/**
 * returns the records a task may serve right now
 * @param deps the engine's dependencies
 * @param lock the per-task serialiser
 * @param taskId the task asking
 * @returns the patient and released record ids, or undefined
 */
async function releasedRecords(
  deps: EngineDeps,
  lock: KeyedLock,
  taskId: string,
): Promise<{ patientId: string; recordIds: ReadonlySet<string> } | undefined> {
  if (!taskIdSchema.safeParse(taskId).success) {
    return undefined;
  }

  return lock(taskId, async () => {
    const task = deps.store.find(taskId);

    if (!task || nextStep(task, deps.clock()).kind !== 'recheck') {
      return undefined;
    }

    const { outcome, live } = await recheckOnce(deps, task);

    return outcome.kind === 'released' && live
      ? {
          patientId: task.patientId,
          recordIds: new Set(
            outcome.result.evidence.map((item) => item.recordId),
          ),
        }
      : undefined;
  });
}

/**
 * builds the engine
 * @param deps the store, sign-in, pipeline, clock, logger and links
 * @returns the engine bound to that store and sign-in
 */
export function createTaskEngine(deps: EngineDeps): TaskEngine {
  const ttl = deps.taskTtlMs ?? DEFAULT_TASK_TTL_MS;
  const lock = keyedLock();
  const limits = createSignInLimits({
    store: deps.store,
    logger: deps.logger,
    ttl,
    perClient: deps.maxPendingPerClient ?? DEFAULT_MAX_PENDING_PER_CLIENT,
    perNetwork: deps.maxPendingPerNetwork ?? DEFAULT_MAX_PENDING_PER_NETWORK,
  });
  const answers = createAnswerCache({
    store: deps.store,
    throttle: deps.pollThrottleMs ?? DEFAULT_POLL_THROTTLE_MS,
  });
  const context = { deps, limits, lock, ttl };

  return {
    create: async ({ request, ...input }) =>
      openTask(context, clinicalOpen(request, input)),
    redeem: async ({ tokenHash, ...input }) => {
      if (!deps.invitations) {
        throw new EngineError('unavailable');
      }

      return openTask(context, redeemOpen(tokenHash, input));
    },
    share: async (input) => {
      if (!deps.ownerDeviceFlow || !deps.shares) {
        throw new EngineError('unavailable');
      }

      return openTask(context, shareOpen(input, deps.ownerDeviceFlow));
    },
    submit: async ({ submission, ...input }) => {
      if (!deps.inbound) {
        throw new EngineError('unavailable');
      }

      return openTask(context, submitOpen(submission, input));
    },
    get: async (taskId) => getTask(deps, { lock, answers }, taskId),
    released: async (taskId) => releasedRecords(deps, lock, taskId),
  };
}
