import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createFixtureAdapter } from '../../src/box/fixture';
import { boxSyncFromEnv, createBoxSync } from '../../src/portal';
import {
  count,
  FOLDER,
  freshVault,
  MANIFEST,
  ROOT,
  syntheticFiles,
} from '../box/support';

const OWNER = { issuer: 'https://idp.example.invalid', subject: 'owner-1' };

describe('fn:createBoxSync', () => {
  it('should run the existing Box ingestion for the owner and report what it imported', async () => {
    const db = freshVault();
    const sync = createBoxSync({
      db,
      adapter: createFixtureAdapter(FOLDER, syntheticFiles()),
      curationPath: join(ROOT, 'records.json'),
    });

    const run = await sync(OWNER);

    const importable = MANIFEST.sourceDocuments.filter(
      (doc) => doc.outcome === 'import',
    );
    const row = db
      .prepare(
        'SELECT trigger, status, files_imported, files_rejected, error_summary FROM sync_runs',
      )
      .get();

    // the synthetic set holds exactly one other patient's file, rejected on purpose
    expect(run).toEqual({ status: 'partial', imported: importable.length });
    expect(count(db, 'records')).toBe(30);
    expect(row).toMatchObject({
      trigger: 'owner',
      status: 'partial',
      files_imported: importable.length,
      files_rejected: 1,
    });
    expect(String(row?.error_summary)).toContain('foreign-patient');
  });
});

describe('fn:boxSyncFromEnv', () => {
  it('should leave sync NOT CONFIGURED unless the connector and the curated catalogue are all set', () => {
    const db = freshVault();

    expect(boxSyncFromEnv({}, db)).toBeUndefined();
    expect(
      boxSyncFromEnv(
        {
          BOX_GATEWAY_CONNECTION_ID: 'replace-me',
          BOX_ALLOWED_FOLDER_ID: FOLDER,
          BOX_CURATION_PATH: join(ROOT, 'records.json'),
        },
        db,
      ),
    ).toBeUndefined();
    expect(
      boxSyncFromEnv(
        {
          BOX_GATEWAY_CONNECTION_ID: 'conn-1',
          BOX_ALLOWED_FOLDER_ID: FOLDER,
          BOX_CURATION_PATH: join(ROOT, 'records.json'),
        },
        db,
      ),
    ).toBeTypeOf('function');
  });
});
