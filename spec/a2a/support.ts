import { vi } from 'vitest';

import { createPipelinePort } from '../../src/a2a/disclosure-port';
import { createTaskEngine } from '../../src/a2a/engine';
import { createTaskStore } from '../../src/a2a/task-store';
import { filesFullyWithin } from '../../src/box/catalog';
import { taskDigest } from '../../src/contracts/signin';
import { harness } from '../disclosure/support';
import { PATIENT } from '../policy/support';

import type { Mock } from 'vitest';

import type { DisclosurePort } from '../../src/a2a/disclosure-port';
import type { EngineLogEntry, TaskEngine } from '../../src/a2a/engine';
import type { TaskStore } from '../../src/a2a/task-store';
import type {
  DevicePollResult,
  DeviceSignIn,
  SignInRequest,
} from '../../src/identity/device-flow';
import type { Harness } from '../disclosure/support';

export const LINKS = {
  portalUrl: 'http://medissy.test/',
  downloadTemplate: 'http://medissy.test/a2a/v1/tasks/{taskId}/files/{fileId}',
};

/** a device flow the test drives by hand */
export interface FakeDeviceFlow {
  start: Mock<(request: SignInRequest) => Promise<DeviceSignIn>>;
  poll: Mock<(taskId: string) => Promise<DevicePollResult>>;
  /** sets what the next polls of a task return */
  answer(taskId: string, result: DevicePollResult): void;
  /** requests passed to `start` */
  started: Array<{ taskId: string; encounterLabel: string; question: string }>;
}

/**
 * builds a fake device flow: every sign-in stays pending until `answer`
 * @param now the clock
 * @returns a device flow whose answers the test controls
 */
export function fakeDeviceFlow(now: () => Date): FakeDeviceFlow {
  const answers = new Map<string, DevicePollResult>();
  const started: FakeDeviceFlow['started'] = [];

  return {
    started,
    answer: (taskId, result) => {
      answers.set(taskId, result);
    },
    start: vi.fn(async (request: SignInRequest): Promise<DeviceSignIn> => {
      started.push(request);

      return {
        userCode: 'WDJB-MJHT',
        verificationUri: 'http://medissy.test/demo-idp/device',
        taskDigest: taskDigest(request.taskId),
        expiresAt: new Date(now().getTime() + 600_000),
        intervalSeconds: 5,
      };
    }),
    poll: vi.fn(async (taskId: string): Promise<DevicePollResult> => {
      const result = answers.get(taskId) ?? { status: 'pending' };

      // a verified result is handed out once, as the real flow does
      if (result.status === 'verified') {
        answers.set(taskId, { status: 'expired' });
      }

      return result;
    }),
  };
}

/** an engine over the seeded pipeline vault with a fake sign-in */
export interface EngineRig {
  h: Harness;
  engine: TaskEngine;
  store: TaskStore;
  flow: FakeDeviceFlow;
  port: DisclosurePort;
  logs: EngineLogEntry[];
  setNow: (iso: string) => void;
}

/**
 * builds the rig
 * @param options engine overrides
 * @param options.pollThrottleMs the poll throttle (0 by default here)
 * @param options.port replace the pipeline port
 * @returns the engine with its fake device flow, port and clock
 */
export function engineRig(
  options: {
    pollThrottleMs?: number;
    port?: (real: DisclosurePort) => DisclosurePort;
  } = {},
): EngineRig {
  const h = harness(undefined);
  const clock = h.deps.clock;
  const flow = fakeDeviceFlow(clock);
  const real = createPipelinePort(h.deps);
  const port = options.port ? options.port(real) : real;
  const store = createTaskStore(h.db);
  const logs: EngineLogEntry[] = [];
  const log = (entry: EngineLogEntry): void => {
    logs.push(entry);
  };
  const engine = createTaskEngine({
    store,
    deviceFlow: flow,
    disclosure: port,
    sourceFiles: (patientId, ids) => filesFullyWithin(h.db, patientId, ids),
    readPatientId: () => PATIENT,
    clock,
    logger: { info: log, warn: log },
    links: LINKS,
    pollThrottleMs: options.pollThrottleMs ?? 0,
  });

  return { h, engine, store, flow, port, logs, setNow: h.setNow };
}
