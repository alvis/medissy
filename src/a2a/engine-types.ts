/**
 * what the A2A task engine is built from and what it promises: its ids and
 * limits, the refusal it throws, the log entries it writes, the dependencies
 * it is bound to and the engine interface itself
 */
import type { ClinicalRequest, SubmitRecordInput } from '../contracts';
import type { DeviceFlow } from '../identity/device-flow';
import type { InboundPort } from '../inbound/service';
import type { Clock } from '../policy/engine';
import type { PartLinks } from '../widgets';

import type { DisclosurePort } from './disclosure-port';
import type { InvitationPort, ShareCodePort } from './share-port';
import type { TaskStore } from './task-store';
import type { TaskJson } from './view';

/** the share-code artifact id (unique within a task) */
export const SHARE_ARTIFACT_ID = 'medissy-share-code';

/** default task lifetime: the sign-in plus the release must fit in it */
export const DEFAULT_TASK_TTL_MS = 3_600_000;
/**
 * polls of one task within this window get the previous answer, but only an
 * answer without evidence; a released task is re-checked on every poll
 */
export const DEFAULT_POLL_THROTTLE_MS = 5_000;
/** unbound sign-ins one client may hold at once */
export const DEFAULT_MAX_PENDING_PER_CLIENT = 5;
/**
 * unbound sign-ins one IPv6 /48 may hold at once, across its /64 clients;
 * residual: the device flow's global cap (1000) can still be filled from
 * about 50 /48s, or 200 IPv4 addresses; a determined, well-provisioned
 * attacker can delay new sign-ins until their tasks expire (1 h)
 */
export const DEFAULT_MAX_PENDING_PER_NETWORK = 20;
/** the evidence artifact id (unique within a task) */
export const EVIDENCE_ARTIFACT_ID = 'medissy-evidence';

/** why the engine refused a call; mapped to fixed A2A errors */
export type EngineErrorCode =
  'not-found' | 'collision' | 'unavailable' | 'busy';

/** a refused engine call; its message is fixed and quotes nothing */
export class EngineError extends Error {
  public readonly code: EngineErrorCode;

  /**
   * @param code the refusal
   * @param options standard error options carrying the cause
   */
  constructor(code: EngineErrorCode, options?: ErrorOptions) {
    super(`a2a engine: ${code}`, options);
    this.name = 'EngineError';
    this.code = code;
  }
}

/** one content-free engine log entry */
export interface EngineLogEntry {
  event:
    | 'a2a.task.created'
    | 'a2a.task.signin-unavailable'
    | 'a2a.task.signin-ended'
    | 'a2a.task.bound'
    | 'a2a.task.decided'
    | 'a2a.task.redeemed'
    | 'a2a.task.shared'
    | 'a2a.task.submitted'
    | 'a2a.task.rechecked'
    | 'a2a.task.access-ended'
    | 'a2a.task.interrupted'
    | 'a2a.task.collision'
    | 'a2a.task.busy'
    | 'a2a.task.purged';
  /** short digest of the task id, never the id */
  task?: string;
  state?: string;
  code?: string;
  /** a count (purged tasks) */
  count?: number;
  /** error class name only */
  error?: string;
}

/** where the engine logs; a pino logger satisfies it */
export interface EngineLogger {
  info(entry: EngineLogEntry): void;
  warn(entry: EngineLogEntry): void;
}

/** what the engine is bound to */
export interface EngineDeps {
  store: TaskStore;
  deviceFlow: Pick<DeviceFlow, 'start' | 'poll'>;
  disclosure: DisclosurePort;
  /**
   * Box file ids whose every record is in the allowed set; return none when
   * no file reader is configured (no download links are advertised then)
   */
  sourceFiles: (patientId: string, recordIds: ReadonlySet<string>) => string[];
  /** the vault's one patient, or undefined before onboarding */
  readPatientId: () => string | undefined;
  clock: Clock;
  logger: EngineLogger;
  links: PartLinks;
  taskTtlMs?: number;
  /** serve a cached evidence-free answer within this window (0 disables) */
  pollThrottleMs?: number;
  /** unbound sign-ins one client may hold at once */
  maxPendingPerClient?: number;
  /** unbound sign-ins one IPv6 /48 may hold at once */
  maxPendingPerNetwork?: number;
  /** invitation redemption; without it the skill is unavailable */
  invitations?: InvitationPort;
  /**
   * the owner-scoped sign-in for share codes; without it (or `shares`) the skill
   * is unavailable
   */
  ownerDeviceFlow?: Pick<DeviceFlow, 'start' | 'poll'>;
  /** share-code issuance for the verified owner */
  shares?: ShareCodePort;
  /** record submission (ADR-10); without it the skill is unavailable */
  inbound?: InboundPort;
}

/** create, poll and cancel A2A tasks behind the verified-identity gate */
export interface TaskEngine {
  /**
   * creates an AUTH_REQUIRED task for a clinical request and starts sign-in
   * @throws {EngineError} `collision` on a reused messageId (from any
   *   client), `busy` when the client holds too many unbound sign-ins,
   *   `unavailable` when the vault has no patient or sign-in cannot start
   */
  create(input: {
    messageId: string;
    contextId?: string;
    request: ClinicalRequest;
    /** the calling client's key (its IP) for the per-client sign-in cap */
    client?: string;
  }): Promise<TaskJson>;
  /**
   * creates an AUTH_REQUIRED task that redeems an invitation for the
   * clinician who signs in; only the token's hash is stored
   * @throws {EngineError} as `create`, and `unavailable` when redemption is
   *   not configured
   */
  redeem(input: {
    messageId: string;
    contextId?: string;
    tokenHash: string;
    client?: string;
  }): Promise<TaskJson>;
  /**
   * creates an AUTH_REQUIRED task that files a record the clinician who signs
   * in hands back, when they hold an active grant (ADR-10); nothing is filed
   * before sign-in; the submission is held only until the task is decided
   * @throws {EngineError} as `create`, and `unavailable` when no secure
   *   store is configured
   */
  submit(input: {
    messageId: string;
    contextId?: string;
    submission: SubmitRecordInput;
    client?: string;
  }): Promise<TaskJson>;
  /**
   * polls a task: advances it and returns what its holder may see now
   * @throws {EngineError} `not-found` for an unknown or malformed id
   */
  get(taskId: string): Promise<TaskJson>;
  /**
   * creates an AUTH_REQUIRED task that issues a share code to the patient
   * owner who signs in (`medissy:owner`)
   * @throws {EngineError} as `create`, and `unavailable` when share codes
   *   are not configured
   */
  share(input: {
    messageId: string;
    contextId?: string;
    client?: string;
  }): Promise<TaskJson>;
  /**
   * returns the records a task may serve right now: only a bound, completed,
   * unexpired task whose grant passes a fresh re-check
   * @returns the patient and released record ids, or undefined
   */
  released(
    taskId: string,
  ): Promise<{ patientId: string; recordIds: ReadonlySet<string> } | undefined>;
}
