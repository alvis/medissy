import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadCuration } from '../../src/box/curation';
import {
  createFixtureAdapter,
  loadSyntheticFixtureFiles,
} from '../../src/box/fixture';
import { openVault } from '../../src/vault/migrate';

import type { DatabaseSync } from 'node:sqlite';

import type { FixtureFile } from '../../src/box/fixture';
import type { SyncDeps } from '../../src/box/sync';

export const ROOT = join(
  import.meta.dirname,
  '..',
  '..',
  'fixtures',
  'synthetic',
);
export const FOLDER = '8800000001';
export const MANIFEST = JSON.parse(
  readFileSync(join(ROOT, 'manifest.json'), 'utf8'),
) as {
  patientId: string;
  canary: string;
  sourceDocuments: Array<{
    file: string;
    boxFileId: string;
    outcome: 'import' | 'reject';
    recordIds: string[];
  }>;
};

let sequence = 0;

export const PATIENT = MANIFEST.patientId;
export const CURATION = loadCuration(join(ROOT, 'records.json'), PATIENT);

/**
 * builds a fresh in-memory vault holding the one synthetic patient
 * @returns the database
 */
export function freshVault(): DatabaseSync {
  const db = openVault(':memory:');

  db.prepare(
    `INSERT INTO patient (id, label, owner_issuer, owner_subject, created_at)
     VALUES (?, 'SYNTHETIC Morgan Testwell', 'https://idp.example.invalid', 'owner-1', '2026-11-25T10:00:00.000Z')`,
  ).run(PATIENT);

  return db;
}

/**
 * lists the repository's synthetic source documents as fixture files
 * @returns fixture files in manifest order
 */
export function syntheticFiles(): FixtureFile[] {
  return loadSyntheticFixtureFiles(ROOT);
}

/**
 * builds a text fixture file
 * @param source the file to copy ids from
 * @param overrides fields to change
 * @returns a new fixture file
 */
export function variant(
  source: FixtureFile,
  overrides: Partial<FixtureFile> & { text?: string },
): FixtureFile {
  const { text, ...rest } = overrides;

  return {
    ...source,
    ...rest,
    ...(text === undefined ? {} : { bytes: new TextEncoder().encode(text) }),
  };
}

/**
 * builds sync dependencies over the fixture adapter with a deterministic clock and ids
 * @param db the vault
 * @param files files in the folder
 * @returns the dependencies
 */
export function depsFor(
  db: DatabaseSync,
  files: readonly FixtureFile[],
): SyncDeps {
  let tick = 0;

  return {
    db,
    adapter: createFixtureAdapter(FOLDER, files),
    curation: CURATION,
    patientId: PATIENT,
    now: () => new Date(Date.UTC(2026, 10, 25, 12, 0, 0, (tick += 1))),
    newId: () => `id-${(sequence += 1)}`,
  };
}

/**
 * counts rows in a table
 * @param db the vault
 * @param table the table name
 * @returns the row count
 */
export function count(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
    n: number;
  };

  return row.n;
}
