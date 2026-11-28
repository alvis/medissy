/**
 * the policy engine: the single entry point that loads current policy state
 * from the vault and decides; a decision is always made for the principal the
 * server verified and bound to the task (decision D10), never for an identity
 * claimed in message text, and every later use re-checks it for the bound
 * person against a fresh registry read
 */
import { readRecordLabels } from '../vault/records';

import { decide, recheckDecision } from './decide';
import {
  PolicyDataError,
  readClinician,
  readEncounter,
  readGrants,
  readPatientId,
} from './repository';

import type { DatabaseSync } from 'node:sqlite';

import type { PersonRef, Principal } from '../contracts';

import type {
  PolicyAllow,
  PolicyDecision,
  PolicyRequest,
  RecheckInput,
} from './decide';
import type { InvalidGrantRow } from './repository';

/** the server clock, injected so tests control time */
export type Clock = () => Date;

/** an audit-safe notice that one stored grant row was skipped: ids only */
export interface InvalidGrantSignal {
  grantId: string;
  version: number;
}

/** what a `PolicyEngine` is bound to for its lifetime */
export interface PolicyEngineOptions {
  /** an open vault */
  db: DatabaseSync;
  /** the server clock; read once per decision */
  clock: Clock;
  /** the callback receiving each invalid allow-grant row the engine skipped */
  onInvalidGrant: (signal: InvalidGrantSignal) => void;
}

/** what `evaluate` decides on */
export interface EvaluateParams {
  /** the principal derived from a verified access token */
  principal: Principal;
  /** the parsed request; its encounter id is only a selector */
  request: PolicyRequest;
}

/** what `recheck` re-checks */
export interface RecheckParams {
  /** the allow decision about to be relied on */
  prior: PolicyAllow;
  /** the verified issuer and subject bound to the task; no token needed */
  caller: PersonRef;
}

/** request decisions and decision re-checks against one vault and clock */
export class PolicyEngine {
  readonly #db: DatabaseSync;
  readonly #clock: Clock;
  readonly #onInvalidGrant: (signal: InvalidGrantSignal) => void;

  /** @param options the vault, the clock and the invalid-grant signal sink */
  constructor(options: PolicyEngineOptions) {
    this.#db = options.db;
    this.#clock = options.clock;
    this.#onInvalidGrant = options.onInvalidGrant;
  }

  /**
   * decides a clinical request against the vault's current policy state
   * @param params the verified principal and the request
   * @returns the decision
   */
  public evaluate(params: EvaluateParams): PolicyDecision {
    const { principal, request } = params;

    return decide({
      ...this.#readState(principal, request.encounterId),
      principal,
      request,
    });
  }

  /**
   * re-checks a prior allow at the moment of use (retrieval, release, poll)
   * for the bound person, against a fresh registry, encounter and grant read;
   * a grant revoked or expired since the decision fails closed here
   * @param params the prior decision and the bound person
   * @returns the decision narrowed to what is still releasable, or a deny
   */
  public recheck(params: RecheckParams): PolicyDecision {
    const { prior, caller } = params;

    return recheckDecision(prior, {
      ...this.#readState(caller, prior.encounterId),
      caller,
    });
  }

  /**
   * runs reads inside one transaction so they see a single snapshot, unless a
   * transaction is already open (then its snapshot applies); a re-check made
   * inside `read` shares the snapshot
   * @param read the reads to run against the vault
   * @returns what the reads returned
   */
  public snapshot<T>(read: (db: DatabaseSync) => T): T {
    const db = this.#db;

    if (db.isTransaction) {
      return read(db);
    }

    db.exec('BEGIN');

    try {
      const result = read(db);

      db.exec('COMMIT');

      return result;
    } catch (error) {
      db.exec('ROLLBACK');

      throw error;
    }
  }

  /**
   * reads the clock once, refusing a reading that is not a valid instant
   * @returns the current server time
   */
  public now(): Date {
    const now = this.#clock();

    if (Number.isNaN(now.getTime())) {
      throw new RangeError('the policy clock returned an invalid date');
    }

    return now;
  }

  /**
   * reads every input of a decision from one consistent snapshot
   * @param person the verified issuer and subject
   * @param encounterId the encounter selector to resolve
   * @returns the decision state without the principal or request
   */
  #readState(
    person: PersonRef,
    encounterId: string,
  ): Omit<RecheckInput, 'caller'> {
    const now = this.now();

    return this.snapshot((db) => {
      const patientId = readPatientId(db) ?? '';
      const { grants, invalid } = patientId
        ? readGrants(db, patientId)
        : { grants: [], invalid: [] };

      this.#skipInvalid(invalid);

      return {
        clinician: readClinician(db, person),
        encounter: readEncounter(db, encounterId),
        patientId,
        grants,
        records: patientId ? readRecordLabels(db, patientId) : [],
        now,
      };
    });
  }

  /**
   * skips invalid allow rows with a signal each; any other invalid row might
   * be a deny, and skipping a deny would widen access, so it stops the
   * decision instead
   * @param invalid the invalid effective grant rows
   */
  #skipInvalid(invalid: readonly InvalidGrantRow[]): void {
    if (invalid.some((row) => row.effect !== 'allow')) {
      throw new PolicyDataError('grants');
    }

    for (const row of invalid) {
      this.#onInvalidGrant({ grantId: row.id, version: row.version });
    }
  }
}
