import { expect, vi } from 'vitest';

import { parseConflictLinks } from '../../src/disclosure/pairing';
import { disclose, redisclose } from '../../src/disclosure/pipeline';
import {
  CANARY,
  CARDIOLOGIST,
  DENTIST,
  ENC_CARDIO,
  ENC_DENTAL,
  ISSUER,
  PATIENT,
  RIVERSIDE,
  T_NOW,
  grantFor,
  insertGrant,
  manifest,
  personFor,
  principalFor,
  seedVault,
} from '../policy/support';

import type { DatabaseSync } from 'node:sqlite';

import type { ClinicalRequest, Principal } from '../../src/contracts';
import type {
  DisclosureDeps,
  DisclosureLogEntry,
  PipelineOutcome,
  ReleasedOutcome,
} from '../../src/disclosure/pipeline';
import type {
  SelectorClient,
  SelectorRequest,
  SelectorResponse,
} from '../../src/disclosure/selector';

export const conflictLinks = parseConflictLinks(manifest);
export const restrictedIds = manifest.groups.restricted;
export const baselineIds = manifest.groups.baseline;

/** a recording fake of the selector client */
export interface FakeModel {
  client: SelectorClient;
  requests: SelectorRequest[];
}

/**
 * builds a recording fake model
 * @param respond what the fake does for each call
 * @returns the client and every request it received
 */
export function fakeModel(
  respond: (
    request: SelectorRequest,
  ) => SelectorResponse | Promise<SelectorResponse>,
): FakeModel {
  const requests: SelectorRequest[] = [];

  return {
    requests,
    client: {
      messages: {
        async parse(request) {
          requests.push(request);

          return respond(request);
        },
      },
    },
  };
}

/**
 * builds a well-formed model answer
 * @param ids the ids the model selects
 * @param confidence the model's confidence
 * @returns the response
 */
export function answer(
  ids: readonly string[],
  confidence: 'high' | 'medium' | 'low' = 'high',
): SelectorResponse {
  return {
    stop_reason: 'end_turn',
    parsed_output: {
      selected: ids.map((id) => ({ id, reason: 'answers-question' })),
      confidence,
    },
  };
}

/** a pipeline harness over a seeded vault */
export interface Harness {
  db: DatabaseSync;
  deps: DisclosureDeps;
  logs: DisclosureLogEntry[];
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  setNow: (iso: string) => void;
}

/**
 * builds a seeded vault with the cardiology and dental grants, and pipeline deps
 * over it with a movable clock, sequential ids and a spy logger
 * @param client the selector client
 * @returns the vault, deps, log capture and clock control
 */
export function harness(client: SelectorClient | undefined): Harness {
  const db = seedVault();
  let now = T_NOW;
  let next = 0;
  const logs: DisclosureLogEntry[] = [];
  const info = vi.fn((entry: DisclosureLogEntry) => {
    logs.push(entry);
  });
  const error = vi.fn((entry: DisclosureLogEntry) => {
    logs.push(entry);
  });

  insertGrant(db, grantFor());
  insertGrant(
    db,
    grantFor({
      id: 'grant-dental',
      grantee: {
        issuer: ISSUER,
        organizationId: RIVERSIDE,
        roles: ['dentist'],
      },
      encounterId: ENC_DENTAL,
      categories: ['dental'],
    }),
  );

  return {
    db,
    logs,
    info,
    error,
    setNow: (iso) => {
      now = iso;
    },
    deps: {
      db,
      clock: () => new Date(now),
      selectorClient: client,
      logger: { info, error },
      conflictLinks,
      newId: () => `id-${String(++next).padStart(4, '0')}`,
    },
  };
}

/**
 * builds a clinical request
 * @param overrides fields to replace
 * @returns a valid cardiology request
 */
export function requestFor(
  overrides: Partial<ClinicalRequest> = {},
): ClinicalRequest {
  return {
    requestId: 'req-1',
    encounterId: ENC_CARDIO,
    purpose: 'direct-treatment',
    question: 'Summarise the rhythm history and anticoagulation.',
    ...overrides,
  };
}

/**
 * runs the pipeline for the cardiologist (or another principal)
 * @param h the harness
 * @param request the request fields to replace
 * @param principal the bound principal
 * @returns the outcome
 */
export async function run(
  h: Harness,
  request: Partial<ClinicalRequest> = {},
  principal: Principal = principalFor(CARDIOLOGIST),
): Promise<PipelineOutcome> {
  return disclose(h.deps, {
    principal,
    patientId: PATIENT,
    request: requestFor(request),
  });
}

/**
 * runs the dental scenario for the dentist
 * @param h the harness
 * @param request the request fields to replace
 * @returns the outcome
 */
export async function runDental(
  h: Harness,
  request: Partial<ClinicalRequest> = {},
): Promise<PipelineOutcome> {
  return run(
    h,
    {
      encounterId: ENC_DENTAL,
      question: 'Which findings matter for extracting tooth 48?',
      ...request,
    },
    principalFor(DENTIST),
  );
}

/**
 * re-serves a stored release for a bound clinician
 * @param h the harness
 * @param requestId the correlation id the receipt was minted for
 * @param subject the clinician bound to the polling task
 * @returns the re-checked release or a denial
 */
export function poll(
  h: Harness,
  requestId = 'req-1',
  subject = CARDIOLOGIST,
): PipelineOutcome {
  return redisclose(h.deps, {
    caller: personFor(subject),
    patientId: PATIENT,
    requestId,
  });
}

/**
 * requires a release
 * @param outcome the pipeline outcome
 * @returns the release
 */
export function released(outcome: PipelineOutcome): ReleasedOutcome {
  if (outcome.kind !== 'released') {
    throw new Error(`expected a release, got ${outcome.denial.code}`);
  }

  return outcome;
}

/**
 * lists the ids in a release's bundle, sorted
 * @param outcome the pipeline outcome
 * @returns the bundle resource ids
 */
export function bundleIds(outcome: PipelineOutcome): string[] {
  return released(outcome)
    .result.bundle.entry.map((entry) => entry.resource.id)
    .sort();
}

/**
 * lists the evidence record ids of a release, sorted
 * @param outcome the pipeline outcome
 * @returns the record ids of the evidence cards
 */
export function evidenceIds(outcome: PipelineOutcome): string[] {
  return released(outcome)
    .result.evidence.map((item) => item.recordId)
    .sort();
}

/**
 * lists every row of a table, for leak and count checks
 * @param db the vault
 * @param table the table name
 * @returns every stored row as a plain object
 */
export function rows(
  db: DatabaseSync,
  table: 'audit_events' | 'receipts' | 'receipt_records',
): Array<Record<string, unknown>> {
  return db.prepare(`SELECT * FROM ${table}`).all();
}

/**
 * asserts that a value, serialised, carries no restricted content: neither the
 * canary nor any restricted record id
 * @param value anything that leaves the pipeline
 */
export function expectNoRestricted(value: unknown): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value);

  expect(text).not.toContain(CANARY);

  for (const id of restrictedIds) {
    expect(text).not.toContain(id);
  }
}
