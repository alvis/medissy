/**
 * shared types of the sharing service (brief SHR): invitations, connections,
 * scope requests and the owner's grant decisions
 */
import type { DatabaseSync } from 'node:sqlite';

import type { GrantableCategory, Sensitivity } from '../contracts';

/** one content-free log line: never a token, code, id, name or reason */
export interface SharingLogEntry {
  event:
    | 'invitation.created'
    | 'invitation.redeemed'
    | 'scope.requested'
    | 'connection.confirmed'
    | 'connection.declined'
    | 'scope.approved'
    | 'scope.declined'
    | 'grant.revoked';
  outcome: 'success' | 'denied';
}

/** where the service writes its log lines; a pino logger satisfies it */
export interface SharingLogger {
  info(entry: SharingLogEntry): void;
}

/** what every sharing operation is bound to */
export interface SharingDeps {
  /** a vault opened through `openVault` */
  db: DatabaseSync;
  /** the server clock */
  clock: () => Date;
  /**
   * Medissy's configured public origin (from the Host allowlist), never the
   * request's Host header; invitation URLs hang off it
   */
  publicOrigin: string;
  /** source of row ids; random UUIDs by default */
  newId?: () => string;
  logger?: SharingLogger;
}

/** why an operation refused; every refusal changes nothing */
export type SharingDenialCode =
  | 'not-permitted'
  | 'not-found'
  | 'invalid-input'
  | 'not-pending'
  | 'expired'
  | 'conflict'
  | 'invitation-unavailable';

/** a refusal */
export interface SharingDenial {
  ok: false;
  code: SharingDenialCode;
}

/** the encounter a confirmation grants access in */
export type EncounterChoice =
  | { kind: 'existing'; id: string }
  | {
      kind: 'new';
      /** owner-entered free text; untrusted when rendered */
      reason?: string;
      endsAt: string;
    };

/** the grant the owner chose on the confirm page, in full */
export interface GrantChoice {
  encounter: EncounterChoice;
  categories: GrantableCategory[];
  allowBaseline: boolean;
  maxSensitivity: Sensitivity;
  expiresAt: string;
}
