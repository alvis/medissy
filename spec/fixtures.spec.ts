import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { generateFixtures } from '../scripts/generate-fixtures';
import {
  SENSITIVITY_RANK,
  grantSchema,
  isRecordReleasable,
  recordEnvelopeSchema,
} from '../src/contracts';
import { openVault } from '../src/vault/migrate';

import type { RecordEnvelope, Sensitivity } from '../src/contracts';

const ROOT = join(import.meta.dirname, '..', 'fixtures', 'synthetic');
const DOCS = join(ROOT, 'source-docs');

interface SourceDocument {
  file: string;
  boxFileId: string;
  version: string;
  provider: string;
  format: 'json' | 'text';
  sha256: string;
  sizeBytes: number;
  verification: string;
  outcome: 'import' | 'reject';
  rejectReason?: string;
  recordIds: string[];
}

interface Manifest {
  label: string;
  sourceFileAccessRule: string;
  patientId: string;
  referenceDate: string;
  staleBefore: string;
  canary: string;
  providers: string[];
  selfEnteredSource: string;
  recordCount: number;
  recordIds: string[];
  groups: Record<
    'baseline' | 'cardiac' | 'dental' | 'unrelated' | 'restricted',
    string[]
  >;
  resourceTypes: Record<string, string[]>;
  canaryRecordIds: string[];
  canarySourceFiles: string[];
  stale: string[];
  incomplete: string[];
  conflicts: Array<{ topic: string; recordIds: string[] }>;
  patientEntered: string[];
  unverified: string[];
  injection: string[];
  foreignPatientFiles: string[];
  scenarios: Record<
    string,
    {
      grant: {
        categories: string[];
        allowBaseline: boolean;
        maxSensitivity: Sensitivity;
      } | null;
      visibleRecordIds: string[];
    }
  >;
  sourceDocuments: SourceDocument[];
}

type Envelope = RecordEnvelope;

const manifest = JSON.parse(
  readFileSync(join(ROOT, 'manifest.json'), 'utf8'),
) as Manifest;
const rawRecords = JSON.parse(
  readFileSync(join(ROOT, 'records.json'), 'utf8'),
) as unknown[];
const records = rawRecords.map((raw) => recordEnvelopeSchema.parse(raw));
const byId = new Map(records.map((record) => [record.id, record]));
const docText = (file: string): string =>
  readFileSync(join(DOCS, file), 'utf8');
const text = (value: unknown): string => JSON.stringify(value);
const ids = (items: readonly Envelope[]): string[] =>
  items.map((item) => item.id);

/**
 * collects every FHIR `reference` string inside a value
 * @param value any JSON value
 * @returns the reference strings found
 */
function referencesIn(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(referencesIn);
  }

  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, child]) =>
      key === 'reference' && typeof child === 'string'
        ? [child]
        : referencesIn(child),
    );
  }

  return [];
}

/**
 * computes the reference semantics the policy engine must apply, written independently
 * of the manifest so the manifest's scenarios are checked, not assumed
 * @param grant the scenario grant
 * @param grant.categories granted categories
 * @param grant.allowBaseline whether baseline is released
 * @param grant.maxSensitivity the sensitivity ceiling
 * @returns the ids of the records the grant covers
 */
function covered(grant: {
  categories: string[];
  allowBaseline: boolean;
  maxSensitivity: Sensitivity;
}): string[] {
  return records
    .filter(
      (record) =>
        (grant.categories.includes(record.category) ||
          (record.category === 'baseline' && grant.allowBaseline)) &&
        SENSITIVITY_RANK[record.sensitivity] <=
          SENSITIVITY_RANK[grant.maxSensitivity],
    )
    .map((record) => record.id);
}

describe('fixtures:records', () => {
  it('holds about thirty records that all validate as RecordEnvelope', () => {
    expect(rawRecords).toHaveLength(manifest.recordCount);
    expect(records.length).toBeGreaterThanOrEqual(20);
    expect(records.length).toBeLessThanOrEqual(40);
    expect(ids(records)).toEqual(manifest.recordIds);
    expect(new Set(ids(records)).size).toBe(records.length);
  });

  it('belongs to one fictional patient labelled SYNTHETIC everywhere', () => {
    expect(manifest.label).toBe('SYNTHETIC');
    expect(new Set(records.map((record) => record.patientId))).toEqual(
      new Set([manifest.patientId]),
    );

    for (const record of records) {
      const tags = (record.resource.meta as { tag: Array<{ code: string }> })
        .tag;

      expect(
        tags.map((tag) => tag.code),
        record.id,
      ).toContain('SYNTHETIC');
    }

    const patient = byId.get('rec-pat-001')?.resource as unknown as {
      id: string;
      name: Array<{ prefix: string[] }>;
    };

    expect(patient.id).toBe(manifest.patientId);
    expect(patient.name[0]?.prefix).toContain('SYNTHETIC');
  });

  it('covers all eight resource types exactly as the manifest lists them', () => {
    const derived: Record<string, string[]> = {};

    for (const record of records) {
      (derived[record.resourceType] ??= []).push(record.id);
    }

    expect(Object.keys(derived).sort()).toEqual([
      'AllergyIntolerance',
      'Condition',
      'DiagnosticReport',
      'DocumentReference',
      'MedicationStatement',
      'Observation',
      'Patient',
      'Provenance',
    ]);
    expect(derived).toEqual(manifest.resourceTypes);
  });

  it('gives each record the id of its resource', () => {
    for (const record of records) {
      expect(record.resource.id, record.id).toBe(
        record.resourceType === 'Patient' ? manifest.patientId : record.id,
      );
    }
  });
});

describe('fixtures:manifest categories', () => {
  it('lists the expected ids per group, matching category and sensitivity', () => {
    const derived = {
      baseline: ids(records.filter((record) => record.category === 'baseline')),
      cardiac: ids(records.filter((record) => record.category === 'cardiac')),
      dental: ids(records.filter((record) => record.category === 'dental')),
      unrelated: ids(
        records.filter((record) =>
          ['musculoskeletal', 'dermatology'].includes(record.category),
        ),
      ),
      restricted: ids(
        records.filter((record) => record.sensitivity === 'restricted'),
      ),
    };

    expect(derived).toEqual(manifest.groups);
  });

  it('partitions every record into exactly one group', () => {
    const all = Object.values(manifest.groups).flat();

    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...manifest.recordIds].sort());
  });

  it('keeps the routine groups routine and non-empty', () => {
    for (const group of [
      'baseline',
      'cardiac',
      'dental',
      'unrelated',
    ] as const) {
      expect(manifest.groups[group].length, group).toBeGreaterThan(0);
      expect(
        manifest.groups[group].every(
          (id) => byId.get(id)?.sensitivity === 'routine',
        ),
        group,
      ).toBe(true);
    }
  });
});

describe('fixtures:restricted records and the canary', () => {
  it('puts the canary in every restricted record and in no other record', () => {
    expect(manifest.canary).toBe('MEDISSY-CANARY-RESTRICTED');
    expect(manifest.canaryRecordIds).toEqual(manifest.groups.restricted);

    for (const record of records) {
      expect(text(record).includes(manifest.canary), record.id).toBe(
        record.sensitivity === 'restricted',
      );
    }
  });

  it('keeps the canary out of every source document except the restricted ones', () => {
    const withCanary = readdirSync(DOCS).filter((file) =>
      docText(file).includes(manifest.canary),
    );

    expect(withCanary.toSorted()).toEqual(
      manifest.canarySourceFiles.toSorted(),
    );
  });

  it('is referenced by no routine record, so references cannot leak it', () => {
    const restricted = new Set(manifest.groups.restricted);

    for (const record of records.filter(
      (item) => item.sensitivity === 'routine',
    )) {
      for (const reference of referencesIn(record.resource)) {
        const target = reference.split('/')[1] ?? '';

        expect(restricted.has(target), `${record.id} -> ${reference}`).toBe(
          false,
        );
      }
    }
  });

  it('spans more than one restricted category', () => {
    const categories = new Set(
      records
        .filter((record) => record.sensitivity === 'restricted')
        .map((record) => record.category),
    );

    expect(categories.size).toBeGreaterThan(1);
  });
});

describe('fixtures:consistency', () => {
  it('resolves every reference to the patient or to another record of the same type', () => {
    for (const record of records) {
      for (const reference of referencesIn(record.resource)) {
        const [type, id] = reference.split('/');

        if (type === 'Patient') {
          expect(id, `${record.id} -> ${reference}`).toBe(manifest.patientId);
        } else {
          expect(
            byId.get(id ?? '')?.resourceType,
            `${record.id} -> ${reference}`,
          ).toBe(type);
        }
      }
    }
  });

  it('orders dates: authored, then imported, then the reference date', () => {
    const end = Date.parse(`${manifest.referenceDate}T23:59:59Z`);

    for (const record of records) {
      const { authoredAt, importedAt } = record.source;
      const effective = (
        record.resource as unknown as { effectiveDateTime?: string }
      ).effectiveDateTime;

      expect(Date.parse(importedAt), record.id).toBeLessThanOrEqual(end);

      if (authoredAt) {
        expect(Date.parse(authoredAt), record.id).toBeLessThanOrEqual(
          Date.parse(importedAt),
        );
      }

      if (effective) {
        expect(Date.parse(effective), record.id).toBeLessThanOrEqual(
          Date.parse(importedAt),
        );
        expect(effective, record.id).toBe(authoredAt);
      }
    }
  });

  it('uses one unit per observation code', () => {
    const units = new Map<string, Set<string>>();

    for (const record of records.filter(
      (item) => item.resourceType === 'Observation',
    )) {
      const resource = record.resource as unknown as {
        code: { coding?: Array<{ code: string }> };
        valueQuantity?: { unit?: string };
        component?: Array<{
          code: { coding: Array<{ code: string }> };
          valueQuantity: { unit: string };
        }>;
      };
      const entries = [
        ...(resource.valueQuantity?.unit
          ? [
              [
                resource.code.coding?.[0]?.code ?? '',
                resource.valueQuantity.unit,
              ],
            ]
          : []),
        ...(resource.component ?? []).map((part) => [
          part.code.coding[0]?.code ?? '',
          part.valueQuantity.unit,
        ]),
      ];

      for (const [code = '', unit = ''] of entries) {
        units.set(code, (units.get(code) ?? new Set()).add(unit));
      }
    }

    expect(units.size).toBeGreaterThan(3);

    for (const [code, set] of units) {
      expect(set.size, code).toBe(1);
    }
  });

  it('marks stale observations by age against the reference date', () => {
    const stale = records
      .filter((record) => record.resourceType === 'Observation')
      .filter((record) => {
        const effective = (
          record.resource as unknown as { effectiveDateTime?: string }
        ).effectiveDateTime;

        return (
          effective !== undefined &&
          effective.slice(0, 10) < manifest.staleBefore
        );
      });

    expect(ids(stale)).toEqual(manifest.stale);
    expect(manifest.stale.length).toBeGreaterThan(1);
  });

  it('marks incomplete observations: no time, no unit, or data absent', () => {
    const incomplete = records
      .filter((record) => record.resourceType === 'Observation')
      .filter((record) => {
        const resource = record.resource as unknown as {
          effectiveDateTime?: string;
          dataAbsentReason?: unknown;
          valueQuantity?: { unit?: string };
        };

        return (
          resource.effectiveDateTime === undefined ||
          resource.dataAbsentReason !== undefined ||
          (resource.valueQuantity !== undefined &&
            resource.valueQuantity.unit === undefined)
        );
      });

    expect(ids(incomplete)).toEqual(manifest.incomplete);
    expect(manifest.incomplete.length).toBeGreaterThan(1);
  });

  it('preserves two conflicting active anticoagulant statements from different providers', () => {
    const [conflict] = manifest.conflicts;
    const pair = (conflict?.recordIds ?? []).map((id) => byId.get(id));

    expect(pair).toHaveLength(2);

    for (const record of pair) {
      expect(record?.resourceType).toBe('MedicationStatement');
      expect((record?.resource as unknown as { status: string }).status).toBe(
        'active',
      );
      expect(record?.status).toBe('current');
      expect(record?.category).toBe('baseline');
    }

    expect(pair[0]?.source.provider).not.toBe(pair[1]?.source.provider);
    expect(text(pair[0]?.resource)).toContain('apixaban');
    expect(text(pair[1]?.resource)).toContain('warfarin');
  });

  it('labels patient-entered and unverified provenance as the manifest says', () => {
    const verification = (kind: string): string[] =>
      ids(records.filter((record) => record.source.verification === kind));

    expect(verification('patient-entered')).toEqual(manifest.patientEntered);
    expect(verification('unverified')).toEqual(manifest.unverified);
  });
});

describe('fixtures:source documents', () => {
  const imported = manifest.sourceDocuments.filter(
    (doc) => doc.outcome === 'import',
  );

  it('matches the files on disk by digest and size, with unique box ids', () => {
    expect(readdirSync(DOCS).sort()).toEqual(
      manifest.sourceDocuments.map((doc) => doc.file).sort(),
    );
    expect(
      new Set(manifest.sourceDocuments.map((doc) => doc.boxFileId)).size,
    ).toBe(manifest.sourceDocuments.length);

    for (const doc of manifest.sourceDocuments) {
      const bytes = readFileSync(join(DOCS, doc.file));

      expect(createHash('sha256').update(bytes).digest('hex'), doc.file).toBe(
        doc.sha256,
      );
      expect(bytes.length, doc.file).toBe(doc.sizeBytes);
    }
  });

  it('comes from four fictional providers plus the patient, in both text and JSON', () => {
    const institutional = new Set(
      imported
        .map((doc) => doc.provider)
        .filter((name) => name !== manifest.selfEnteredSource),
    );

    expect([...institutional].sort()).toEqual([...manifest.providers].sort());
    expect(new Set(manifest.sourceDocuments.map((doc) => doc.format))).toEqual(
      new Set(['json', 'text']),
    );
  });

  it('agrees with every envelope on file id, version, digest and provider', () => {
    for (const record of records) {
      const doc = imported.find(
        (item) => item.boxFileId === record.source.boxFileId,
      );

      expect(doc, record.id).toBeDefined();
      expect(record.source.sha256, record.id).toBe(doc?.sha256);
      expect(record.source.version, record.id).toBe(doc?.version);
      expect(record.source.provider, record.id).toBe(doc?.provider);
      expect(doc?.recordIds, record.id).toContain(record.id);
    }

    expect(imported.flatMap((doc) => doc.recordIds).sort()).toEqual(
      [...manifest.recordIds].sort(),
    );
  });

  it('embeds each JSON record verbatim in its source bundle', () => {
    for (const doc of imported.filter((item) => item.format === 'json')) {
      const bundle = JSON.parse(docText(doc.file)) as {
        resourceType: string;
        type: string;
        entry: Array<{ resource: { id: string } }>;
      };

      expect(bundle.resourceType, doc.file).toBe('Bundle');
      expect(
        bundle.entry.map((entry) => entry.resource.id).sort(),
        doc.file,
      ).toEqual(doc.recordIds.map((id) => byId.get(id)?.resource.id).sort());

      for (const entry of bundle.entry) {
        const record = records.find(
          (item) => item.resource.id === entry.resource.id,
        );

        expect(entry.resource, `${doc.file} ${entry.resource.id}`).toEqual(
          record?.resource,
        );
      }
    }
  });

  it('sizes each DocumentReference attachment from its text document', () => {
    for (const record of records.filter(
      (item) => item.resourceType === 'DocumentReference',
    )) {
      const doc = imported.find(
        (item) => item.boxFileId === record.source.boxFileId,
      );
      const attachment = (
        record.resource as unknown as {
          content: Array<{ attachment: { size: number; title: string } }>;
        }
      ).content[0]?.attachment;

      expect(attachment?.size, record.id).toBe(doc?.sizeBytes);
      expect(attachment?.title, record.id).toBe(doc?.file);
    }
  });

  it('carries a malicious document that tells the reader to disclose everything', () => {
    const [injectionId] = manifest.injection;
    const record = byId.get(injectionId ?? '');
    const doc = imported.find(
      (item) => item.boxFileId === record?.source.boxFileId,
    );

    expect(manifest.injection).toHaveLength(1);
    expect(record?.category).toBe('dental');
    expect(record?.source.verification).toBe('unverified');
    expect(docText(doc?.file ?? '')).toMatch(
      /ignore all previous instructions/i,
    );
    expect(docText(doc?.file ?? '')).toMatch(/disclose ALL records/);
    expect(text(record?.resource)).toMatch(/disclose all records/i);

    for (const other of readdirSync(DOCS).filter(
      (file) => file !== doc?.file,
    )) {
      expect(docText(other), other).not.toMatch(
        /ignore all previous instructions/i,
      );
    }
  });

  it('carries a foreign-patient file that no record is imported from', () => {
    const rejected = manifest.sourceDocuments.filter(
      (doc) => doc.outcome === 'reject',
    );

    expect(rejected.map((doc) => doc.file)).toEqual(
      manifest.foreignPatientFiles,
    );
    expect(rejected[0]?.rejectReason).toBe('foreign-patient');
    expect(rejected[0]?.recordIds).toEqual([]);
    expect(
      records.some(
        (record) => record.source.boxFileId === rejected[0]?.boxFileId,
      ),
    ).toBe(false);

    const bundle = JSON.parse(docText(rejected[0]?.file ?? '')) as {
      entry: Array<{ resource: Record<string, unknown> }>;
    };
    const foreignIds = new Set(
      bundle.entry
        .map((entry) =>
          entry.resource.resourceType === 'Patient' ? entry.resource.id : '',
        )
        .filter(Boolean),
    );

    expect(foreignIds.size).toBe(1);
    expect(foreignIds.has(manifest.patientId)).toBe(false);

    const observation = bundle.entry.find(
      (entry) => entry.resource.resourceType === 'Observation',
    )?.resource;

    expect(text(observation)).not.toContain(manifest.patientId);

    const wrapped = {
      ...records[9],
      id: 'foreign-obs-001',
      resource: observation,
    };

    expect(recordEnvelopeSchema.safeParse(wrapped).success).toBe(false);
  });
});

describe('fixtures:scenarios', () => {
  it('lists what each demo grant covers under category and sensitivity intersection', () => {
    for (const [name, scenario] of Object.entries(manifest.scenarios)) {
      expect(scenario.visibleRecordIds, name).toEqual(
        scenario.grant ? covered(scenario.grant) : [],
      );
    }
  });

  it('gives cardiology and dentistry different evidence over a shared baseline and never the restricted set', () => {
    const cardiology = new Set(manifest.scenarios.cardiology?.visibleRecordIds);
    const dental = new Set(manifest.scenarios.dental?.visibleRecordIds);
    const shared = [...cardiology].filter((id) => dental.has(id));

    expect(shared.toSorted()).toEqual(manifest.groups.baseline.toSorted());

    for (const id of [...cardiology, ...dental]) {
      expect(manifest.groups.restricted, id).not.toContain(id);
      expect(manifest.groups.unrelated, id).not.toContain(id);
      expect(text(byId.get(id))).not.toContain(manifest.canary);
    }

    expect(manifest.scenarios.unauthorizedClinician?.visibleRecordIds).toEqual(
      [],
    );
  });
});

describe('fixtures:source file access', () => {
  /**
   * lists the source files a scenario may download: a file is served only when it
   * imported and every record in it is in scope
   * @param scenario the scenario name in the manifest
   * @returns the file names that may be downloaded
   */
  function downloadable(scenario: string): string[] {
    const visible = new Set(manifest.scenarios[scenario]?.visibleRecordIds);

    return manifest.sourceDocuments
      .filter(
        (doc) =>
          doc.outcome === 'import' &&
          doc.recordIds.length > 0 &&
          doc.recordIds.every((id) => visible.has(id)),
      )
      .map((doc) => doc.file);
  }

  it('states the rule: every record in a file must be in scope to download it', () => {
    expect(manifest.sourceFileAccessRule).toMatch(
      /only when every record imported from it is in scope/,
    );
    expect(manifest.sourceFileAccessRule).toMatch(/never served/);
  });

  it('never serves a restricted, mixed, rejected or out-of-scope file', () => {
    expect(downloadable('cardiology').toSorted()).toEqual([
      'northgate-cardiology-record.json',
      'northgate-clinic-letter-2026-10-20.txt',
      'northgate-ecg-report-2026-10-14.txt',
      'patient-home-bp-log.json',
    ]);

    // a file that holds some in-scope and some out-of-scope records is not served
    for (const mixed of [
      'harbourview-gp-summary.json',
      'riverside-dental-chart.json',
    ]) {
      const doc = manifest.sourceDocuments.find((d) => d.file === mixed);
      const visible = new Set(manifest.scenarios.cardiology?.visibleRecordIds);
      const inScope = doc?.recordIds.filter((id) => visible.has(id)) ?? [];

      expect(inScope.length, mixed).toBeGreaterThan(0);
      expect(inScope.length, mixed).toBeLessThan(doc?.recordIds.length ?? 0);
      expect(downloadable('cardiology')).not.toContain(mixed);
    }

    for (const scenario of Object.keys(manifest.scenarios)) {
      for (const file of downloadable(scenario)) {
        expect(
          manifest.canarySourceFiles,
          `${scenario}: ${file}`,
        ).not.toContain(file);
        expect(
          manifest.foreignPatientFiles,
          `${scenario}: ${file}`,
        ).not.toContain(file);
      }
    }

    expect(downloadable('unauthorizedClinician')).toEqual([]);
  });
});

describe('fixtures:scenarios agree with the contract predicate', () => {
  const caller = {
    issuer: 'https://idp.example.invalid/demo-idp',
    subject: 'clinician-1',
    organizationId: 'org-1',
    roles: ['clinician'],
  };
  const window = {
    validFrom: '2026-11-25T00:00:00Z',
    expiresAt: '2026-12-25T00:00:00Z',
  };

  it.each(['cardiology', 'dental'])(
    'releases exactly the %s scenario records under isRecordReleasable',
    (name) => {
      const scenario = manifest.scenarios[name];
      const grant = grantSchema.parse({
        id: `grant-${name}`,
        patientId: manifest.patientId,
        version: 1,
        effect: 'allow',
        grantee: { issuer: caller.issuer, subject: caller.subject },
        encounterId: 'enc-1',
        purpose: 'direct-treatment',
        ...scenario?.grant,
        ...window,
      });
      const released = records
        .filter((record) =>
          isRecordReleasable({
            grants: [grant],
            caller,
            encounter: { id: 'enc-1', purpose: 'direct-treatment' },
            now: new Date('2026-11-26T00:00:00Z'),
            record,
          }),
        )
        .map((record) => record.id);

      expect(released).toEqual(scenario?.visibleRecordIds);
    },
  );

  it('keeps every Provenance in the category and sensitivity of what it targets', () => {
    const provenance = records.filter(
      (record) => record.resourceType === 'Provenance',
    );

    expect(provenance.length).toBeGreaterThan(0);

    for (const record of provenance) {
      for (const reference of referencesIn(record.resource)) {
        const target = byId.get(reference.split('/')[1] ?? '');

        expect(target?.patientId, record.id).toBe(record.patientId);
        expect(target?.category, record.id).toBe(record.category);
        expect(target?.sensitivity, record.id).toBe(record.sensitivity);
      }
    }
  });
});

describe('fixtures:generator', () => {
  it('reproduces the committed fixtures byte for byte', () => {
    const dir = mkdtempSync(join(tmpdir(), 'medissy-fixtures-'));

    try {
      const result = generateFixtures(dir);

      expect(result).toEqual({
        records: manifest.recordCount,
        documents: manifest.sourceDocuments.length,
      });

      for (const file of ['records.json', 'manifest.json']) {
        expect(readFileSync(join(dir, file), 'utf8'), file).toBe(
          readFileSync(join(ROOT, file), 'utf8'),
        );
      }

      expect(readdirSync(join(dir, 'source-docs')).toSorted()).toEqual(
        readdirSync(DOCS).toSorted(),
      );

      for (const file of readdirSync(DOCS)) {
        expect(readFileSync(join(dir, 'source-docs', file), 'utf8'), file).toBe(
          docText(file),
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('fixtures:vault', () => {
  it('loads into the migrated schema and supports the policy filter query', () => {
    const db = openVault(':memory:');
    const iso = (value: string): string => new Date(value).toISOString();

    db.prepare(
      `INSERT INTO patient (id, label, owner_issuer, owner_subject, created_at) VALUES (?, 'SYNTHETIC Morgan Testwell', 'https://idp.example.invalid', 'owner', ?)`,
    ).run(manifest.patientId, iso('2026-11-24T08:00:00Z'));

    const sourceIds = new Map<string, number>();

    for (const record of records) {
      const { source } = record;
      const key = `${source.boxFileId}:${source.version}:${source.sha256}`;

      if (!sourceIds.has(key)) {
        const result = db
          .prepare(
            `INSERT INTO record_sources (patient_id, provider, box_file_id, version, sha256, verification, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            record.patientId,
            source.provider,
            source.boxFileId,
            source.version,
            source.sha256,
            source.verification,
            iso(source.importedAt),
          );

        sourceIds.set(key, Number(result.lastInsertRowid));
      }

      db.prepare(
        `INSERT INTO records (id, patient_id, source_id, resource_type, resource, category, sensitivity, status, authored_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id,
        record.patientId,
        sourceIds.get(key) ?? 0,
        record.resourceType,
        JSON.stringify(record.resource),
        record.category,
        record.sensitivity,
        record.status,
        source.authoredAt ? iso(source.authoredAt) : null,
      );
    }

    const visible = (category: string): string[] =>
      (
        db
          .prepare(
            `SELECT id FROM records WHERE patient_id = ? AND status = 'current' AND sensitivity = 'routine' AND category IN ('baseline', ?) ORDER BY rowid`,
          )
          .all(manifest.patientId, category) as Array<{ id: string }>
      ).map((row) => row.id);

    expect(db.prepare('SELECT COUNT(*) AS n FROM records').get()).toEqual({
      n: records.length,
    });
    expect(visible('cardiac').sort()).toEqual(
      [...(manifest.scenarios.cardiology?.visibleRecordIds ?? [])].sort(),
    );
    expect(visible('dental').sort()).toEqual(
      [...(manifest.scenarios.dental?.visibleRecordIds ?? [])].sort(),
    );
    db.close();
  });
});
