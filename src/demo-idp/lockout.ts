/**
 * lockout for demo passphrases, per (persona, client): after `maxFailures`
 * wrong passphrases for one persona from one client (IP, IPv6 /64) within
 * `windowSeconds`, that client is refused for that persona, even with the
 * right passphrase, until the window that began with the first failure ends;
 * other clients are never affected, so nobody can lock the owner or a
 * clinician out of sign-in (and so out of revocation) from elsewhere; the
 * per-IP rate limit bounds how fast one client guesses; the residual is a
 * guess spread over many addresses, bounded by the passphrase strength; the
 * store is bounded; when full, the oldest counters go first
 */
const MS_PER_SECOND = 1000;
const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_WINDOW_SECONDS = 900;
const DEFAULT_MAX_KEYS = 1000;

/**
 * builds the lockout key of a persona and a client
 * @param persona the synthetic account being attempted
 * @param client the client key (`clientKey(request.ip)`)
 * @returns the combined map key
 */
export function lockoutKey(persona: string, client: string): string {
  return `${persona}\u0000${client}`;
}

/** options for `createLockout` */
export interface LockoutOptions {
  maxFailures?: number;
  windowSeconds?: number;
  maxKeys?: number;
  now?: () => Date;
}

/** tracks failed passphrase attempts per key (see `lockoutKey`) */
export interface Lockout {
  /** returns the seconds until the persona unlocks, or 0 when it is not locked */
  lockedFor(persona: string): number;
  /** records a failed attempt */
  fail(persona: string): void;
  /** forgets the failures after a successful sign-in */
  reset(persona: string): void;
  /** counters currently held */
  readonly size: number;
}

interface Failures {
  count: number;
  resetAt: number;
}

/**
 * builds a lockout tracker
 * @param options threshold, window, capacity and clock
 * @returns the tracker
 */
export function createLockout(options: LockoutOptions = {}): Lockout {
  const maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
  const windowMs =
    (options.windowSeconds ?? DEFAULT_WINDOW_SECONDS) * MS_PER_SECOND;
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  const now = options.now ?? (() => new Date());
  const failures = new Map<string, Failures>();

  const current = (persona: string, at: number): Failures | undefined => {
    const entry = failures.get(persona);

    if (entry && entry.resetAt <= at) {
      failures.delete(persona);

      return undefined;
    }

    return entry;
  };

  return {
    /**
     * reports how long the persona stays locked
     * @param persona the synthetic account key
     * @returns the seconds remaining, or 0 when not locked
     */
    lockedFor(persona) {
      const at = now().getTime();
      const entry = current(persona, at);

      return entry && entry.count >= maxFailures
        ? Math.ceil((entry.resetAt - at) / MS_PER_SECOND)
        : 0;
    },
    /**
     * counts a failed attempt, opening a window on the first
     * @param persona the synthetic account key
     */
    fail(persona) {
      const at = now().getTime();
      const entry = current(persona, at);

      if (entry) {
        entry.count += 1;

        return;
      }

      for (const key of failures.keys()) {
        if (failures.size < maxKeys) {
          break;
        }

        failures.delete(key);
      }

      failures.set(persona, { count: 1, resetAt: at + windowMs });
    },
    /**
     * forgets a persona's failures after a successful sign-in
     * @param persona the synthetic account key
     */
    reset(persona) {
      failures.delete(persona);
    },
    /** the number of personas currently tracked */
    get size() {
      return failures.size;
    },
  };
}
