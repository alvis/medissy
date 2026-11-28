import { vi } from 'vitest';

import {
  CARDIOLOGIST,
  ENC_CARDIO,
  OWNER,
  T_NOW,
  personFor,
} from '../policy/support';

import type { DatabaseSync } from 'node:sqlite';

import type { PersonRef } from '../../src/contracts';
import type {
  GrantChoice,
  SharingDeps,
  SharingLogEntry,
} from '../../src/sharing';

export const ORIGIN = 'https://medissy.example.invalid';
export const OWNER_REF: PersonRef = personFor(OWNER);
export const CARDIO_REF: PersonRef = personFor(CARDIOLOGIST);
export const HOUR_MS = 3_600_000;

/**
 * builds an instant relative to T_NOW
 * @param hours hours after T_NOW (negative for before)
 * @returns the canonical timestamp
 */
export function at(hours: number): string {
  return new Date(Date.parse(T_NOW) + hours * HOUR_MS).toISOString();
}

/** sharing deps over a vault with a movable clock and a spy logger */
export interface SharingHarness {
  deps: SharingDeps;
  log: ReturnType<typeof vi.fn<(entry: SharingLogEntry) => void>>;
  setNow: (iso: string) => void;
}

/**
 * builds sharing deps over a vault
 * @param db a seeded vault
 * @param clock an existing clock to share (e.g. the disclosure harness's)
 * @returns the deps, the logger spy and clock control
 */
export function sharingHarness(
  db: DatabaseSync,
  clock?: () => Date,
): SharingHarness {
  let now = T_NOW;
  const log = vi.fn<(entry: SharingLogEntry) => void>();

  return {
    log,
    setNow: (iso) => {
      now = iso;
    },
    deps: {
      db,
      clock: clock ?? (() => new Date(now)),
      publicOrigin: ORIGIN,
      logger: { info: log },
    },
  };
}

/**
 * returns the token carried in an invitation URL's fragment
 * @param url the invitation URL
 * @returns the invitation token without the leading hash sign
 */
export function tokenOf(url: string): string {
  return new URL(url).hash.slice(1);
}

/**
 * builds a grant choice on the cardiology encounter
 * @param overrides fields to replace
 * @returns a complete grant choice with the overrides applied
 */
export function choiceFor(overrides: Partial<GrantChoice> = {}): GrantChoice {
  return {
    encounter: { kind: 'existing', id: ENC_CARDIO },
    categories: ['cardiac'],
    allowBaseline: true,
    maxSensitivity: 'routine',
    expiresAt: at(48),
    ...overrides,
  };
}
