import { describe, expect, it } from 'vitest';

import { listConflicts } from '../../src/box/catalog';
import { DEFAULT_LIMITS } from '../../src/box/ingest';
import { runSync } from '../../src/box/sync';
import { SourceAdapterError } from '../../src/box/types';
import { recordImport } from '../../src/vault/sources';

import {
  CURATION,
  PATIENT,
  count,
  depsFor,
  freshVault,
  syntheticFiles,
  variant,
} from './support';

import type { FixtureFile } from '../../src/box/fixture';
import type { RejectionReason } from '../../src/box/types';

const OWNER = { trigger: 'owner' } as const;
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const named = (name: string): FixtureFile => {
  const found = syntheticFiles().find((f) => f.name === name);

  if (!found) {
    throw new Error(`no fixture ${name}`);
  }

  return found;
};
const letter = named('northgate-clinic-letter-2026-10-20.txt');
const cardiology = named('northgate-cardiology-record.json');

/**
 * builds the cardiology bundle after a mutation
 * @param mutate edits the parsed bundle in place
 * @returns the file with the edited body
 */
function editedCardiology(
  mutate: (bundle: {
    entry: Array<{ resource: Record<string, unknown> }>;
  }) => void,
): FixtureFile {
  const bundle = JSON.parse(decode(cardiology.bytes)) as {
    entry: Array<{ resource: Record<string, unknown> }>;
  };

  mutate(bundle);

  return variant(cardiology, { text: JSON.stringify(bundle) });
}

const CASES: Array<[string, RejectionReason, FixtureFile]> = [
  [
    'unsupported type (.pdf)',
    'unsupported-type',
    variant(letter, { name: 'letter.pdf' }),
  ],
  [
    'unsupported type (.exe)',
    'unsupported-type',
    variant(letter, { name: 'run.exe' }),
  ],
  [
    'path traversal in name',
    'unsafe-name',
    variant(letter, { name: '../secret.txt' }),
  ],
  [
    'path separator in name',
    'unsafe-name',
    variant(letter, { name: 'a/b.txt' }),
  ],
  ['backslash in name', 'unsafe-name', variant(letter, { name: '..\\x.txt' })],
  [
    'shared link as name',
    'unsafe-name',
    variant(letter, { name: 'https://app.box.com/s/abc.txt' }),
  ],
  [
    'path traversal as file id',
    'invalid-file-id',
    variant(letter, { id: '../../etc/passwd' }),
  ],
  [
    'shared link as file id',
    'invalid-file-id',
    variant(letter, { id: 'https://app.box.com/s/abc' }),
  ],
  [
    'bad version label',
    'invalid-version',
    variant(letter, { version: '../1' }),
  ],
  [
    'file outside the allowed folder',
    'not-in-allowed-folder',
    variant(letter, { parentId: '77' }),
  ],
  [
    'declared size over the cap',
    'oversized',
    variant(letter, { declaredSize: DEFAULT_LIMITS.maxFileBytes + 1 }),
  ],
  [
    'actual body over the cap',
    'oversized',
    variant(letter, {
      declaredSize: 10,
      bytes: new Uint8Array(DEFAULT_LIMITS.maxFileBytes + 1).fill(65),
    }),
  ],
  [
    'declared size differs from body',
    'size-mismatch',
    variant(letter, { declaredSize: 5 }),
  ],
  ['empty body', 'empty', variant(letter, { bytes: new Uint8Array(0) })],
  [
    'invalid UTF-8',
    'not-utf8',
    variant(letter, { bytes: new Uint8Array([0xff, 0xfe, 0x41]) }),
  ],
  [
    'NUL byte',
    'not-utf8',
    variant(letter, { bytes: new Uint8Array([0x41, 0x00, 0x42]) }),
  ],
  [
    'malformed JSON',
    'malformed-json',
    variant(cardiology, { text: '{not json' }),
  ],
  [
    'JSON that is not a Bundle',
    'malformed-structure',
    variant(cardiology, { text: '{"resourceType":"Patient","id":"x"}' }),
  ],
  [
    'Bundle that is not a collection',
    'malformed-structure',
    variant(cardiology, {
      text: '{"resourceType":"Bundle","type":"document","entry":[]}',
    }),
  ],
  [
    'empty Bundle',
    'empty',
    variant(cardiology, {
      text: '{"resourceType":"Bundle","type":"collection","entry":[]}',
    }),
  ],
  [
    'unsupported resource type',
    'unsupported-resource',
    editedCardiology((b) => {
      b.entry.push({ resource: { resourceType: 'Questionnaire', id: 'q-1' } });
    }),
  ],
  [
    'duplicate resource id',
    'duplicate-resource-id',
    editedCardiology((b) => {
      b.entry.push(b.entry[0] as never);
    }),
  ],
  [
    'text without a patient marker',
    'missing-patient-marker',
    variant(letter, { text: 'A letter with no identifier.' }),
  ],
  [
    'text naming another patient',
    'foreign-patient',
    variant(letter, { text: `${decode(letter.bytes)}\nSee also SYNTH-0002.` }),
  ],
];

describe('A09 rejection cases (fixture adapter)', () => {
  it.each(CASES)(
    'rejects %s as %s and stores nothing',
    async (_name, reason, bad) => {
      const db = freshVault();
      const summary = await runSync(depsFor(db, [bad]), OWNER);

      expect(summary.rejections).toHaveLength(1);
      expect(summary.rejections[0]?.reason).toBe(reason);
      expect(summary).toMatchObject({
        status: 'failed',
        imported: 0,
        rejected: 1,
      });
      expect(count(db, 'records')).toBe(0);
      expect(count(db, 'record_sources')).toBe(0);

      const audited = db
        .prepare(
          `SELECT json_extract(details, '$.reason') AS reason FROM audit_events WHERE type = 'sync.failed' AND target_type IS NOT NULL`,
        )
        .all();

      expect(audited).toEqual([{ reason }]);
    },
  );

  it('rejects a Bundle over the entry cap', async () => {
    const db = freshVault();
    const deps = {
      ...depsFor(db, [cardiology]),
      limits: { ...DEFAULT_LIMITS, maxEntriesPerFile: 2 },
    };
    const summary = await runSync(deps, OWNER);

    expect(summary.rejections[0]?.reason).toBe('too-many-entries');
  });

  it('rejects a download that fails, with no detail leaked', async () => {
    const db = freshVault();
    const deps = depsFor(db, [letter]);
    const failing = {
      ...deps,
      adapter: {
        ...deps.adapter,
        download: async () =>
          Promise.reject(new SourceAdapterError('http-status', 500)),
      },
    };
    const summary = await runSync(failing, OWNER);

    expect(summary.rejections[0]?.reason).toBe('fetch-failed');
  });

  it('lets one bad file fail while the good files still import', async () => {
    const db = freshVault();
    const bad = variant(letter, { id: '../x', name: 'x.txt' });
    const summary = await runSync(depsFor(db, [bad, cardiology]), OWNER);

    expect(summary).toMatchObject({
      status: 'partial',
      imported: 1,
      rejected: 1,
    });
    expect(count(db, 'records')).toBe(7);
  });

  it('never calls download for an id that is not numeric', async () => {
    const db = freshVault();
    const deps = depsFor(db, [variant(letter, { id: '1/../2' })]);
    const calls: string[] = [];
    const watched = {
      ...deps,
      adapter: {
        ...deps.adapter,
        metadata: async (id: string) => {
          calls.push(`metadata:${id}`);

          return deps.adapter.metadata(id);
        },
        download: async (id: string, max: number) => {
          calls.push(`download:${id}`);

          return deps.adapter.download(id, max);
        },
      },
    };

    await runSync(watched, OWNER);

    expect(calls).toEqual([]);
  });
});

describe('repository guards', () => {
  it('reports a record id already held by another file as a collision, writing nothing', () => {
    const db = freshVault();
    const record = [...CURATION.byDigest.values()][0]?.[0];

    if (!record) {
      throw new Error('fixture missing');
    }

    const file = (fileId: string, sha: string) => ({
      fileId,
      version: '1',
      sha256: sha.repeat(64).slice(0, 64),
      provider: 'Northgate Cardiology Clinic',
      verification: 'synthetic-provider' as const,
      records: [record],
    });

    db.prepare(
      `INSERT INTO sync_runs (id, patient_id, trigger, adapter, folder_id, status, started_at) VALUES ('r1', ?, 'test', 'fixture', '1', 'running', '2026-11-25T10:00:00.000Z')`,
    ).run(PATIENT);

    expect(
      recordImport(db, {
        patientId: PATIENT,
        syncRunId: 'r1',
        file: file('9100000013', 'a'),
      }).status,
    ).toBe('imported');
    expect(
      recordImport(db, {
        patientId: PATIENT,
        syncRunId: 'r1',
        file: file('9100000050', 'b'),
      }),
    ).toEqual({ status: 'collision', recordIds: [record.id] });
    expect(count(db, 'records')).toBe(1);
    expect(count(db, 'record_sources')).toBe(1);
    expect(count(db, 'record_conflicts')).toBe(0);
  });
});

describe('content the catalogue does not vouch for', () => {
  const smuggled = editedCardiology((b) => {
    b.entry.push({
      resource: {
        resourceType: 'Observation',
        id: 'smuggled-1',
        subject: { reference: `Patient/${PATIENT}` },
      },
    });
  });
  const mentalHealth = (): FixtureFile =>
    editedCardiology((b) => {
      const obs = b.entry.find((e) => e.resource.id === 'rec-obs-001');

      if (obs) {
        obs.resource.valueString = 'Patient reports severe depression.';
      }
    });

  it('stores a first-seen edited file as unclassified: a source row, no records', async () => {
    const db = freshVault();
    const summary = await runSync(depsFor(db, [smuggled]), OWNER);

    expect(summary.rejections).toEqual([
      { fileId: smuggled.id, reason: 'unclassified-content' },
    ]);
    expect(count(db, 'records')).toBe(0);
    expect(count(db, 'record_conflicts')).toBe(0);
    expect(
      db.prepare('SELECT provider, verification FROM record_sources').all(),
    ).toEqual([{ provider: 'unclassified', verification: 'unverified' }]);
  });

  it('never imports mental-health text under rec-obs-001 as cardiac', async () => {
    const db = freshVault();
    const edited = mentalHealth();
    const summary = await runSync(depsFor(db, [edited]), OWNER);

    expect(summary.rejections[0]?.reason).toBe('unclassified-content');
    expect(
      db.prepare("SELECT 1 FROM records WHERE category = 'cardiac'").all(),
    ).toEqual([]);
  });

  it('parks an edit of an imported file as an open conflict and leaves the record untouched', async () => {
    const db = freshVault();

    await runSync(depsFor(db, [cardiology]), OWNER);

    const before = db
      .prepare("SELECT * FROM records WHERE id = 'rec-obs-001'")
      .get();
    const edited = variant(mentalHealth(), { version: '2' });
    const summary = await runSync(depsFor(db, [edited]), OWNER);

    expect(summary.rejections[0]?.reason).toBe('version-conflict');
    expect(count(db, 'records')).toBe(7);
    expect(
      db.prepare("SELECT * FROM records WHERE id = 'rec-obs-001'").get(),
    ).toEqual(before);

    const open = listConflicts(db, PATIENT);

    expect(open.length).toBeGreaterThan(0);
    expect(open.map((c) => c.recordId)).toContain('rec-obs-001');
    expect(open.every((c) => c.incomingVersion === '2')).toBe(true);

    const incoming = JSON.parse(
      (
        db
          .prepare(
            "SELECT incoming_record AS r FROM record_conflicts WHERE record_id = 'rec-obs-001'",
          )
          .get() as { r: string }
      ).r,
    ) as { category: string; sensitivity: string };

    expect(incoming).toMatchObject({
      category: 'mental-health',
      sensitivity: 'restricted',
    });

    await runSync(depsFor(db, [edited]), OWNER);

    expect(count(db, 'record_conflicts')).toBe(open.length);
  });

  it('imports curated bytes under a new Box file id (live Box assigns its own ids)', async () => {
    const db = freshVault();
    const summary = await runSync(
      depsFor(db, [variant(letter, { id: '9100000098' })]),
      OWNER,
    );
    const digest = [...CURATION.byDigest.values()].find(
      (records) => records[0]?.source.boxFileId === letter.id,
    );

    expect(summary).toMatchObject({ imported: 1, rejected: 0 });
    expect(count(db, 'records')).toBe(digest?.length);
    expect(
      db.prepare('SELECT DISTINCT box_file_id AS id FROM record_sources').all(),
    ).toEqual([{ id: '9100000098' }]);
  });
});
