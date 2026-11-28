/**
 * opening a task: what each skill asks the engine to store, and the storing
 * of an AUTH_REQUIRED task with its device sign-in
 */
import { randomUUID } from 'node:crypto';

import { idSchema, newTaskId } from '../contracts';
import { taskDigest } from '../contracts/signin';
import { oneLine } from '../widgets';

import { EngineError } from './engine-types';
import { view } from './engine-view';
import { MessageIdCollisionError } from './task-store';
import { signInParts, status, TEXT, textParts } from './transitions';

import type { ClinicalRequest, SubmitRecordInput, TaskId } from '../contracts';
import type { DeviceFlow } from '../identity/device-flow';

import type { KeyedLock, SignInLimits } from './engine-limits';
import type { EngineDeps } from './engine-types';
import type { TaskMetadata } from './task-store';
import type { TaskJson } from './view';

const ENCOUNTER_LABEL_MAX = 80;
const QUESTION_LINE_MAX = 200;
/** longest record title the sign-in page previews for a hand-back */
const PREVIEW_TITLE_MAX = 60;
/** FHIR fields read, in order, for a submitted record's preview title */
const PREVIEW_TITLE_FIELDS = [
  'code',
  'medicationCodeableConcept',
  'type',
] as const;

/** what the engine needs to open tasks */
export interface OpenContext {
  deps: EngineDeps;
  limits: SignInLimits;
  lock: KeyedLock;
  ttl: number;
}

/** the message that creates a task */
export interface OpenInput {
  messageId: string;
  contextId?: string;
  client?: string;
}

/** what one skill asks the engine to store and sign in */
export interface OpenRequest {
  input: OpenInput;
  metadata: TaskMetadata;
  /** what the sign-in page shows about the task */
  signIn: { encounterLabel: string; question: string };
  /** the device flow that starts the sign-in (default: the clinician one) */
  flow?: Pick<DeviceFlow, 'start' | 'poll'>;
}

/**
 * builds the request for a clinical evidence task
 * @param request the clinician's request
 * @param input the creating message and the client key
 * @returns what to open
 */
export function clinicalOpen(
  request: ClinicalRequest,
  input: OpenInput,
): OpenRequest {
  return {
    input,
    metadata: {
      // one request id per task (never the caller's, never the task id)
      requestId: `req-${randomUUID()}`,
      pending: {
        encounterId: request.encounterId,
        question: request.question,
        requestedCategories: request.requestedCategories,
      },
    },
    signIn: {
      encounterLabel: oneLine(
        `Encounter ${request.encounterId}`,
        ENCOUNTER_LABEL_MAX,
      ),
      question:
        oneLine(request.question, QUESTION_LINE_MAX) ||
        'Clinical evidence request',
    },
  };
}

/**
 * builds the request for an invitation redemption task
 * @param tokenHash the hash of the invitation token
 * @param input the creating message and the client key
 * @returns what to open
 */
export function redeemOpen(tokenHash: string, input: OpenInput): OpenRequest {
  return {
    input,
    metadata: {
      requestId: `req-${randomUUID()}`,
      skill: 'redeem-invitation',
      invitation: { tokenHash },
    },
    signIn: {
      encounterLabel: 'Connect to this patient',
      question:
        "Redeem the patient's share invitation (nothing is shared until the patient confirms)",
    },
  };
}

/**
 * returns the title a submission gives itself: the document title, a record's
 * `description`, or the text of its first coded field; caller-sent, so the
 * sign-in page shows it as unverified
 * @param submission the validated submission
 * @returns the title, or undefined when the submission names none
 */
function submissionTitle(submission: SubmitRecordInput): string | undefined {
  const { document, record } = submission;

  if (document) {
    return document.title;
  }

  const fields = record as Record<string, unknown> | undefined;
  const coded = PREVIEW_TITLE_FIELDS.map((field) => fields?.[field]).find(
    (value): value is { text: string } =>
      typeof (value as { text?: unknown } | undefined)?.text === 'string',
  );
  const description = fields?.description;

  return typeof description === 'string' ? description : coded?.text;
}

/**
 * builds the request for a record-submission task; the sign-in page previews what
 * the calling agent sent, its kind and its own title, so the approving
 * clinician sees what will be filed under their name (ADR-10); the page
 * labels it unverified and escapes it
 * @param submission the validated submission
 * @param input the creating message and the client key
 * @returns what to open
 */
export function submitOpen(
  submission: SubmitRecordInput,
  input: OpenInput,
): OpenRequest {
  const kind = submission.record?.resourceType ?? 'document';
  const title = oneLine(submissionTitle(submission) ?? '', PREVIEW_TITLE_MAX);
  const named = title ? ` "${title}"` : ' with no title';

  return {
    input,
    metadata: {
      requestId: `req-${randomUUID()}`,
      skill: 'submit-record',
      submission,
    },
    signIn: {
      encounterLabel: 'Hand a record back to this patient',
      question: oneLine(
        `File one ${kind}${named} into the patient's records under your name (active grant only; the patient can remove it)`,
        QUESTION_LINE_MAX,
      ),
    },
  };
}

/**
 * builds the request for a share-code task
 * @param input the creating message and the client key
 * @param flow the owner-scoped device flow
 * @returns what to open
 */
export function shareOpen(
  input: OpenInput,
  flow: Pick<DeviceFlow, 'start' | 'poll'>,
): OpenRequest {
  return {
    input,
    metadata: { requestId: `req-${randomUUID()}`, skill: 'share-code' },
    signIn: {
      encounterLabel: 'Your Medissy share code',
      question:
        'Create a single-use share code (QR) a clinician can use to ask you for a connection',
    },
    flow,
  };
}

/**
 * purges unbound tasks past their expiry, with their device codes
 * @param deps the store and logger
 * @param now the current time
 */
function purgeAbandoned(deps: EngineDeps, now: Date): void {
  const count = deps.store.purgeAbandoned(now);

  if (count > 0) {
    deps.logger.info({ event: 'a2a.task.purged', count });
  }
}

/**
 * stores a new AUTH_REQUIRED task, giving its slot back if that fails
 * @param ctx the store, limits and lifetime
 * @param created the new task's ids and creation time
 * @param created.id the new task id
 * @param created.patientId the vault's patient
 * @param created.now the creation time
 * @param request what the skill asked to store
 * @throws {EngineError} `collision` on a reused messageId
 */
function storeNew(
  ctx: OpenContext,
  created: { id: TaskId; patientId: string; now: Date },
  request: OpenRequest,
): void {
  const { deps, limits, ttl } = ctx;
  const { id, patientId, now } = created;
  const { messageId, contextId, client = '' } = request.input;
  const context =
    contextId && idSchema.safeParse(contextId).success
      ? contextId
      : randomUUID();

  try {
    deps.store.create({
      id,
      contextId: context,
      patientId,
      originMessageId: messageId,
      status: status('TASK_STATE_AUTH_REQUIRED', textParts(TEXT.starting), now),
      metadata: request.metadata,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttl).toISOString(),
    });
  } catch (error) {
    limits.release(client, id);

    if (error instanceof MessageIdCollisionError) {
      deps.logger.warn({ event: 'a2a.task.collision' });
      throw new EngineError('collision', { cause: error });
    }

    throw error;
  }
}

/**
 * starts a stored task's device sign-in and shows its sign-in parts
 * @param ctx the store, limits and device flows
 * @param id the stored task
 * @param request what the skill asked to store
 * @returns the view
 * @throws {EngineError} `unavailable` when the sign-in cannot start
 */
async function startSignIn(
  ctx: OpenContext,
  id: TaskId,
  request: OpenRequest,
): Promise<TaskJson> {
  const { deps, limits } = ctx;
  const { client = '' } = request.input;
  const flow = request.flow ?? deps.deviceFlow;
  let started: Awaited<ReturnType<typeof flow.start>>;

  try {
    started = await flow.start({ taskId: id, ...request.signIn });
  } catch (error) {
    limits.release(client, id);
    deps.store.remove(id);
    deps.logger.warn({
      event: 'a2a.task.signin-unavailable',
      task: taskDigest(id),
      error: error instanceof Error ? error.name : 'unknown',
    });
    throw new EngineError('unavailable', { cause: error });
  }

  const at = deps.clock();

  limits.hold(client, id, started.expiresAt.getTime());

  const task = deps.store.update(
    id,
    { status: status('TASK_STATE_AUTH_REQUIRED', signInParts(started), at) },
    at,
  );

  deps.logger.info({
    event: 'a2a.task.created',
    task: taskDigest(id),
    state: task.state,
  });

  return view(task);
}

/**
 * stores an AUTH_REQUIRED task and starts its device sign-in
 * @param ctx the store, limits, lock and lifetime
 * @param request what the skill asked to store
 * @returns the task view
 * @throws {EngineError} `unavailable`, `busy` or `collision`
 */
export async function openTask(
  ctx: OpenContext,
  request: OpenRequest,
): Promise<TaskJson> {
  const { deps } = ctx;
  const { client = '' } = request.input;
  const patientId = deps.readPatientId();

  if (!patientId) {
    throw new EngineError('unavailable');
  }

  const now = deps.clock();
  const id: TaskId = newTaskId();

  purgeAbandoned(deps, now);
  ctx.limits.reserve(client, id, now.getTime());
  storeNew(ctx, { id, patientId, now }, request);

  return ctx.lock(id, async () => startSignIn(ctx, id, request));
}
