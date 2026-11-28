/**
 * how a poll moves a task forward: wait on the sign-in, bind the verified
 * clinician and decide, resume an interrupted bind, or re-check a release
 */
import { taskDigest } from '../contracts/signin';
import { DeviceFlowError } from '../identity/device-flow';

import {
  expired,
  interrupt,
  redeemFor,
  refuseShare,
  shareFor,
  signInLost,
  submitFor,
} from './engine-endings';
import { evidence, view } from './engine-view';
import {
  decisionStatus,
  earliest,
  nextStep,
  recheckOutcome,
  signInOutcome,
  status,
  TEXT,
  textParts,
} from './transitions';

import type { ClinicalRequest, PersonRef, Principal } from '../contracts';
import type { DeviceFlow, DevicePollResult } from '../identity/device-flow';

import type { PortOutcome } from './disclosure-port';
import type { EngineDeps } from './engine-types';
import type { TaskPatch, TaskRow } from './task-store';
import type { TaskJson } from './view';

/** the result of one grant re-check of a released task */
export interface Rechecked {
  outcome: PortOutcome;
  shown: ReturnType<typeof recheckOutcome>;
  updated: TaskRow;
  now: Date;
  live: boolean;
}

/**
 * returns the caller of a bound task
 * @param task a bound task
 * @returns its person
 */
function boundCaller(task: TaskRow): PersonRef {
  if (!task.caller) {
    throw new Error('task is not bound');
  }

  return task.caller;
}

/**
 * checks whether a share-code sign-in may go on: still pending, or verified as
 * the owner of record; a token without `medissy:owner` (a clinician who
 * signed in) or a verified non-owner is refused
 * @param deps the share-code port
 * @param result the sign-in poll
 * @returns false to refuse the task
 */
function isShareOwner(deps: EngineDeps, result: DevicePollResult): boolean {
  if (result.status === 'verified') {
    return deps.shares?.isOwner(result.principal) ?? false;
  }

  return !(result.status === 'failed' && result.reason === 'missing-scope');
}

/**
 * returns the sign-in a task waits on: the owner-scoped one for a share code
 * @param deps the device flows
 * @param task the stored task whose sign-in is needed
 * @returns the device flow, or undefined when share codes are not configured
 */
function flowFor(
  deps: EngineDeps,
  task: TaskRow,
): Pick<DeviceFlow, 'start' | 'poll'> | undefined {
  return task.metadata.skill === 'share-code'
    ? deps.ownerDeviceFlow
    : deps.deviceFlow;
}

/**
 * records a pipeline outcome on a bound task and shows it
 * @param deps the store, clock, logger and evidence renderer
 * @param task the bound task
 * @param outcome what the pipeline decided
 * @returns the view
 */
function apply(
  deps: EngineDeps,
  task: TaskRow,
  outcome: PortOutcome,
): TaskJson {
  const now = deps.clock();
  const next = decisionStatus(outcome, now);
  const patch: TaskPatch = {
    status: next,
    metadata: { requestId: task.metadata.requestId },
  };

  if (outcome.kind === 'released') {
    patch.receiptId = outcome.result.receiptId;
    patch.encounterId = outcome.result.scope.encounterId;
    patch.expiresAt = outcome.result.scope.expiresAt;
  } else if (outcome.denial.receiptId) {
    patch.receiptId = outcome.denial.receiptId;
  }

  const updated = deps.store.update(task.id, patch, now);

  deps.logger.info({
    event: 'a2a.task.decided',
    task: taskDigest(task.id),
    state: next.state,
    code: outcome.kind === 'denied' ? outcome.denial.code : undefined,
  });

  return outcome.kind === 'released'
    ? view(updated, { artifacts: evidence(deps, updated, outcome.result) })
    : view(updated);
}

/**
 * binds a task to its verified clinician (once) and does what the task asked
 * @param deps the store, pipeline and ports
 * @param task the unbound task
 * @param principal the verified caller
 * @returns the view
 */
async function decide(
  deps: EngineDeps,
  task: TaskRow,
  principal: Principal,
): Promise<TaskJson> {
  const now = deps.clock();
  const caller = { issuer: principal.issuer, subject: principal.subject };
  const working = status('TASK_STATE_WORKING', textParts(TEXT.working), now);

  if (!deps.store.bind(task.id, caller, { status: working, at: now })) {
    // bound by someone else in between: show what is there now
    return view(deps.store.find(task.id) ?? task);
  }

  deps.logger.info({ event: 'a2a.task.bound', task: taskDigest(task.id) });

  const bound = deps.store.find(task.id) ?? task;

  if (task.metadata.skill === 'redeem-invitation') {
    return redeemFor(deps, bound, caller);
  }

  if (task.metadata.skill === 'share-code') {
    return shareFor(deps, bound, caller);
  }

  if (task.metadata.skill === 'submit-record') {
    return submitFor(deps, bound, caller);
  }

  const { pending } = task.metadata;

  if (!pending) {
    return interrupt(deps, bound);
  }

  const outcome = await deps.disclosure.disclose({
    principal,
    patientId: task.patientId,
    request: {
      requestId: task.metadata.requestId,
      encounterId: pending.encounterId,
      purpose: 'direct-treatment',
      question: pending.question,
      requestedCategories:
        pending.requestedCategories as ClinicalRequest['requestedCategories'],
    },
  });

  return apply(deps, bound, outcome);
}

/**
 * returns a task's metadata without the submission it held
 * @param task a task that ends before its submission is filed
 * @returns the metadata to keep
 */
function withoutSubmission(task: TaskRow): TaskRow['metadata'] {
  const { submission: _dropped, ...kept } = task.metadata;

  return kept;
}

/**
 * polls an unbound task's sign-in and acts on the result
 * @param deps the device flows, store and pipeline
 * @param task the unbound task
 * @returns the view
 */
async function awaitSignIn(deps: EngineDeps, task: TaskRow): Promise<TaskJson> {
  const flow = flowFor(deps, task);
  const sharing = task.metadata.skill === 'share-code';
  let result: DevicePollResult;

  if (!flow) {
    return signInLost(deps, task);
  }

  try {
    result = await flow.poll(task.id);
  } catch (error) {
    if (!(error instanceof DeviceFlowError)) {
      throw error;
    }

    // the issuer is unreachable; the sign-in stays pending
    deps.logger.warn({
      event: 'a2a.task.signin-unavailable',
      task: taskDigest(task.id),
      error: error.name,
    });

    return view(task);
  }

  if (sharing && !isShareOwner(deps, result)) {
    return refuseShare(deps, task);
  }

  if (result.status === 'verified') {
    return decide(deps, task, result.principal);
  }

  const now = deps.clock();
  const next = signInOutcome(result, now);

  if (!next) {
    return view(task);
  }

  deps.logger.info({
    event: 'a2a.task.signin-ended',
    task: taskDigest(task.id),
    state: next.state,
    code: result.status,
  });

  // an unbound task may end REJECTED or FAILED (migration 0005); it can
  // never be bound afterwards. A held submission is dropped with it.
  return view(
    deps.store.update(
      task.id,
      {
        status: next,
        ...(task.metadata.submission
          ? { metadata: withoutSubmission(task) }
          : {}),
      },
      now,
    ),
  );
}

/**
 * resumes a bound task left undecided (a crash between binding and the
 * decision); a release the pipeline recorded is applied; a transient
 * failure waits for the next poll; anything else (no receipt, or a denial)
 * ends the task as interrupted, releasing nothing
 * @param deps the store and pipeline
 * @param task a bound, undecided task
 * @returns the view
 */
async function resume(deps: EngineDeps, task: TaskRow): Promise<TaskJson> {
  if (task.metadata.skill) {
    // whether it was redeemed or issued is not known here; the owner
    // portal shows it
    return interrupt(deps, task);
  }

  const outcome = await deps.disclosure.redisclose({
    caller: boundCaller(task),
    patientId: task.patientId,
    requestId: task.metadata.requestId,
  });

  if (outcome.kind === 'released') {
    return apply(deps, task, outcome);
  }

  return outcome.denial.code === 'temporarily-unavailable'
    ? view(task)
    : interrupt(deps, task);
}

/**
 * re-checks a released task for its bound clinician; a release narrows the
 * expiry to the grant's; a revocation ends the task now; the task stays
 * COMPLETED either way: A2A terminal states are immutable (migration 0005
 * freezes them), so "access ended" is shown, not stored, and no artifacts
 * are served
 * @param deps the store, pipeline and logger
 * @param task a released task
 * @returns the outcome, what to show, the updated row and whether it is live
 */
export async function recheckOnce(
  deps: EngineDeps,
  task: TaskRow,
): Promise<Rechecked> {
  const outcome = await deps.disclosure.redisclose({
    caller: boundCaller(task),
    patientId: task.patientId,
    requestId: task.metadata.requestId,
  });
  const now = deps.clock();
  const shown = recheckOutcome(outcome);

  deps.logger.info({
    event:
      shown.kind === 'ended' ? 'a2a.task.access-ended' : 'a2a.task.rechecked',
    task: taskDigest(task.id),
    code: shown.kind,
  });

  const expiresAt =
    outcome.kind === 'released'
      ? earliest(task.expiresAt, outcome.result.scope.expiresAt)
      : shown.kind === 'ended'
        ? now.toISOString()
        : undefined;
  const updated = expiresAt
    ? deps.store.update(task.id, { expiresAt }, now)
    : task;
  const live = Date.parse(updated.expiresAt) > now.getTime();

  return { outcome, shown, updated, now, live };
}

/**
 * shows a released task after a fresh grant re-check
 * @param deps the store, pipeline and renderer
 * @param task a released task
 * @returns the view, with evidence only while the grant holds
 */
async function recheck(deps: EngineDeps, task: TaskRow): Promise<TaskJson> {
  const { outcome, shown, updated, now, live } = await recheckOnce(deps, task);

  if (outcome.kind === 'released') {
    return live
      ? view(updated, { artifacts: evidence(deps, updated, outcome.result) })
      : expired(deps, updated);
  }

  return view(updated, {
    parts: shown.kind === 'serve' ? undefined : shown.parts,
    timestamp: now.toISOString(),
  });
}

/**
 * advances a task by one step and shows what its holder may see
 * @param deps the engine's dependencies
 * @param task the stored task
 * @returns the view
 */
export async function poll(deps: EngineDeps, task: TaskRow): Promise<TaskJson> {
  const step = nextStep(task, deps.clock());

  switch (step.kind) {
    case 'expired':
      return expired(deps, task);
    case 'await-sign-in':
      return awaitSignIn(deps, task);
    case 'resume':
      return resume(deps, task);
    case 'recheck':
      return recheck(deps, task);
    default:
      return view(task);
  }
}
