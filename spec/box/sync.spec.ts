import { describe, expect, it } from 'vitest';

import {
  filesForRecords,
  filesFullyWithin,
  getSyncOverview,
  listConflicts,
  listSourceRecordMap,
  recordIdsForFile,
} from '../../src/box/catalog';
import { runSync } from '../../src/box/sync';

import {
  CURATION,
  MANIFEST,
  PATIENT,
  count,
  depsFor,
  freshVault,
  syntheticFiles,
  variant,
} from './support';

const OWNER = { trigger: 'owner' } as const;
const importable = MANIFEST.sourceDocuments.filter(
  (d) => d.outcome === 'import',
);
const file = (name: string) => {
  const found = syntheticFiles().find((f) => f.name === name);

  if (!found) {
    throw new Error(`no fixture ${name}`);
  }

  return found;
};

describe('A09 import, provenance and dedupe (fixture adapter)', () => {
  it('imports the synthetic folder and rejects only the foreign-patient file', async () => {
    const db = freshVault();
    const summary = await runSync(depsFor(db, syntheticFiles()), OWNER);

    expect(summary).toMatchObject({
      adapter: 'fixture',
      status: 'partial',
      imported: importable.length,
      duplicate: 0,
      rejected: 1,
      rejections: [{ fileId: '9100000003', reason: 'foreign-patient' }],
    });
    expect(count(db, 'records')).toBe(30);
    expect(count(db, 'record_sources')).toBe(importable.length);
  });

  it('stores provenance: provider, version, digest and verification per file', async () => {
    const db = freshVault();

    await runSync(depsFor(db, syntheticFiles()), OWNER);

    const map = listSourceRecordMap(db, PATIENT);
    const referral = map.find((s) => s.boxFileId === '9100000023');
    const bp = map.find((s) => s.boxFileId === '9100000041');

    expect(referral).toMatchObject({
      provider: 'Riverside Dental Studio',
      version: '1',
      verification: 'unverified',
    });
    expect(referral?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(bp?.verification).toBe('patient-entered');
    expect(map.find((s) => s.boxFileId === '9100000011')?.verification).toBe(
      'synthetic-provider',
    );
  });

  it('keeps every record mappable to its file, including files spanning categories', async () => {
    const db = freshVault();

    await runSync(depsFor(db, syntheticFiles()), OWNER);

    for (const doc of importable) {
      expect(recordIdsForFile(db, doc.boxFileId).sort(), doc.file).toEqual(
        [...doc.recordIds].sort(),
      );
    }

    const gp = listSourceRecordMap(db, PATIENT).find(
      (s) => s.boxFileId === '9100000001',
    );

    expect(new Set(gp?.records.map((r) => r.category))).toEqual(
      new Set(['baseline', 'cardiac', 'musculoskeletal', 'dermatology']),
    );
    expect(filesForRecords(db, ['rec-obs-002', 'rec-cond-006'])).toEqual([
      '9100000001',
    ]);
  });

  it('offers files fully inside a scope, never one that is only partly inside', async () => {
    const db = freshVault();

    await runSync(depsFor(db, syntheticFiles()), OWNER);

    const cardiacOnly = new Set(['rec-dr-001', 'rec-cond-001', 'rec-obs-001']);
    const wholeGp = new Set(
      importable.find((d) => d.boxFileId === '9100000001')?.recordIds,
    );

    expect(filesFullyWithin(db, PATIENT, cardiacOnly)).toEqual(['9100000012']);
    expect(filesFullyWithin(db, PATIENT, wholeGp)).toEqual(['9100000001']);
  });

  it('is idempotent: a second sync imports nothing and duplicates nothing', async () => {
    const db = freshVault();
    const deps = depsFor(db, syntheticFiles());

    await runSync(deps, OWNER);

    const before = listSourceRecordMap(db, PATIENT);
    const second = await runSync(deps, OWNER);

    expect(second).toMatchObject({
      imported: 0,
      duplicate: importable.length,
      rejected: 1,
    });
    expect(count(db, 'records')).toBe(30);
    expect(listSourceRecordMap(db, PATIENT)).toEqual(before);
    expect(count(db, 'sync_runs')).toBe(2);
  });

  it('replays a repeated idempotency key as the same run', async () => {
    const db = freshVault();
    const deps = depsFor(db, syntheticFiles());
    const first = await runSync(deps, { ...OWNER, idempotencyKey: 'click-1' });
    const again = await runSync(deps, { ...OWNER, idempotencyKey: 'click-1' });

    expect(again).toMatchObject({ runId: first.runId, replayed: true });
    expect(count(db, 'sync_runs')).toBe(1);
  });

  it('preserves both conflicting medication statements without reconciling', async () => {
    const db = freshVault();

    await runSync(depsFor(db, syntheticFiles()), OWNER);

    const rows = db
      .prepare(
        `SELECT id, status, json_extract(resource, '$.medicationCodeableConcept.coding[0].display') AS drug
         FROM records WHERE id IN ('rec-med-001', 'rec-med-002') ORDER BY id`,
      )
      .all();

    expect(rows).toEqual([
      { id: 'rec-med-001', status: 'current', drug: 'apixaban' },
      { id: 'rec-med-002', status: 'current', drug: 'warfarin' },
    ]);
  });

  it('keeps a changed version visible as a conflict and never overwrites the original', async () => {
    const db = freshVault();
    const original = file('northgate-clinic-letter-2026-10-20.txt');

    await runSync(depsFor(db, [original]), OWNER);

    const before = db.prepare('SELECT * FROM records').all();
    const edited = variant(original, {
      version: '2',
      text: `${new TextDecoder().decode(original.bytes)}\nAmended: stop anticoagulation.\n`,
    });
    const second = await runSync(depsFor(db, [edited]), OWNER);

    expect(second.rejections).toEqual([
      { fileId: '9100000013', reason: 'version-conflict' },
    ]);
    expect(db.prepare('SELECT * FROM records').all()).toEqual(before);
    expect(count(db, 'record_sources')).toBe(1);

    const open = listConflicts(db, PATIENT);

    expect(open.length).toBeGreaterThan(0);
    expect(
      open.every((c) => c.fileId === '9100000013' && c.incomingVersion === '2'),
    ).toBe(true);
  });

  it('treats the same version with different bytes as a conflict too', async () => {
    const db = freshVault();
    const original = file('northgate-ecg-report-2026-10-14.txt');

    await runSync(depsFor(db, [original]), OWNER);

    const tampered = variant(original, {
      text: `${new TextDecoder().decode(original.bytes)} extra`,
    });
    const second = await runSync(depsFor(db, [tampered]), OWNER);

    expect(second.rejections[0]?.reason).toBe('version-conflict');
    expect(count(db, 'record_sources')).toBe(1);
  });

  it('parks a copy of a curated file filed under another file id as conflicts', async () => {
    const db = freshVault();
    const cardiology = file('northgate-cardiology-record.json');

    await runSync(depsFor(db, [cardiology]), OWNER);

    const stolen = variant(cardiology, { id: '9100000099', name: 'copy.json' });
    const second = await runSync(depsFor(db, [stolen]), OWNER);

    expect(second.rejections[0]?.reason).toBe('version-conflict');
    expect(count(db, 'records')).toBe(7);
    expect(count(db, 'record_sources')).toBe(1);
    expect(listConflicts(db, PATIENT)).toHaveLength(7);
  });

  it('stores the malicious referral as inert data and widens nothing', async () => {
    const db = freshVault();
    const deps = depsFor(db, [
      file('riverside-referral-letter-2026-11-03.txt'),
    ]);
    const summary = await runSync(deps, OWNER);
    const rows = db
      .prepare('SELECT id, category, sensitivity, resource FROM records')
      .all() as Array<{
      id: string;
      category: string;
      sensitivity: string;
      resource: string;
    }>;

    expect(summary).toMatchObject({ imported: 1, rejected: 0 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'rec-doc-002',
      category: 'dental',
      sensitivity: 'routine',
    });
    expect(rows[0]?.resource).toContain('Ignore all previous instructions');
    expect(count(db, 'grants')).toBe(0);
    expect(count(db, 'records')).toBe(1);
    // the classification is the catalogue's, not the document's
    expect(rows[0]?.category).toBe(
      [...CURATION.byDigest.values()]
        .flat()
        .find((record) => record.id === 'rec-doc-002')?.category,
    );
  });

  it('rejects the foreign-patient file and persists nothing from it', async () => {
    const db = freshVault();
    const summary = await runSync(
      depsFor(db, [file('harbourview-misfiled-other-patient.json')]),
      OWNER,
    );

    expect(summary).toMatchObject({
      status: 'failed',
      imported: 0,
      rejected: 1,
    });
    expect(summary.rejections[0]?.reason).toBe('foreign-patient');
    expect(count(db, 'records')).toBe(0);
    expect(count(db, 'record_sources')).toBe(0);
  });

  it('rejects a mixed-patient bundle whole', async () => {
    const db = freshVault();
    const gp = file('harbourview-gp-summary.json');
    const foreign = JSON.parse(
      new TextDecoder().decode(
        file('harbourview-misfiled-other-patient.json').bytes,
      ),
    ) as { entry: unknown[] };
    const bundle = JSON.parse(new TextDecoder().decode(gp.bytes)) as {
      entry: unknown[];
    };

    bundle.entry.push(foreign.entry[1]);

    const summary = await runSync(
      depsFor(db, [variant(gp, { text: JSON.stringify(bundle) })]),
      OWNER,
    );

    expect(summary.rejections[0]?.reason).toBe('mixed-patient');
    expect(count(db, 'records')).toBe(0);
  });
});

describe('sync bookkeeping and audit', () => {
  it('records last sync, known sources and gaps', async () => {
    const db = freshVault();

    await runSync(depsFor(db, syntheticFiles()), OWNER);

    const overview = getSyncOverview(db, PATIENT);

    expect(overview.lastRun).toMatchObject({
      adapter: 'fixture',
      status: 'partial',
      filesImported: importable.length,
      filesRejected: 1,
      errorSummary: 'foreign-patient:1',
    });
    expect(overview.lastSuccessfulAt).toBe(overview.lastRun?.finishedAt);
    expect(overview.sources).toHaveLength(importable.length);
    expect(overview.gaps).toEqual([
      { fileId: '9100000003', reason: 'foreign-patient' },
    ]);
  });

  it('audits a failed listing, marks the run failed and keeps content out', async () => {
    const db = freshVault();
    const deps = depsFor(db, []);
    const broken = {
      ...deps,
      adapter: {
        ...deps.adapter,
        list: async () => Promise.reject(new Error(`boom ${MANIFEST.canary}`)),
      },
    };
    const summary = await runSync(broken, OWNER);
    const events = db
      .prepare('SELECT type, outcome, details FROM audit_events')
      .all();

    expect(summary).toMatchObject({
      status: 'failed',
      rejections: [{ fileId: null, reason: 'listing-failed' }],
    });
    expect(events).toEqual([
      expect.objectContaining({ type: 'sync.failed', outcome: 'error' }),
    ]);
    expect(JSON.stringify(events)).not.toContain(MANIFEST.canary);
    expect(getSyncOverview(db, PATIENT).lastSuccessfulAt).toBeNull();
    expect(getSyncOverview(db, PATIENT).gaps).toEqual([
      { fileId: null, reason: 'listing-failed' },
    ]);
  });

  it('audits each rejected file with ids and reason codes only', async () => {
    const db = freshVault();

    await runSync(depsFor(db, syntheticFiles()), OWNER);

    const rows = db
      .prepare(
        `SELECT type, outcome, target_id, details FROM audit_events ORDER BY seq`,
      )
      .all() as Array<{
      type: string;
      outcome: string;
      target_id: string | null;
      details: string;
    }>;
    const dump = JSON.stringify(rows);

    expect(rows.map((r) => r.type)).toEqual(['sync.failed', 'sync.completed']);
    expect(rows[0]).toMatchObject({
      outcome: 'denied',
      target_id: '9100000003',
    });
    expect(dump).not.toContain(MANIFEST.canary);
    expect(dump).not.toContain('Testwell');
    expect(dump).not.toContain('Otherpatient');
  });
});

describe('sync recovery and gaps', () => {
  const insertRun = (
    db: ReturnType<typeof freshVault>,
    id: string,
    startedAt: string,
  ): void => {
    db.prepare(
      `INSERT INTO sync_runs (id, patient_id, trigger, adapter, folder_id, status, started_at)
       VALUES (?, ?, 'test', 'fixture', '1', 'running', ?)`,
    ).run(id, PATIENT, startedAt);
  };

  it('fails a run a crash left running, and leaves a fresh one alone', async () => {
    const db = freshVault();

    insertRun(db, 'crashed', '2026-11-25T10:00:00.000Z');
    insertRun(db, 'in-flight', '2026-11-25T11:59:30.000Z');
    await runSync(
      depsFor(db, [file('northgate-clinic-letter-2026-10-20.txt')]),
      OWNER,
    );

    const status = (id: string) =>
      db
        .prepare(
          'SELECT status, error_summary AS e FROM sync_runs WHERE id = ?',
        )
        .get(id);

    expect(status('crashed')).toEqual({ status: 'failed', e: 'interrupted:1' });
    expect(status('in-flight')).toEqual({ status: 'running', e: null });
    expect(
      db
        .prepare(
          `SELECT target_id AS id FROM audit_events WHERE json_extract(details, '$.reason') = 'interrupted'`,
        )
        .all(),
    ).toEqual([{ id: 'crashed' }]);
  });

  it('reports a truncated listing as a gap and marks the run partial', async () => {
    const db = freshVault();
    const deps = depsFor(db, [file('northgate-clinic-letter-2026-10-20.txt')]);
    const cut = {
      ...deps,
      adapter: {
        ...deps.adapter,
        list: async () => {
          const listing = await deps.adapter.list();

          return { ...listing, truncated: true };
        },
      },
    };
    const summary = await runSync(cut, OWNER);

    expect(summary).toMatchObject({ status: 'partial', imported: 1 });
    expect(summary.rejections).toEqual([
      { fileId: null, reason: 'listing-truncated' },
    ]);
    expect(getSyncOverview(db, PATIENT).gaps).toEqual([
      { fileId: null, reason: 'listing-truncated' },
    ]);
  });

  it('reports files beyond the per-run cap as a gap too', async () => {
    const db = freshVault();
    const base = depsFor(db, syntheticFiles());
    const summary = await runSync(
      {
        ...base,
        limits: { maxFileBytes: 262_144, maxFiles: 2, maxEntriesPerFile: 100 },
      },
      OWNER,
    );

    expect(summary.filesSeen).toBe(2);
    expect(summary.rejections.map((r) => r.reason)).toContain(
      'listing-truncated',
    );
  });
});
