/**
 * pure task-state rules of the A2A engine: which step a poll takes, what each
 * sign-in or disclosure outcome turns into, and the fixed texts a caller
 * sees; no I/O and no clock reads; the engine supplies `now`
 *
 * migration 0005 keeps the state column equal to `status.state`, lets an
 * unbound task be AUTH_REQUIRED, REJECTED or FAILED only, and freezes every
 * terminal state: A2A terminal states are immutable, so a released task
 * whose access ends stays COMPLETED and shows "access ended" with no
 * artifacts
 */
import { DISCLOSURE_MEDIA_TYPE, SUBMISSION_MEDIA_TYPE } from '../contracts';
import { renderDenial } from '../disclosure/result';

import type { TaskState } from '../contracts';
import type { DevicePollResult, DeviceSignIn } from '../identity/device-flow';
import type { SubmissionOutcome } from '../inbound/service';

import type { PortOutcome } from './disclosure-port';
import type { StoredPart, StoredStatus, TaskRow } from './task-store';

/** media type of the sign-in data part */
export const SIGNIN_MEDIA_TYPE = 'application/vnd.medissy.signin+json';

/** fixed texts; they quote nothing a caller sent */
export const TEXT = {
  starting: 'SYNTHETIC DEMO: starting clinician sign-in.',
  working: 'SYNTHETIC DEMO: signed in; checking access and selecting evidence.',
  released:
    'SYNTHETIC DEMO: evidence released for the signed-in clinician. The grant is re-checked on every poll.',
  signInDenied:
    'Sign-in was declined. Nothing was released. To try again, send a new request (a new messageId).',
  signInExpired:
    'Sign-in expired before it was approved. Nothing was released. To try again, send a new request (a new messageId).',
  signInFailed:
    'Sign-in could not be verified. Nothing was released. To try again, send a new request (a new messageId).',
  interrupted:
    'The request was interrupted before a decision. Nothing was released. Send a new request (a new messageId).',
  accessEnded:
    'Access ended: the grant for this request was revoked, expired or no longer covers it. No evidence is available from this task.',
  unavailable:
    'Evidence is temporarily unavailable. Nothing is shown; poll again shortly.',
  expired:
    'Access ended: this task has expired. No evidence is available from it; send a new request (a new messageId) if you still need it.',
  deniedRetry:
    'This request id stays denied; a retry needs a new request (a new messageId and requestId).',
  redeeming: 'SYNTHETIC DEMO: signed in; redeeming the share invitation.',
  redeemed:
    'SYNTHETIC DEMO: pending patient confirmation. The patient has been asked to confirm you; nothing is shared until they do. Afterwards, send a clinical-evidence-request.',
  redeemRefused:
    'This invitation is not available. Nothing was shared. Ask the patient for a new share link.',
  shared:
    'SYNTHETIC DEMO: share code created. It is shown in this response only and works once; nothing is shared until you confirm the clinician who redeems it in the owner portal.',
  shareRefused:
    'Only the patient who owns this Medissy can create a share code. No share code was created.',
  notFiled: 'SYNTHETIC DEMO: nothing was filed.',
  submitRefused: {
    'category-not-permitted':
      'The category is not covered by your active grant for this patient. Send it again without a category, or with one your grant covers.',
    'foreign-patient':
      'The record refers to another patient. Send a record about this patient only; Medissy sets the subject itself.',
    'invalid-record':
      'The record is not a valid FHIR R4 resource of a supported type for this patient.',
  },
} as const;

/** what a poll does next */
export type Step =
  /** past `expires_at`: no artifacts, ever */
  | { kind: 'expired' }
  /** unbound and waiting: poll the device sign-in */
  | { kind: 'await-sign-in' }
  /** bound but undecided (a crash or a concurrent poll): resume or wait */
  | { kind: 'resume' }
  /** released: re-check the grant before showing anything */
  | { kind: 'recheck' }
  /** rejected or failed: show the stored status */
  | { kind: 'final' };

/** terminal states: the task never changes again */
const TERMINAL: ReadonlySet<TaskState> = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
]);

/**
 * decides the next step of a poll
 * @param task the stored task
 * @param now the current time
 * @returns what the poll should do next
 */
export function nextStep(task: TaskRow, now: Date): Step {
  if (now.getTime() >= Date.parse(task.expiresAt)) {
    return { kind: 'expired' };
  }

  switch (task.status.state) {
    case 'TASK_STATE_AUTH_REQUIRED':
      return task.caller ? { kind: 'resume' } : { kind: 'await-sign-in' };
    case 'TASK_STATE_WORKING':
      return task.caller ? { kind: 'resume' } : { kind: 'final' };
    case 'TASK_STATE_COMPLETED':
      // a redemption or share code released nothing: nothing to re-check
      return task.caller && !task.metadata.skill
        ? { kind: 'recheck' }
        : { kind: 'final' };
    default:
      return { kind: 'final' };
  }
}

/**
 * returns the state an expired task is shown in: a task that never finished is
 * shown failed; a finished one keeps its terminal state
 * @param state the effective state
 * @returns the state to show
 */
export function expiredState(state: TaskState): TaskState {
  return TERMINAL.has(state) ? state : 'TASK_STATE_FAILED';
}

/**
 * builds a status from parts
 * @param state the task state to record
 * @param parts the status message parts
 * @param now the time of the change
 * @returns the stored status
 */
export function status(
  state: TaskState,
  parts: StoredPart[],
  now: Date,
): StoredStatus {
  return { state, parts, timestamp: now.toISOString() };
}

/**
 * builds a single text part
 * @param text the sentence to show to the client
 * @returns the part
 */
export function textParts(text: string): StoredPart[] {
  return [{ text }];
}

/**
 * builds the AUTH_REQUIRED message: what the clinician must do, plus the same facts
 * as data; never the device code, a token or a prefilled sign-in link
 * @param signIn the started sign-in
 * @returns the text and data parts
 */
export function signInParts(signIn: DeviceSignIn): StoredPart[] {
  const expiresAt = signIn.expiresAt.toISOString();

  return [
    {
      text: [
        'SYNTHETIC DEMO: clinician sign-in required.',
        `Open ${signIn.verificationUri} and enter code ${signIn.userCode} before ${expiresAt}.`,
        `Check that the sign-in page shows request reference ${signIn.taskDigest}, then approve.`,
        'Poll this task afterwards; evidence is decided for the clinician who signs in.',
      ].join('\n'),
    },
    {
      data: {
        verificationUri: signIn.verificationUri,
        userCode: signIn.userCode,
        expiresAt,
        taskDigest: signIn.taskDigest,
      },
      mediaType: SIGNIN_MEDIA_TYPE,
    },
  ];
}

/** a sign-in that ended without a verified clinician */
export type UnverifiedPoll = Exclude<DevicePollResult, { status: 'verified' }>;

/**
 * returns the status an unverified sign-in poll moves an unbound task to
 * @param result the poll result
 * @param now the time of the poll
 * @returns the new status, or undefined while still pending
 */
export function signInOutcome(
  result: UnverifiedPoll,
  now: Date,
): StoredStatus | undefined {
  switch (result.status) {
    case 'pending':
      return undefined;
    case 'denied':
      return status('TASK_STATE_REJECTED', textParts(TEXT.signInDenied), now);
    case 'expired':
      return status('TASK_STATE_FAILED', textParts(TEXT.signInExpired), now);
    default:
      return status('TASK_STATE_FAILED', textParts(TEXT.signInFailed), now);
  }
}

/**
 * builds the denial parts shown in a status message: text plus the denial data
 * @param outcome the denial to describe
 * @param lead the first line
 * @returns a text part followed by the denial data part
 */
export function denialParts(
  outcome: Extract<PortOutcome, { kind: 'denied' }>,
  lead: string,
): StoredPart[] {
  const { denial } = outcome;
  const retry =
    denial.code === 'temporarily-unavailable' ? [] : [TEXT.deniedRetry];

  return [
    {
      text: [
        lead,
        denial.message,
        ...(denial.nextStep ? [denial.nextStep] : []),
        ...retry,
      ].join('\n'),
    },
    { data: denial, mediaType: DISCLOSURE_MEDIA_TYPE },
  ];
}

/**
 * returns the status a first disclosure decision moves a bound task to
 * @param outcome the pipeline outcome
 * @param now the time of the decision
 * @returns the new status
 */
export function decisionStatus(outcome: PortOutcome, now: Date): StoredStatus {
  if (outcome.kind === 'released') {
    return status('TASK_STATE_COMPLETED', textParts(TEXT.released), now);
  }

  const state =
    outcome.denial.code === 'temporarily-unavailable'
      ? 'TASK_STATE_FAILED'
      : 'TASK_STATE_REJECTED';

  return status(
    state,
    denialParts(outcome, 'SYNTHETIC DEMO: nothing was released.'),
    now,
  );
}

/**
 * returns the text of a filed submission: what was filed, where, and the receipt;
 * every value is Medissy's own (ids, a generated name, closed-set labels)
 * @param result the filed submission
 * @returns one text line
 */
function filedText(
  result: Extract<SubmissionOutcome, { kind: 'filed' }>['result'],
): string {
  return [
    `SYNTHETIC DEMO: filed ${result.resourceType} (${result.category}) to the patient's secure store as ${result.filedName}; receipt ${result.submissionId}.`,
    "It is in the patient's records now, marked as received from you; the patient can remove it.",
  ].join('\n');
}

/**
 * returns the status a record submission moves a bound task to; a missing grant is
 * the same uniform denial a clinical request gets; the other refusals name
 * the clinician's own input only
 * @param outcome what the inbound port decided
 * @param requestId the task's own request id
 * @param now the time of the decision
 * @returns the new status
 */
export function submissionStatus(
  outcome: SubmissionOutcome,
  requestId: string,
  now: Date,
): StoredStatus {
  switch (outcome.kind) {
    case 'filed':
      return status(
        'TASK_STATE_COMPLETED',
        [
          { text: filedText(outcome.result) },
          { data: outcome.result, mediaType: SUBMISSION_MEDIA_TYPE },
        ],
        now,
      );
    case 'denied':
      return decisionStatus(
        { kind: 'denied', denial: renderDenial(requestId, 'not-permitted') },
        now,
      );
    case 'refused':
      return status(
        'TASK_STATE_REJECTED',
        denialParts(
          {
            kind: 'denied',
            denial: renderDenial(requestId, 'invalid-request'),
          },
          `${TEXT.notFiled} ${TEXT.submitRefused[outcome.reason]}`,
        ),
        now,
      );
    default:
      return status(
        'TASK_STATE_FAILED',
        denialParts(
          {
            kind: 'denied',
            denial: renderDenial(requestId, 'temporarily-unavailable'),
          },
          TEXT.notFiled,
        ),
        now,
      );
  }
}

/** what a re-check of a released task shows */
export type Recheck =
  /** still allowed: serve freshly rendered artifacts */
  | { kind: 'serve' }
  /** a transient failure: no artifacts this time, nothing persisted */
  | { kind: 'unavailable'; parts: StoredPart[] }
  /** revoked or out of scope: no artifacts, and the task ends now */
  | { kind: 'ended'; parts: StoredPart[] };

/**
 * classifies the re-check of a released task
 * @param outcome the re-disclosure outcome
 * @returns what to show
 */
export function recheckOutcome(outcome: PortOutcome): Recheck {
  if (outcome.kind === 'released') {
    return { kind: 'serve' };
  }

  return outcome.denial.code === 'temporarily-unavailable'
    ? { kind: 'unavailable', parts: textParts(TEXT.unavailable) }
    : { kind: 'ended', parts: denialParts(outcome, TEXT.accessEnded) };
}

/**
 * returns the earlier of two ISO instants
 * @param left an ISO instant
 * @param right an ISO instant
 * @returns the earlier one
 */
export function earliest(left: string, right: string): string {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}
