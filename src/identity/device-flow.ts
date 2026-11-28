/**
 * server-side RFC 8628 device flow for the in-task AUTH_REQUIRED sign-in
 * (D8); Medissy starts the device authorization with the task's context, the
 * clinician types the user code at the issuer and confirms the task details
 * shown there, and Medissy polls the token endpoint itself; sign-ins live in
 * `pending_signins` (migration 0007), keyed by task id, so a poll survives a
 * restart and the A2A engine keeps nothing in task metadata; the device code
 * and every token stay inside this module: callers see a user code, the
 * verification URI and, at the end, a verified `Principal`
 */
import { z } from 'zod';

import { SCOPE_REQUEST } from '../contracts';
import {
  SIGNIN_CONTEXT_PARAMS,
  signInContextSchema,
  taskDigest,
} from '../contracts/signin';

import { createSignInStore } from './signin-store';

import type { DatabaseSync } from 'node:sqlite';

import type { ClinicianEntry, Principal, TaskId } from '../contracts';
import type { TaskDigest } from '../contracts/signin';

import type { Fetch, IssuerConnection } from './issuer';
import type { SignInStore, StoredSignIn } from './signin-store';
import type { IssuedTokens, VerifyFailure, VerifyResult } from './verifier';

const MS_PER_SECOND = 1000;
const DEFAULT_INTERVAL_SECONDS = 5;
const SLOW_DOWN_STEP_SECONDS = 5;
const MAX_INTERVAL_SECONDS = 300;
const DEFAULT_MAX_PENDING = 1000;
const DEFAULT_TIMEOUT_MS = 10_000;
const HTTP_TOO_MANY_REQUESTS = 429;
const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/** what the A2A engine knows about the task needing a sign-in */
export interface SignInRequest {
  taskId: TaskId;
  /** the encounter as the clinician knows it, e.g. "Cardiology review, 3 Dec" */
  encounterLabel: string;
  /** one-line summary of the clinician's question */
  question: string;
}

/**
 * what a caller shows the person who must sign in; no secret is included and
 * there is deliberately no prefilled link: the clinician types the code
 */
export interface DeviceSignIn {
  userCode: string;
  verificationUri: string;
  /** also shown on the issuer's confirm page, for the clinician to compare */
  taskDigest: TaskDigest;
  expiresAt: Date;
  intervalSeconds: number;
}

/** outcome of one `poll`; every status except `pending` is final */
export type DevicePollResult =
  | { status: 'pending' }
  | {
      status: 'verified';
      principal: Principal;
      clinician: ClinicianEntry | null;
    }
  | { status: 'denied' }
  /** no sign-in is pending for the task (lapsed, finished or never started): start a new one */
  | { status: 'expired' }
  | { status: 'failed'; reason: VerifyFailure | 'idp-error' };

/** the device-flow helper used by the A2A task engine */
export interface DeviceFlow {
  /** starts a sign-in for a task, superseding any pending one */
  start(request: SignInRequest): Promise<DeviceSignIn>;
  /**
   * polls the task's pending sign-in once; throws `DeviceFlowError` when the
   * issuer is unreachable; the sign-in stays pending, so poll again later
   */
  poll(taskId: TaskId): Promise<DevicePollResult>;
}

/** options for `createDeviceFlow` */
export interface DeviceFlowOptions {
  /** the vault (opened through `openVault`) holding `pending_signins` */
  db: DatabaseSync;
  connection: IssuerConnection;
  /** resource indicator, i.e. Medissy's audience */
  audience: string;
  /**
   * verify the tokens the issuer returned; the composition picks it per
   * flow: a clinician flow verifies an institution sign-in (access and ID
   * token, ADR-9), the owner flow the patient's access token
   */
  verifySignIn: (tokens: IssuedTokens) => Promise<VerifyResult>;
  /** scope requested; the verification requires it on the token */
  scope?: string;
  fetch?: Fetch;
  now?: () => Date;
  /** cap on concurrent pending sign-ins */
  maxPending?: number;
  /** abort an issuer call after this many milliseconds */
  timeoutMs?: number;
}

/** longest device code accepted from the issuer */
const DEVICE_CODE_MAX = 512;
/** longest user code accepted from the issuer */
const USER_CODE_MAX = 64;

const authorizationSchema = z.object({
  device_code: z.string().min(1).max(DEVICE_CODE_MAX),
  user_code: z.string().min(1).max(USER_CODE_MAX),
  verification_uri: z.url(),
  expires_in: z.number().positive(),
  interval: z.number().int().positive().max(MAX_INTERVAL_SECONDS).optional(),
});

const tokenSchema = z.union([
  z.object({
    access_token: z.string().min(1),
    id_token: z.string().min(1).optional(),
  }),
  z.object({ error: z.string() }),
]);

/** raised when a sign-in cannot start or the issuer cannot be reached */
export class DeviceFlowError extends Error {
  /**
   * @param message what failed, without any secret
   * @param options standard error options carrying the cause
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DeviceFlowError';
  }
}

/** a form POST to the issuer */
type Post = (
  url: string,
  body: Record<string, string>,
) => Promise<{ status: number; ok: boolean; body: unknown }>;

/**
 * builds the issuer POST with a timeout; network failures and timeouts become
 * `DeviceFlowError`
 * @param fetch the HTTP client
 * @param timeoutMs how long a request may take before it fails
 * @returns the POST function
 */
function issuerPost(fetch: Fetch, timeoutMs: number): Post {
  return async (url, body) => {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'accept': 'application/json',
        },
        body: new URLSearchParams(body).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });

      return {
        status: response.status,
        ok: response.ok,
        body: await response.json().catch(() => undefined),
      };
    } catch (error) {
      throw new DeviceFlowError('the issuer could not be reached', {
        cause: error,
      });
    }
  };
}

/**
 * validates the request and computes the context shown at the issuer
 * @param request the task and its description
 * @returns the device-authorization parameters for the context
 */
function contextParams(request: SignInRequest): Record<string, string> {
  const parsed = signInContextSchema.safeParse({
    taskDigest: taskDigest(request.taskId),
    encounterLabel: request.encounterLabel,
    question: request.question,
  });

  if (!parsed.success) {
    throw new DeviceFlowError('the sign-in context is invalid', {
      cause: parsed.error,
    });
  }

  return {
    [SIGNIN_CONTEXT_PARAMS.taskDigest]: parsed.data.taskDigest,
    [SIGNIN_CONTEXT_PARAMS.encounterLabel]: parsed.data.encounterLabel,
    [SIGNIN_CONTEXT_PARAMS.question]: parsed.data.question,
  };
}

/** what `start` and `poll` share */
interface FlowDeps {
  store: SignInStore;
  post: Post;
  options: DeviceFlowOptions;
  scope: string;
}

/**
 * turns one token-endpoint answer into a poll result, updating the row
 * @param deps store, options and scope
 * @param row the pending sign-in
 * @param response the issuer's answer and when it arrived
 * @param response.status the HTTP status
 * @param response.body the parsed body
 * @param response.at the current time
 * @returns the poll result
 */
async function settle(
  deps: FlowDeps,
  row: StoredSignIn,
  response: { status: number; body: unknown; at: Date },
): Promise<DevicePollResult> {
  const { at } = response;
  const parsed = tokenSchema.safeParse(response.body);
  const error =
    response.status === HTTP_TOO_MANY_REQUESTS
      ? 'slow_down'
      : parsed.success && 'error' in parsed.data
        ? parsed.data.error
        : undefined;

  if (error === 'authorization_pending') {
    return { status: 'pending' };
  }

  if (error === 'slow_down') {
    deps.store.slowDown(
      row.id,
      Math.min(
        row.intervalSeconds + SLOW_DOWN_STEP_SECONDS,
        MAX_INTERVAL_SECONDS,
      ),
      at,
    );

    return { status: 'pending' };
  }

  if (error === 'access_denied' || error === 'expired_token') {
    const status = error === 'access_denied' ? 'denied' : 'expired';

    deps.store.finish(row.id, status, at);

    return { status };
  }

  if (!parsed.success || !('access_token' in parsed.data)) {
    deps.store.finish(row.id, 'failed', at);

    return { status: 'failed', reason: 'idp-error' };
  }

  // the tokens are verified and then dropped; never returned or stored
  const { access_token: accessToken, id_token: idToken } = parsed.data;
  const verified = await deps.options.verifySignIn({
    accessToken,
    ...(idToken ? { idToken } : {}),
  });

  deps.store.finish(row.id, verified.ok ? 'verified' : 'failed', at);

  return verified.ok
    ? {
        status: 'verified',
        principal: verified.principal,
        clinician: verified.clinician,
      }
    : { status: 'failed', reason: verified.reason };
}

/**
 * polls a task's pending sign-in once
 * @param deps store, HTTP, options and scope
 * @param taskId the task whose sign-in is polled
 * @param at the current time
 * @returns the poll result
 */
async function pollOnce(
  deps: FlowDeps,
  taskId: TaskId,
  at: Date,
): Promise<DevicePollResult> {
  const row = deps.store.findPending(taskId);

  if (!row) {
    return { status: 'expired' };
  }

  if (row.expiresAt <= at.toISOString()) {
    deps.store.finish(row.id, 'expired', at);

    return { status: 'expired' };
  }

  // never poll faster than the issuer asked, nor twice at once: one caller
  // per interval reaches the issuer, the rest are answered locally
  if (!deps.store.claimPoll(row.id, row.intervalSeconds, at)) {
    return { status: 'pending' };
  }

  const response = await deps.post(deps.options.connection.tokenEndpoint, {
    grant_type: DEVICE_CODE_GRANT,
    device_code: row.deviceCode,
    client_id: deps.options.connection.agentClientId,
    resource: deps.options.audience,
  });

  return settle(deps, row, { ...response, at });
}

/**
 * starts a device authorization for a task and records it
 * @param deps store, HTTP, options and scope
 * @param request the task and its description
 * @param at the current time
 * @returns what to show the clinician
 */
async function startOnce(
  deps: FlowDeps,
  request: SignInRequest,
  at: Date,
): Promise<DeviceSignIn> {
  const { options } = deps;
  const params = contextParams(request);

  if (deps.store.countLive(at) >= (options.maxPending ?? DEFAULT_MAX_PENDING)) {
    throw new DeviceFlowError('too many sign-ins in progress');
  }

  const response = await deps.post(
    options.connection.deviceAuthorizationEndpoint,
    {
      client_id: options.connection.agentClientId,
      scope: `openid ${deps.scope}`,
      resource: options.audience,
      ...params,
    },
  );
  const parsed = authorizationSchema.safeParse(response.body);

  if (!response.ok || !parsed.success) {
    throw new DeviceFlowError(
      `device authorization failed with HTTP ${response.status}`,
    );
  }

  const intervalSeconds = parsed.data.interval ?? DEFAULT_INTERVAL_SECONDS;
  const expiresAt = new Date(
    at.getTime() + parsed.data.expires_in * MS_PER_SECOND,
  );

  try {
    deps.store.replace({
      taskId: request.taskId,
      deviceCode: parsed.data.device_code,
      intervalSeconds,
      expiresAt,
      at,
    });
  } catch (error) {
    throw new DeviceFlowError('the sign-in could not be recorded', {
      cause: error,
    });
  }

  return {
    userCode: parsed.data.user_code,
    verificationUri: parsed.data.verification_uri,
    taskDigest: params[SIGNIN_CONTEXT_PARAMS.taskDigest] ?? '',
    expiresAt,
    intervalSeconds,
  };
}

/**
 * builds the device-flow helper
 * @param options vault, issuer connection, audience, sign-in verification, HTTP and clock
 * @returns the helper
 */
export function createDeviceFlow(options: DeviceFlowOptions): DeviceFlow {
  const now = options.now ?? (() => new Date());
  const deps: FlowDeps = {
    store: createSignInStore(options.db),
    post: issuerPost(
      options.fetch ?? globalThis.fetch,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ),
    options,
    scope: options.scope ?? SCOPE_REQUEST,
  };

  return {
    start: async (request) => startOnce(deps, request, now()),
    poll: async (taskId) => pollOnce(deps, taskId, now()),
  };
}
