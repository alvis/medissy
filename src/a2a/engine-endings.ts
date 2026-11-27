/**
 * the ways a task ends without a disclosure decision: an invitation redeemed,
 * a share code issued or refused, an interrupted or lapsed task, and a
 * sign-in that can no longer be polled
 */
import { taskDigest } from '../contracts/signin';
import { renderShareParts } from '../widgets';

import { SHARE_ARTIFACT_ID } from './engine-types';
import { view } from './engine-view';
import {
  expiredState,
  status,
  submissionStatus,
  TEXT,
  textParts,
} from './transitions';

import type { PersonRef } from '../contracts';

import type { EngineDeps } from './engine-types';
import type { TaskRow } from './task-store';
import type { TaskJson } from './view';

/**
 * redeems a bound task's invitation for its verified clinician and ends the
 * task: COMPLETED (pending patient confirmation) or REJECTED; nothing is
 * released either way, and the token hash is dropped
 * @param deps the store, clock and logger
 * @param task the bound redemption task
 * @param caller the verified clinician
 * @returns the view
 */
export function redeemFor(
  deps: EngineDeps,
  task: TaskRow,
  caller: PersonRef,
): TaskJson {
  const { invitation } = task.metadata;
  const redeemed =
    invitation && deps.invitations
      ? deps.invitations.redeem({
          tokenHash: invitation.tokenHash,
          requester: caller,
        })
      : { ok: false };
  const now = deps.clock();
  const next = redeemed.ok
    ? status('TASK_STATE_COMPLETED', textParts(TEXT.redeemed), now)
    : status('TASK_STATE_REJECTED', textParts(TEXT.redeemRefused), now);

  deps.logger.info({
    event: 'a2a.task.redeemed',
    task: taskDigest(task.id),
    state: next.state,
  });

  return view(
    deps.store.update(
      task.id,
      {
        status: next,
        metadata: {
          requestId: task.metadata.requestId,
          skill: 'redeem-invitation',
        },
      },
      now,
    ),
  );
}

/**
 * issues a share code to a bound task's verified owner: COMPLETED with the
 * invitation as an artifact of this response only (the token is never
 * stored), or REJECTED
 * @param deps the store, clock, logger and share-code port
 * @param task the bound share-code task
 * @param owner the verified patient owner
 * @returns the view
 */
export function shareFor(
  deps: EngineDeps,
  task: TaskRow,
  owner: PersonRef,
): TaskJson {
  const share = deps.shares?.create({ owner });
  const now = deps.clock();
  const next = share
    ? status('TASK_STATE_COMPLETED', textParts(TEXT.shared), now)
    : status('TASK_STATE_REJECTED', textParts(TEXT.shareRefused), now);

  deps.logger.info({
    event: 'a2a.task.shared',
    task: taskDigest(task.id),
    state: next.state,
  });

  const updated = deps.store.update(
    task.id,
    {
      status: next,
      metadata: { requestId: task.metadata.requestId, skill: 'share-code' },
    },
    now,
  );

  return share
    ? view(updated, {
        artifacts: [
          {
            artifactId: SHARE_ARTIFACT_ID,
            name: 'Medissy share code (SYNTHETIC DEMO)',
            parts: renderShareParts(share),
          },
        ],
      })
    : view(updated);
}

/**
 * files a bound task's submission for its verified clinician and ends the
 * task: COMPLETED with the receipt, REJECTED (the uniform denial without an
 * active grant, or a refusal of the input) or FAILED (store unavailable);
 * the submission is dropped from the task either way
 * @param deps the store, clock, logger and inbound port
 * @param task the bound submission task
 * @param caller the verified clinician
 * @returns the view
 */
export async function submitFor(
  deps: EngineDeps,
  task: TaskRow,
  caller: PersonRef,
): Promise<TaskJson> {
  const { submission, requestId } = task.metadata;
  const outcome =
    submission && deps.inbound
      ? await deps.inbound.submit({
          caller,
          patientId: task.patientId,
          requestId,
          submission,
        })
      : ({ kind: 'unavailable' } as const);
  const now = deps.clock();
  const next = submissionStatus(outcome, requestId, now);

  deps.logger.info({
    event: 'a2a.task.submitted',
    task: taskDigest(task.id),
    state: next.state,
    code: outcome.kind,
  });

  return view(
    deps.store.update(
      task.id,
      { status: next, metadata: { requestId, skill: 'submit-record' } },
      now,
    ),
  );
}

/**
 * ends an unbound share-code task signed into by someone other than the
 * owner of record: REJECTED, never bound, no invitation
 * @param deps the store, clock and logger
 * @param task the unbound share-code task
 * @returns the view
 */
export function refuseShare(deps: EngineDeps, task: TaskRow): TaskJson {
  const now = deps.clock();
  const next = status('TASK_STATE_REJECTED', textParts(TEXT.shareRefused), now);

  deps.logger.info({
    event: 'a2a.task.shared',
    task: taskDigest(task.id),
    state: next.state,
  });

  return view(deps.store.update(task.id, { status: next }, now));
}

/**
 * ends a bound task that cannot be resumed: FAILED, releasing nothing
 * @param deps the store, clock and logger
 * @param task the bound task
 * @returns the view
 */
export function interrupt(deps: EngineDeps, task: TaskRow): TaskJson {
  const now = deps.clock();
  const next = status('TASK_STATE_FAILED', textParts(TEXT.interrupted), now);

  deps.logger.warn({
    event: 'a2a.task.interrupted',
    task: taskDigest(task.id),
  });

  return view(
    deps.store.update(
      task.id,
      {
        status: next,
        metadata: {
          requestId: task.metadata.requestId,
          ...(task.metadata.skill ? { skill: task.metadata.skill } : {}),
        },
      },
      now,
    ),
  );
}

/**
 * shows a task past its expiry: its state, the expired text and no artifacts
 * @param deps the clock
 * @param task the lapsed task
 * @returns the view
 */
export function expired(deps: EngineDeps, task: TaskRow): TaskJson {
  return view(task, {
    state: expiredState(task.status.state),
    parts: textParts(TEXT.expired),
    timestamp: deps.clock().toISOString(),
  });
}

/**
 * fails an unbound task whose sign-in flow is gone (share codes were
 * configured when the task was created, not now)
 * @param deps the store and clock
 * @param task the unbound task
 * @returns the view
 */
export function signInLost(deps: EngineDeps, task: TaskRow): TaskJson {
  return view(
    deps.store.update(
      task.id,
      {
        status: status(
          'TASK_STATE_FAILED',
          textParts(TEXT.signInFailed),
          deps.clock(),
        ),
      },
      deps.clock(),
    ),
  );
}
