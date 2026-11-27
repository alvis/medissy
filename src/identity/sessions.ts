/**
 * owner and clinician browser sessions; they are separate kinds with separate
 * cookies; a session id is looked up together with its kind, so an owner
 * session id presented as a clinician cookie (or the reverse) matches
 * nothing; sessions live in memory in the single Medissy process (ADR-1):
 * a restart signs everyone out, which is the safe direction
 */
import { randomBytes } from 'node:crypto';

import type { ClinicianEntry, Principal } from '../contracts';

const SESSION_ID_BYTES = 32;
const MS_PER_SECOND = 1000;
const DEFAULT_MAX_SESSIONS = 10_000;

export const SESSION_KINDS = ['owner', 'clinician'] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

/** a signed-in browser; holds the verified principal, never a token */
export interface PortalSession {
  id: string;
  kind: SessionKind;
  principal: Principal;
  clinician: ClinicianEntry | null;
  createdAt: Date;
  expiresAt: Date;
  /** when the person authenticated at the issuer (ID token `auth_time`) */
  authTime?: Date;
}

/** what a new session is created from */
export interface NewSession {
  kind: SessionKind;
  principal: Principal;
  clinician: ClinicianEntry | null;
  ttlSeconds: number;
  /** hard ceiling, e.g. the access token's expiry */
  notAfter: Date;
  /** the verified ID token's `auth_time`, when the sign-in returned one */
  authTime?: Date;
}

/** in-memory session store with absolute expiry */
export class SessionStore {
  readonly #sessions = new Map<string, PortalSession>();
  readonly #now: () => Date;
  readonly #max: number;

  /**
   * @param now the clock
   * @param max the most sessions held at once; the oldest is dropped beyond it
   */
  constructor(now: () => Date = () => new Date(), max = DEFAULT_MAX_SESSIONS) {
    this.#now = now;
    this.#max = max;
  }

  /**
   * starts a session with a fresh random id
   * @param input kind, principal, registry entry, lifetime and ceiling
   * @returns the new session
   */
  public create(input: NewSession): PortalSession {
    const createdAt = this.#now();
    const ttlEnd = createdAt.getTime() + input.ttlSeconds * MS_PER_SECOND;
    const session: PortalSession = {
      id: randomBytes(SESSION_ID_BYTES).toString('base64url'),
      kind: input.kind,
      principal: input.principal,
      clinician: input.clinician,
      createdAt,
      expiresAt: new Date(Math.min(ttlEnd, input.notAfter.getTime())),
      ...(input.authTime ? { authTime: input.authTime } : {}),
    };

    if (this.#sessions.size >= this.#max) {
      const oldest = this.#sessions.keys().next();

      if (!oldest.done) {
        this.#sessions.delete(oldest.value);
      }
    }

    this.#sessions.set(session.id, session);

    return session;
  }

  /**
   * finds a live session of the given kind
   * @param kind the kind the cookie claims
   * @param id the session id from the cookie
   * @returns the session, or null when unknown, expired or of another kind
   */
  public find(kind: SessionKind, id: string): PortalSession | null {
    const session = this.#sessions.get(id);

    if (!session) {
      return null;
    }

    if (session.expiresAt.getTime() <= this.#now().getTime()) {
      this.#sessions.delete(id);

      return null;
    }

    return session.kind === kind ? session : null;
  }

  /**
   * ends a session
   * @param id the id of the session to end
   */
  public destroy(id: string): void {
    this.#sessions.delete(id);
  }
}
