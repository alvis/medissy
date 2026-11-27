/**
 * the engine's bookkeeping across polls: per-task serialisation, the abuse
 * limits on unbound sign-ins and the short-lived answer cache
 */
import { EngineError } from './engine-types';

import type { TaskId } from '../contracts';

import type { EngineLogger } from './engine-types';
import type { TaskStore } from './task-store';
import type { TaskJson } from './view';

/** most cached answers kept */
const MAX_CACHED = 10_000;

/** runs async work one at a time per key */
export type KeyedLock = <T>(key: string, body: () => Promise<T>) => Promise<T>;

/** the sign-in slots clients hold */
export interface SignInLimits {
  /** reserves a slot for a task, or throws `busy` */
  reserve(client: string, taskId: TaskId, now: number): void;
  /** gives a task's slot back */
  release(client: string, taskId: TaskId): void;
  /** moves a held slot's lapse time to when its sign-in ends */
  hold(client: string, taskId: TaskId, until: number): void;
}

/** the answers served again within the poll throttle */
export interface AnswerCache {
  /** returns the cached answer for a task, if it is still fresh */
  cached(taskId: string, now: number): TaskJson | undefined;
  /** remembers an answer when it is evidence-free, and returns it */
  remember(taskId: string, now: number, view: TaskJson): TaskJson;
}

/**
 * returns the IPv6 /48 a client key (`clientKey`: an IPv4 address or an IPv6 /64
 * like `2001:db8:1:2::/64`) belongs to; an IPv4 client is its own network
 * @param client the client key
 * @returns the network key
 */
export function networkOf(client: string): string {
  const match = /^([0-9a-f]+:[0-9a-f]+:[0-9a-f]+):[0-9a-f]+::\/64$/i.exec(
    client,
  );

  return match ? `${match[1]}::/48` : client;
}

/**
 * serialises async work per key
 * @returns a runner
 */
export function keyedLock(): KeyedLock {
  const tails = new Map<string, Promise<unknown>>();

  return async (key, body) => {
    const previous = tails.get(key) ?? Promise.resolve();
    const run = previous.then(body, body);
    const tail = run.catch(() => undefined);

    tails.set(key, tail);

    try {
      return await run;
    } finally {
      if (tails.get(key) === tail) {
        tails.delete(key);
      }
    }
  };
}

/**
 * returns the client's sign-ins still waiting: unexpired, and the task still
 * unbound and AUTH_REQUIRED; prunes the rest
 * @param held every client's sign-ins, keyed by client
 * @param store the task store
 * @param waiting the client and the current time (ms)
 * @param waiting.client the client key
 * @param waiting.now the current time (ms)
 * @returns the live sign-ins of the client
 */
function liveSignIns(
  held: Map<string, Map<TaskId, number>>,
  store: TaskStore,
  waiting: { client: string; now: number },
): Map<TaskId, number> {
  const { client, now } = waiting;
  const mine = held.get(client) ?? new Map<TaskId, number>();

  for (const [taskId, until] of mine) {
    const task = store.find(taskId);

    if (
      until <= now ||
      !task ||
      task.caller ||
      task.state !== 'TASK_STATE_AUTH_REQUIRED'
    ) {
      mine.delete(taskId);
    }
  }

  if (mine.size === 0) {
    held.delete(client);
  }

  return mine;
}

/**
 * tracks unbound sign-ins per client and per IPv6 /48
 * @param config the store, logger and limits
 * @param config.store the task store
 * @param config.logger where refusals are logged
 * @param config.ttl how long a task lives (ms)
 * @param config.perClient unbound sign-ins one client may hold
 * @param config.perNetwork unbound sign-ins one IPv6 /48 may hold
 * @returns the slot operations
 */
export function createSignInLimits(config: {
  store: TaskStore;
  logger: EngineLogger;
  ttl: number;
  perClient: number;
  perNetwork: number;
}): SignInLimits {
  const { store, logger, ttl, perClient, perNetwork } = config;
  /** unbound sign-ins per client: task id -> when its sign-in lapses (ms) */
  const signIns = new Map<string, Map<TaskId, number>>();

  return {
    reserve: (client, taskId, now) => {
      const held = liveSignIns(signIns, store, { client, now });
      const network = networkOf(client);
      let inNetwork = 0;

      if (network !== client) {
        for (const other of [...signIns.keys()]) {
          if (networkOf(other) === network) {
            inNetwork +=
              other === client
                ? held.size
                : liveSignIns(signIns, store, { client: other, now }).size;
          }
        }
      }

      if (held.size >= perClient || inNetwork >= perNetwork) {
        logger.warn({ event: 'a2a.task.busy' });
        throw new EngineError('busy');
      }

      held.set(taskId, now + ttl);
      signIns.set(client, held);
    },
    release: (client, taskId) => {
      const held = signIns.get(client);

      held?.delete(taskId);
      if (held?.size === 0) {
        signIns.delete(client);
      }
    },
    hold: (client, taskId, until) => {
      signIns.get(client)?.set(taskId, until);
    },
  };
}

/**
 * creates an answer cache that keeps the last evidence-free answer per task
 * (pending, denied, ended), never served past the task's expiry; a view with
 * artifacts is never cached
 * @param config the store and the throttle window
 * @param config.store the task store
 * @param config.throttle the window (ms); 0 disables caching
 * @returns the reader and writer of cached answers
 */
export function createAnswerCache(config: {
  store: TaskStore;
  throttle: number;
}): AnswerCache {
  const { store, throttle } = config;
  const answers = new Map<
    string,
    { at: number; until: number; view: TaskJson }
  >();

  return {
    cached: (taskId, now) => {
      const hit = answers.get(taskId);

      if (hit && now - hit.at < throttle && now < hit.until) {
        return hit.view;
      }

      answers.delete(taskId);

      return undefined;
    },
    remember: (taskId, now, view) => {
      const task = store.find(taskId);

      // evidence is never cached: a revoke must show on the very next poll
      if (throttle > 0 && task && view.artifacts.length === 0) {
        if (answers.size >= MAX_CACHED) {
          answers.clear();
        }

        answers.set(taskId, {
          at: now,
          until: Date.parse(task.expiresAt),
          view,
        });
      }

      return view;
    },
  };
}
