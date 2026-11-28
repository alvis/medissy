/**
 * thin SDK adapter: an `A2ARequestHandler` over the task engine; it replaces
 * the SDK's DefaultRequestHandler because that handler mints task ids with
 * `randomUUID` (not `newTaskId`), serves GetTask straight from the store
 * (no re-check), and lists every task to every caller; only SendMessage and
 * GetTask are served; everything else is refused with a fixed error
 *
 * every error leaving this module is an A2A error with a fixed message; the
 * SDK would otherwise copy a plain error's message into the response
 *
 * a creating messageId is unique across all clients (D10 gives clients no
 * identity): reusing one, even one another client sent, returns an error and
 * never the existing task or its receipt
 */
import { Message, Task } from '@a2a-js/sdk';
import {
  A2AError,
  ExtendedAgentCardNotConfiguredError,
  JsonRpcTransportError,
  PushNotificationNotSupportedError,
  RequestMalformedError,
  TaskNotFoundError,
  UnsupportedOperationError,
} from '@a2a-js/sdk/errors';

import { EngineError } from './engine';
import { parseIntent, REQUEST_HELP } from './intent';

import type { AgentCard, SendMessageRequest } from '@a2a-js/sdk';
import type { A2ARequestHandler, ServerCallContext } from '@a2a-js/sdk/server';

import type { TaskEngine } from './engine';
import type { IncomingMessage, IncomingPart } from './intent';

/** fixed refusal texts */
export const ERRORS = {
  collision:
    'A task already exists for this messageId. Send a new message with a new messageId, or poll the task you were given.',
  notFound: 'Task not found.',
  unavailable: 'Medissy cannot take requests right now. Try again later.',
  busy: 'Too many sign-ins are waiting for this client. Complete one or let it lapse, then send a new request.',
  extendedCard: 'Medissy has no extended agent card.',
  internal: 'Internal error.',
  unsupported: 'Only SendMessage and GetTask are supported.',
  contextMismatch: 'Task not found.',
} as const;

/**
 * the JSON-RPC code for `busy` (too many waiting sign-ins for this client):
 * server-defined, outside A2A's own -32001..-32009, and not -32603 (internal)
 */
export const BUSY_ERROR_CODE = -32000;

/** what the handler is bound to */
export interface HandlerDeps {
  engine: TaskEngine;
  card: AgentCard;
}

/**
 * maps any failure to an A2A error with a fixed message
 * @param error the failure
 * @returns the error to throw
 */
export function safeError(error: unknown): A2AError {
  if (error instanceof EngineError) {
    const byCode: Record<EngineError['code'], () => A2AError> = {
      'not-found': () => new TaskNotFoundError(ERRORS.notFound),
      'collision': () => new RequestMalformedError(ERRORS.collision),
      'unavailable': () => new A2AError(ERRORS.unavailable),
      'busy': () =>
        new JsonRpcTransportError({
          jsonrpc: '2.0',
          id: null,
          error: { code: BUSY_ERROR_CODE, message: ERRORS.busy },
        }),
    };

    return byCode[error.code]();
  }

  return error instanceof A2AError ? error : new A2AError(ERRORS.internal);
}

/** `ServerCallContext.state` key carrying the client key (its IP) */
export const CLIENT_KEY_STATE = 'medissy.client';

/**
 * returns the client key the transport recorded for a call
 * @param context the call context
 * @returns the key, or undefined
 */
function clientOf(context: ServerCallContext | undefined): string | undefined {
  const value = context?.state.get(CLIENT_KEY_STATE);

  return typeof value === 'string' ? value : undefined;
}

/**
 * converts an SDK message to the engine's JSON form
 * @param message the decoded message
 * @returns the incoming message
 */
function incoming(message: Message): IncomingMessage {
  const json = Message.toJSON(message) as {
    messageId?: string;
    contextId?: string;
    taskId?: string;
    parts?: IncomingPart[];
  };

  return {
    messageId: json.messageId ?? '',
    contextId: json.contextId === '' ? undefined : json.contextId,
    taskId: json.taskId === '' ? undefined : json.taskId,
    parts: json.parts ?? [],
  };
}

/**
 * wraps an async body so it only ever rejects with a safe A2A error
 * @param body the work
 * @returns the result
 */
async function guarded<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    throw safeError(error);
  }
}

/**
 * refuses an unsupported operation
 * @returns never
 */
async function unsupported(): Promise<never> {
  throw new UnsupportedOperationError(ERRORS.unsupported);
}

/** refuses a streaming operation */
// eslint-disable-next-line require-yield, sonarjs/generator-without-yield -- refuses before yielding
async function* noStream(): AsyncGenerator<never, void, undefined> {
  throw new UnsupportedOperationError(ERRORS.unsupported);
}

/**
 * handles a SendMessage: polls a task, or opens one for the requested skill
 * @param engine the task engine
 * @param params the decoded request
 * @param context the call context carrying the client address
 * @returns the task, awaiting sign-in or as it now stands
 */
async function sendMessage(
  engine: TaskEngine,
  params: SendMessageRequest,
  context: ServerCallContext | undefined,
): Promise<Task> {
  if (!params.message) {
    throw new RequestMalformedError(REQUEST_HELP);
  }

  const message = incoming(params.message);

  if (message.taskId) {
    // a follow-up on an existing task is a poll; its id is the capability
    const task = await engine.get(message.taskId);

    if (message.contextId && message.contextId !== task.contextId) {
      throw new TaskNotFoundError(ERRORS.contextMismatch);
    }

    return Task.fromJSON(task);
  }

  const intent = parseIntent(message);

  if (intent.kind === 'invalid') {
    throw new RequestMalformedError(REQUEST_HELP);
  }

  if (intent.kind === 'share-code') {
    // only the patient owner of record who signs in gets the code
    return Task.fromJSON(
      await engine.share({
        messageId: message.messageId,
        contextId: message.contextId,
        client: clientOf(context),
      }),
    );
  }

  if (intent.kind === 'submit-record') {
    // filed only for a verified clinician with an active grant, after sign-in
    return Task.fromJSON(
      await engine.submit({
        messageId: message.messageId,
        contextId: message.contextId,
        submission: intent.submission,
        client: clientOf(context),
      }),
    );
  }

  if (intent.kind === 'redeem-invitation') {
    return Task.fromJSON(
      await engine.redeem({
        messageId: message.messageId,
        contextId: message.contextId,
        tokenHash: intent.tokenHash,
        client: clientOf(context),
      }),
    );
  }

  return Task.fromJSON(
    await engine.create({
      messageId: message.messageId,
      contextId: message.contextId,
      request: intent.request,
      client: clientOf(context),
    }),
  );
}

/**
 * builds the request handler
 * @param deps the engine and the card
 * @returns the request handler that serves the engine
 */
export function createRequestHandler(deps: HandlerDeps): A2ARequestHandler {
  const { engine } = deps;

  return {
    getAgentCard: async () => deps.card,
    getAuthenticatedExtendedAgentCard: async () => {
      throw new ExtendedAgentCardNotConfiguredError(ERRORS.extendedCard);
    },
    sendMessage: async (params, context) =>
      guarded(async () => sendMessage(engine, params, context)),
    sendMessageStream: noStream,
    getTask: async (params) =>
      guarded(async () => Task.fromJSON(await engine.get(params.id))),
    cancelTask: unsupported,
    createTaskPushNotificationConfig: async () => {
      throw new PushNotificationNotSupportedError();
    },
    getTaskPushNotificationConfig: async () => {
      throw new PushNotificationNotSupportedError();
    },
    listTaskPushNotificationConfigs: async () => {
      throw new PushNotificationNotSupportedError();
    },
    deleteTaskPushNotificationConfig: async () => {
      throw new PushNotificationNotSupportedError();
    },
    resubscribe: noStream,
    listTasks: unsupported,
  };
}
