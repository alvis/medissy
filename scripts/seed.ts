/* eslint-disable no-console -- an operator CLI prints its summary */
/**
 * the idempotent seed of the synthetic vault at `DATABASE_PATH` for the public
 * origin `MEDISSY_PUBLIC_URL`
 *
 * boot already runs `ensureDemoTrust` (the trusted patient issuer and the
 * trusted Northgate Health institution; clinicians are recorded just in time
 * at sign-in, ADR-9); this script reuses it and adds what boot does not
 * create: the one synthetic patient, owned by the demo owner at this
 * origin's issuer, and (with `--records fixture`) the synthetic records,
 * imported through the real `runSync` over the tests-only fixture adapter;
 * that run is stored with adapter `fixture`, so it can never pass for Box
 * connector I/O (A01); encounters and grants are not seeded; the journey
 * creates them through the owner's confirm page, as in the demo
 *
 * usage: pnpm seed [--records fixture|none] [--env-file <path>]
 * default records: `fixture`, or `none` when NODE_ENV=production
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { loadCuration } from '../src/box/curation';
import { createFixtureAdapter, loadSyntheticFixtureFiles } from '../src/box/fixture';
import { runSync } from '../src/box/sync';
import {
  DEMO_ISSUER_LABEL,
  ensureDemoTrust,
  INSTITUTION_ISSUER_LABEL,
} from '../src/demo-idp/seed';
import { DEMO_OWNER } from '../src/demo-idp/users';
import { readVaultOwner } from '../src/sharing/store';
import { openVault } from '../src/vault/migrate';

import { loadEnvFile, parseCommonArgs } from './lib/env';

import type { DatabaseSync } from 'node:sqlite';

import type { Env } from './lib/env';

/** the repository's synthetic fixtures */
export const FIXTURES_ROOT = resolve(import.meta.dirname, '..', 'fixtures', 'synthetic');
/** the folder id the fixture adapter reports; labelled `fixture` in the vault */
export const FIXTURE_FOLDER_ID = '8800000001';
/** the patient label; the schema requires SYNTHETIC in it */
export const PATIENT_LABEL = 'SYNTHETIC Morgan Testwell';

/** where records come from */
export type RecordSource = 'fixture' | 'none';

/** what `seedVault` needs */
export interface SeedOptions {
  /** the public origin, as `MEDISSY_PUBLIC_URL` */
  publicUrl: string;
  records: RecordSource;
  fixturesRoot?: string;
  now?: () => Date;
}

/** what `seedVault` did */
export interface SeedSummary {
  patient: 'created' | 'existing';
  issuer: string;
  records:
    | { source: 'none' }
    | { source: 'fixture'; status: string; imported: number; duplicate: number; rejected: number; expectedRejected: number };
}

interface Manifest {
  patientId: string;
  sourceDocuments: Array<{ outcome: 'import' | 'reject' }>;
}

/**
 * drops trailing slashes without a backtracking regex
 * @param value a URL
 * @returns the URL without trailing slashes
 */
function trimTrailingSlashes(value: string): string {
  let end = value.length;

  while (end > 0 && value[end - 1] === "/") {
    end -= 1;
  }

  return value.slice(0, end);
}

/**
 * returns the patient's demo issuer and audience for a public URL, exactly as
 * `createDemoProvider` derives them
 * @param publicUrl the public URL
 * @returns the issuer and audience
 */
export function demoIssuerFor(publicUrl: string): { issuer: string; audience: string } {
  const origin = trimTrailingSlashes(publicUrl);

  return { issuer: `${origin}/demo-idp`, audience: origin };
}

/**
 * decides the record source from the arguments and environment
 * @param args the script arguments
 * @param env the environment
 * @returns the record source
 * @throws {Error} for an unknown value
 */
export function recordSourceFrom(args: readonly string[], env: Env): RecordSource {
  const index = args.indexOf('--records');
  const value = index >= 0 ? args[index + 1] : env.NODE_ENV === 'production' ? 'none' : 'fixture';

  if (value !== 'fixture' && value !== 'none') {
    throw new Error('--records must be fixture or none');
  }

  return value;
}

/**
 * seeds the vault; safe to repeat: the patient and trust rows are inserted
 * only when absent, and a repeated fixture import finds only duplicates
 * @param db a vault opened through `openVault`
 * @param options origin, record source, fixtures and clock
 * @returns what was done
 * @throws {Error} when the vault belongs to another issuer or patient
 */
export async function seedVault(db: DatabaseSync, options: SeedOptions): Promise<SeedSummary> {
  const root = options.fixturesRoot ?? FIXTURES_ROOT;
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as Manifest;
  const { issuer, audience } = demoIssuerFor(options.publicUrl);
  const at = (options.now ?? (() => new Date()))().toISOString();
  const existing = readVaultOwner(db);

  if (existing && (existing.owner.issuer !== issuer || existing.patientId !== manifest.patientId)) {
    throw new Error(
      'this vault belongs to another patient or issuer (was MEDISSY_PUBLIC_URL changed?); run pnpm cleanup first',
    );
  }

  if (!existing) {
    db.prepare(
      'INSERT INTO patient (id, label, owner_issuer, owner_subject, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(manifest.patientId, PATIENT_LABEL, issuer, DEMO_OWNER.subject, at);
  }

  ensureDemoTrust(db, {
    publicUrl: options.publicUrl,
    audience,
    ...(options.now ? { now: options.now } : {}),
  });

  if (options.records === 'none') {
    return { patient: existing ? 'existing' : 'created', issuer, records: { source: 'none' } };
  }

  const summary = await runSync(
    {
      db,
      adapter: createFixtureAdapter(FIXTURE_FOLDER_ID, loadSyntheticFixtureFiles(root)),
      curation: loadCuration(join(root, 'records.json'), manifest.patientId),
      patientId: manifest.patientId,
      ...(options.now ? { now: options.now } : {}),
    },
    { trigger: 'seed', actor: { kind: 'system' } },
  );

  return {
    patient: existing ? 'existing' : 'created',
    issuer,
    records: {
      source: 'fixture',
      status: summary.status,
      imported: summary.imported,
      duplicate: summary.duplicate,
      rejected: summary.rejected,
      expectedRejected: manifest.sourceDocuments.filter((doc) => doc.outcome === 'reject').length,
    },
  };
}

/**
 * opens the vault from the environment and seeds it
 * @param argv arguments after the script name
 * @param env the environment
 * @returns the summary
 * @throws {Error} when DATABASE_PATH or MEDISSY_PUBLIC_URL is missing
 */
export async function runSeed(argv: readonly string[], env: Env = process.env): Promise<SeedSummary> {
  const { envFile, rest } = parseCommonArgs(argv);

  loadEnvFile(env, envFile.path, envFile.explicit);

  const path = env.DATABASE_PATH;
  const publicUrl = env.MEDISSY_PUBLIC_URL;

  if (!path || !publicUrl) {
    throw new Error('DATABASE_PATH and MEDISSY_PUBLIC_URL are required');
  }

  const records = recordSourceFrom(rest, env);

  mkdirSync(dirname(path), { recursive: true });

  const db = openVault(path);

  try {
    return await seedVault(db, { publicUrl, records });
  } finally {
    db.close();
  }
}

/**
 * returns one line per fact, no secrets
 * @param summary the summary
 * @returns the lines
 */
export function describeSeed(summary: SeedSummary): string[] {
  const lines = [
    `patient: ${summary.patient} (${PATIENT_LABEL})`,
    `trusted issuer: ${summary.issuer} (${DEMO_ISSUER_LABEL}); institution (${INSTITUTION_ISSUER_LABEL}) trusted for doctor sign-in`,
  ];

  if (summary.records.source === 'none') {
    lines.push('records: not seeded (use Box sync on /owner, or --records fixture)');
  } else {
    const { status, imported, duplicate, rejected, expectedRejected } = summary.records;

    lines.push(
      `records: FIXTURE ADAPTER (not Box) run ${status}: ${imported} file(s) imported, ${duplicate} duplicate, ${rejected} rejected (expected ${expectedRejected})`,
    );
  }

  return lines;
}

if (import.meta.main) {
  try {
    for (const line of describeSeed(await runSeed(process.argv.slice(2)))) {
      console.log(line);
    }
  } catch (error) {
    console.error(`seed failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  }
}

/* eslint-enable no-console */
