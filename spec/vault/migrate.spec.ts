import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AUDIT_EVENT_TYPES } from '../../src/contracts/audit';
import {
  MigrationError,
  defaultMigrationsDir,
  loadMigrations,
  migrate,
  openVault,
} from '../../src/vault/migrate';

const PATIENT = 'p-1';
const ISSUER = 'https://idp.example.invalid/demo-idp';
const T1 = '2026-11-25T10:00:00.000Z';
const T2 = '2026-12-25T10:00:00.000Z';

const EXPECTED_TABLES = [
  'a2a_tasks',
  'audit_events',
  'clinicians',
  'connections',
  'encounters',
  'grants',
  'idp_store',
  'inbound_submissions',
  'invitations',
  'patient',
  'pending_signins',
  'receipt_records',
  'receipts',
  'record_conflicts',
  'record_sources',
  'records',
  'schema_migrations',
  'scope_requests',
  'sync_runs',
  'trusted_issuers',
  'unsigned_requests',
];

/**
 * runs one statement with named-free positional parameters
 * @param db the database
 * @param sql the statement
 * @param params positional parameters
 */
function run(
  db: DatabaseSync,
  sql: string,
  ...params: Array<string | number | null>
): void {
  db.prepare(sql).run(...params);
}

/**
 * inserts the minimum rows other tables point at
 * @param db a migrated database
 */
function seedBase(db: DatabaseSync): void {
  run(
    db,
    `INSERT INTO patient (id, label, owner_issuer, owner_subject, created_at) VALUES (?, 'SYNTHETIC Test', ?, 'owner-1', ?)`,
    PATIENT,
    ISSUER,
    T1,
  );
  run(
    db,
    `INSERT INTO trusted_issuers (issuer, label, audience, allowed_algs, created_at) VALUES (?, 'demo', 'https://medissy.example.invalid', '["ES256"]', ?)`,
    ISSUER,
    T1,
  );
  run(
    db,
    `INSERT INTO encounters (id, patient_id, purpose, clinician_issuer, clinician_subject, starts_at, ends_at, status, created_by_issuer, created_by_subject, created_at)
           VALUES ('enc-1', ?, 'direct-treatment', ?, 'cardiologist-1', ?, ?, 'planned', ?, 'owner-1', ?)`,
    PATIENT,
    ISSUER,
    T1,
    T2,
    ISSUER,
    T1,
  );
}

/**
 * inserts a grant version
 * @param db a seeded database
 * @param version the version number
 * @param revokedAt revocation time for this version
 */
function insertGrant(
  db: DatabaseSync,
  version: number,
  revokedAt: string | null = null,
): void {
  run(
    db,
    `INSERT INTO grants (id, version, patient_id, effect, grantee_issuer, grantee_subject, encounter_id, purpose, categories, max_sensitivity, allow_baseline, valid_from, expires_at, revoked_at, source, created_by_issuer, created_by_subject, created_at)
           VALUES ('grant-1', ?, ?, 'allow', ?, 'cardiologist-1', 'enc-1', 'direct-treatment', '["cardiac"]', 'routine', 1, ?, ?, ?, 'owner', ?, 'owner-1', ?)`,
    version,
    PATIENT,
    ISSUER,
    T1,
    T2,
    revokedAt,
    ISSUER,
    T1,
  );
}

/**
 * inserts an audit event
 * @param db a seeded database
 * @param id the event id
 */
function insertAudit(db: DatabaseSync, id: string): void {
  run(
    db,
    `INSERT INTO audit_events (id, occurred_at, type, outcome, actor_kind, patient_id) VALUES (?, ?, 'disclosure.denied', 'denied', 'system', ?)`,
    id,
    T1,
    PATIENT,
  );
}

/**
 * inserts the source and record a release can point at
 * @param db a seeded database
 */
function seedRecord(db: DatabaseSync): void {
  run(
    db,
    `INSERT INTO record_sources (id, patient_id, provider, box_file_id, version, sha256, verification, imported_at) VALUES (1, ?, 'Northgate', '9100000011', '1', ?, 'synthetic-provider', ?)`,
    PATIENT,
    'c'.repeat(64),
    T1,
  );
  run(
    db,
    `INSERT INTO records (id, patient_id, source_id, resource_type, resource, category, sensitivity) VALUES ('rec-1', ?, 1, 'Observation', '{"resourceType":"Observation","id":"rec-1"}', 'cardiac', 'routine')`,
    PATIENT,
  );
}

/**
 * inserts a receipt and, for a release, its one released-record row
 * @param db a seeded database with a record and a grant
 * @param receipt the receipt to insert
 * @param receipt.id primary key of the inserted row
 * @param receipt.requestId the request correlation id
 * @param receipt.decision whether the receipt records a release or a denial
 */
function insertReceipt(
  db: DatabaseSync,
  receipt: { id: string; requestId: string; decision: 'released' | 'denied' },
): void {
  const { id, requestId, decision } = receipt;
  const released = decision === 'released';

  run(
    db,
    `INSERT INTO receipts (id, patient_id, issued_at, request_id, requester_issuer, requester_subject, encounter_id, purpose, policy_version, approved_categories, released_count, decision, rationale_code)
           VALUES (?, ?, ?, ?, ?, 'cardiologist-1', 'enc-1', 'direct-treatment', 'policy-1', '["cardiac"]', ?, ?, 'granted')`,
    id,
    PATIENT,
    T1,
    requestId,
    ISSUER,
    released ? 1 : 0,
    decision,
  );

  if (released) {
    run(
      db,
      `INSERT INTO receipt_records (receipt_id, record_id, source_version, grant_id, grant_version) VALUES (?, 'rec-1', '1', 'grant-1', 1)`,
      id,
    );
  }
}

describe('fn:migrate', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = openVault(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('applies every numbered migration to a fresh in-memory database', () => {
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);

    expect(tables).toEqual(EXPECTED_TABLES);
    expect(loadMigrations()).toHaveLength(11);
  });

  it('records each migration once with its checksum and is idempotent', () => {
    const before = db
      .prepare(
        'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
      )
      .all();
    const again = migrate(db);
    const after = db
      .prepare(
        'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
      )
      .all();

    expect(again).toEqual({ applied: [], current: 11 });
    expect(after).toEqual(before);
    expect(before).toHaveLength(11);
  });

  it('enforces foreign keys on the connection', () => {
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({
      foreign_keys: 1,
    });
    expect(() =>
      run(
        db,
        `INSERT INTO encounters (id, patient_id, purpose, organization_id, starts_at, ends_at, status, created_by_issuer, created_by_subject, created_at) VALUES ('e', 'missing', 'direct-treatment', 'org', ?, ?, 'planned', 'i', 's', ?)`,
        T1,
        T2,
        T1,
      ),
    ).toThrow(/FOREIGN KEY/);
  });

  it('rejects an applied migration whose file was edited', () => {
    const edited = loadMigrations().map((migration, index) =>
      index === 0 ? { ...migration, checksum: 'f'.repeat(64) } : migration,
    );

    expect(() => migrate(db, { migrations: edited })).toThrow(
      /edited after it ran/,
    );
  });

  it('rejects a database that is newer than the code', () => {
    const older = loadMigrations().slice(0, 5);

    expect(() => migrate(db, { migrations: older })).toThrow(
      /newer than this code/,
    );
  });

  it('rolls back a failing migration completely', () => {
    const fresh = new DatabaseSync(':memory:');
    const [first] = loadMigrations();
    const broken = {
      version: 2,
      name: 'broken',
      sql: 'CREATE TABLE half_done (id INTEGER); SELECT * FROM missing_table;',
      checksum: 'b'.repeat(64),
    };

    expect(() =>
      migrate(fresh, { migrations: [first as never, broken] }),
    ).toThrow(MigrationError);
    expect(
      fresh
        .prepare("SELECT name FROM sqlite_master WHERE name = 'half_done'")
        .get(),
    ).toBeUndefined();
    expect(
      fresh.prepare('SELECT MAX(version) AS v FROM schema_migrations').get(),
    ).toEqual({ v: 1 });
    fresh.close();
  });

  it('persists to a file database and reopens without reapplying', () => {
    const dir = mkdtempSync(join(tmpdir(), 'medissy-vault-'));
    const path = join(dir, 'vault.sqlite');

    try {
      openVault(path).close();
      const reopened = openVault(path);

      expect(
        reopened.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get(),
      ).toEqual({ n: 11 });
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('fn:loadMigrations', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'medissy-migrations-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the repository migrations in order', () => {
    const files = readdirSync(defaultMigrationsDir()).filter((file) =>
      file.endsWith('.sql'),
    );

    expect(loadMigrations().map((migration) => migration.version)).toEqual(
      files.map((_file, index) => index + 1),
    );
  });

  it('rejects a gap in the numbering', () => {
    writeFileSync(join(dir, '0001_a.sql'), 'SELECT 1;');
    writeFileSync(join(dir, '0003_c.sql'), 'SELECT 1;');

    expect(() => loadMigrations(dir)).toThrow(/without gaps/);
  });

  it('rejects a misnamed sql file and ignores other files', () => {
    mkdirSync(join(dir, 'nested'));
    writeFileSync(join(dir, 'notes.txt'), 'ignored');
    writeFileSync(join(dir, 'init.sql'), 'SELECT 1;');

    expect(() => loadMigrations(dir)).toThrow(/NNNN_name\.sql/);
  });
});

describe('sql:audit_events', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = openVault(':memory:');
    seedBase(db);
    insertAudit(db, 'evt-1');
  });

  afterEach(() => {
    db.close();
  });

  it('accepts appends', () => {
    insertAudit(db, 'evt-2');

    expect(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get()).toEqual({
      n: 2,
    });
  });

  it('blocks UPDATE', () => {
    expect(() =>
      run(db, `UPDATE audit_events SET outcome = 'success' WHERE id = 'evt-1'`),
    ).toThrow(/append-only/);
  });

  it('blocks DELETE of one row and of the whole table', () => {
    expect(() =>
      run(db, `DELETE FROM audit_events WHERE id = 'evt-1'`),
    ).toThrow(/append-only/);
    expect(() => run(db, 'DELETE FROM audit_events')).toThrow(/append-only/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get()).toEqual({
      n: 1,
    });
  });

  it('blocks REPLACE over an existing id, with or without recursive triggers', () => {
    const replace = (): void =>
      run(
        db,
        `INSERT OR REPLACE INTO audit_events (id, occurred_at, type, outcome, actor_kind) VALUES ('evt-1', ?, 'x', 'success', 'system')`,
        T1,
      );

    expect(replace).toThrow(/append-only/);
    db.exec('PRAGMA recursive_triggers = OFF');
    expect(replace).toThrow(/append-only/);
    expect(
      db.prepare(`SELECT type FROM audit_events WHERE id = 'evt-1'`).get(),
    ).toEqual({ type: 'disclosure.denied' });
  });

  it('accepts exactly the closed set of audit event types', () => {
    AUDIT_EVENT_TYPES.forEach((type, index) => {
      run(
        db,
        `INSERT INTO audit_events (id, occurred_at, type, outcome, actor_kind) VALUES (?, ?, ?, 'success', 'system')`,
        `evt-type-${index}`,
        T1,
        type,
      );
    });

    for (const bad of [
      'disclosure',
      'Disclosure.Released',
      'x'.repeat(40),
      '',
    ]) {
      expect(() =>
        run(
          db,
          `INSERT INTO audit_events (id, occurred_at, type, outcome, actor_kind) VALUES ('evt-bad', ?, ?, 'success', 'system')`,
          T1,
          bad,
        ),
      ).toThrow(/CHECK/);
    }
  });

  it('requires identity exactly for owner and clinician actors', () => {
    expect(() =>
      run(
        db,
        `INSERT INTO audit_events (id, occurred_at, type, outcome, actor_kind) VALUES ('evt-3', ?, 'x', 'success', 'clinician')`,
        T1,
      ),
    ).toThrow(/CHECK/);
  });
});

describe('sql:receipts', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = openVault(':memory:');
    seedBase(db);
    seedRecord(db);
    insertGrant(db, 1);
    insertReceipt(db, {
      id: 'rcpt-1',
      requestId: 'req-1',
      decision: 'released',
    });
  });

  afterEach(() => {
    db.close();
  });

  /**
   * inserts a released receipt with room for one record, without its row
   * @param id the primary key of the new receipt
   * @param decision released, or denied for a receipt that releases nothing
   * @param count how many released records the receipt promises
   */
  function insertBareReceipt(
    id: string,
    decision: 'released' | 'denied',
    count: number,
  ): void {
    run(
      db,
      `INSERT INTO receipts (id, patient_id, issued_at, request_id, requester_issuer, requester_subject, encounter_id, purpose, policy_version, released_count, decision, rationale_code)
             VALUES (?, ?, ?, ?, ?, 's', 'enc-1', 'direct-treatment', 'p', ?, ?, 'granted')`,
      id,
      PATIENT,
      T1,
      `req-${id}`,
      ISSUER,
      count,
      decision,
    );
  }

  /**
   * adds a row to a receipt
   * @param receiptId the receipt that gains a row
   * @param grantId the cited grant
   * @param grantVersion the cited grant version
   */
  function addRecord(
    receiptId: string,
    grantId: string,
    grantVersion: number,
  ): void {
    run(
      db,
      `INSERT INTO receipt_records (receipt_id, record_id, source_version, grant_id, grant_version) VALUES (?, 'rec-1', '1', ?, ?)`,
      receiptId,
      grantId,
      grantVersion,
    );
  }

  it('accepts a lower-case hex SHA-256 request digest or none, and refuses anything else', () => {
    const withDigest = (id: string, digest: string | null): void => {
      run(
        db,
        `INSERT INTO receipts (id, patient_id, issued_at, request_id, requester_issuer, requester_subject, encounter_id, purpose, policy_version, decision, rationale_code, request_digest)
         VALUES (?, ?, ?, ?, ?, 's', 'enc-1', 'direct-treatment', 'p', 'denied', 'no-grant', ?)`,
        id,
        PATIENT,
        T1,
        `req-${id}`,
        ISSUER,
        digest,
      );
    };

    withDigest('rcpt-hex', 'a'.repeat(64));
    withDigest('rcpt-none', null);

    expect(() => withDigest('rcpt-upper', 'A'.repeat(64))).toThrow(
      /CHECK constraint/,
    );
    expect(() => withDigest('rcpt-short', 'a'.repeat(63))).toThrow(
      /CHECK constraint/,
    );
    expect(() => withDigest('rcpt-text', `${'a'.repeat(60)}why?`)).toThrow(
      /CHECK constraint/,
    );
  });

  it('is append-only', () => {
    expect(() =>
      run(db, `UPDATE receipts SET decision = 'denied' WHERE id = 'rcpt-1'`),
    ).toThrow(/append-only/);
    expect(() => run(db, 'DELETE FROM receipts')).toThrow(/append-only/);
  });

  it('refuses a second receipt for the same requester and request id', () => {
    expect(() =>
      insertReceipt(db, {
        id: 'rcpt-2',
        requestId: 'req-1',
        decision: 'released',
      }),
    ).toThrow(/already exists/);
    insertReceipt(db, { id: 'rcpt-3', requestId: 'req-2', decision: 'denied' });
  });

  it('refuses INSERT OR REPLACE over an existing receipt, with or without recursive triggers', () => {
    db.exec('PRAGMA recursive_triggers = OFF');

    expect(() =>
      run(
        db,
        `INSERT OR REPLACE INTO receipts (id, patient_id, issued_at, request_id, requester_issuer, requester_subject, encounter_id, purpose, policy_version, decision, rationale_code)
      VALUES ('rcpt-1', ?, ?, 'req-9', ?, 's', 'enc-1', 'direct-treatment', 'p', 'denied', 'no-grant')`,
        PATIENT,
        T1,
        ISSUER,
      ),
    ).toThrow(/already exists/);
    expect(
      db.prepare(`SELECT decision FROM receipts WHERE id = 'rcpt-1'`).get(),
    ).toEqual({ decision: 'released' });
  });

  it('keeps one row per released record with its grant version, and refuses REPLACE, UPDATE and DELETE', () => {
    db.exec('PRAGMA recursive_triggers = OFF');

    expect(
      db
        .prepare(
          `SELECT record_id, grant_id, grant_version FROM receipt_records WHERE receipt_id = 'rcpt-1'`,
        )
        .all(),
    ).toEqual([{ record_id: 'rec-1', grant_id: 'grant-1', grant_version: 1 }]);
    expect(() =>
      run(
        db,
        `INSERT OR REPLACE INTO receipt_records (receipt_id, record_id, source_version, grant_id, grant_version) VALUES ('rcpt-1', 'rec-1', '9', 'grant-1', 1)`,
      ),
    ).toThrow(/already (on the receipt|lists all)/);
    expect(() =>
      run(db, `UPDATE receipt_records SET source_version = '2'`),
    ).toThrow(/append-only/);
    expect(() => run(db, 'DELETE FROM receipt_records')).toThrow(/append-only/);
    expect(
      db.prepare('SELECT * FROM receipt_release_mismatches').all(),
    ).toEqual([]);
  });

  it('refuses a release with no records and a denial that lists records', () => {
    expect(() => insertBareReceipt('r-none', 'released', 0)).toThrow(/CHECK/);
    expect(() => insertBareReceipt('r-deny', 'denied', 1)).toThrow(/CHECK/);

    insertBareReceipt('r-deny', 'denied', 0);

    expect(() => addRecord('r-deny', 'grant-1', 1)).toThrow(/not a release/);
  });

  it('refuses more rows than the receipt promised and reports a short receipt', () => {
    insertBareReceipt('r-two', 'released', 2);
    addRecord('r-two', 'grant-1', 1);

    expect(
      db.prepare('SELECT * FROM receipt_release_mismatches').all(),
    ).toEqual([{ receipt_id: 'r-two', released_count: 2, recorded: 1 }]);
    expect(() => addRecord('rcpt-1', 'grant-1', 1)).toThrow(/already/);
  });

  it('refuses a row citing a grant version that does not exist', () => {
    insertBareReceipt('r-nov', 'released', 1);

    expect(() => addRecord('r-nov', 'grant-1', 9)).toThrow(/latest unrevoked/);
    expect(() => addRecord('r-nov', 'no-such-grant', 1)).toThrow(
      /latest unrevoked/,
    );
  });

  it('refuses a row citing a grant version that is no longer the latest', () => {
    insertGrant(db, 2);
    insertBareReceipt('r-old', 'released', 1);

    expect(() => addRecord('r-old', 'grant-1', 1)).toThrow(/latest unrevoked/);
    addRecord('r-old', 'grant-1', 2);
  });

  it('refuses a row citing a revoked grant version', () => {
    insertGrant(db, 2, T1);
    insertBareReceipt('r-rev', 'released', 1);

    expect(() => addRecord('r-rev', 'grant-1', 2)).toThrow(/latest unrevoked/);
  });

  it('refuses a row citing a deny grant', () => {
    run(
      db,
      `INSERT INTO grants (id, version, patient_id, effect, grantee_issuer, grantee_subject, encounter_id, purpose, categories, max_sensitivity, allow_baseline, valid_from, expires_at, source, created_by_issuer, created_by_subject, created_at)
             VALUES ('grant-deny', 1, ?, 'deny', ?, 'cardiologist-1', 'enc-1', 'direct-treatment', '["cardiac"]', 'restricted', 0, ?, ?, 'owner', ?, 'o', ?)`,
      PATIENT,
      ISSUER,
      T1,
      T2,
      ISSUER,
      T1,
    );
    insertBareReceipt('r-den', 'released', 1);

    expect(() => addRecord('r-den', 'grant-deny', 1)).toThrow(
      /latest unrevoked allow/,
    );
  });

  it('refuses a row citing a grant outside its window or for another encounter', () => {
    run(
      db,
      `INSERT INTO encounters (id, patient_id, purpose, clinician_issuer, clinician_subject, starts_at, ends_at, status, created_by_issuer, created_by_subject, created_at)
             VALUES ('enc-2', ?, 'direct-treatment', ?, 'cardiologist-1', ?, ?, 'active', ?, 'owner-1', ?)`,
      PATIENT,
      ISSUER,
      T1,
      T2,
      ISSUER,
      T1,
    );
    run(
      db,
      `INSERT INTO grants (id, version, patient_id, effect, grantee_issuer, grantee_subject, encounter_id, purpose, categories, max_sensitivity, allow_baseline, valid_from, expires_at, source, created_by_issuer, created_by_subject, created_at)
             VALUES ('grant-e2', 1, ?, 'allow', ?, 'cardiologist-1', 'enc-2', 'direct-treatment', '["cardiac"]', 'routine', 0, ?, ?, 'owner', ?, 'o', ?)`,
      PATIENT,
      ISSUER,
      T1,
      T2,
      ISSUER,
      T1,
    );
    run(
      db,
      `INSERT INTO grants (id, version, patient_id, effect, grantee_issuer, grantee_subject, encounter_id, purpose, categories, max_sensitivity, allow_baseline, valid_from, expires_at, source, created_by_issuer, created_by_subject, created_at)
             VALUES ('grant-later', 1, ?, 'allow', ?, 'cardiologist-1', 'enc-1', 'direct-treatment', '["cardiac"]', 'routine', 0, '2026-11-26T10:00:00.000Z', ?, 'owner', ?, 'o', ?)`,
      PATIENT,
      ISSUER,
      T2,
      ISSUER,
      T1,
    );
    insertBareReceipt('r-win', 'released', 1);

    expect(() => addRecord('r-win', 'grant-e2', 1)).toThrow(/in force/);
    expect(() => addRecord('r-win', 'grant-later', 1)).toThrow(/in force/);
  });

  it('records a denial for an encounter id that does not exist', () => {
    run(
      db,
      `INSERT INTO receipts (id, patient_id, issued_at, request_id, requester_issuer, requester_subject, encounter_id, purpose, policy_version, decision, rationale_code)
             VALUES ('r-g', ?, ?, 'req-g', ?, 's', 'guessed-enc', 'direct-treatment', 'p', 'denied', 'encounter-not-found')`,
      PATIENT,
      T1,
      ISSUER,
    );

    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM receipts WHERE encounter_id = 'guessed-enc'`,
        )
        .get(),
    ).toEqual({ n: 1 });
  });
});

describe('sql:grants', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = openVault(':memory:');
    seedBase(db);
    insertGrant(db, 1);
  });

  afterEach(() => {
    db.close();
  });

  it('is immutable: UPDATE and DELETE are rejected', () => {
    expect(() =>
      run(db, `UPDATE grants SET revoked_at = '${T2}' WHERE id = 'grant-1'`),
    ).toThrow(/immutable/);
    expect(() => run(db, `DELETE FROM grants WHERE id = 'grant-1'`)).toThrow(
      /cannot be deleted/,
    );
  });

  it('requires dense versions starting at 1', () => {
    expect(() => insertGrant(db, 3)).toThrow(/next integer/);
    expect(() => insertGrant(db, 1)).toThrow();
    insertGrant(db, 2);
  });

  it('records revocation as a new version, exposed through current_grants', () => {
    insertGrant(db, 2, T1);

    expect(
      db
        .prepare(
          `SELECT version, revoked_at FROM current_grants WHERE id = 'grant-1'`,
        )
        .all(),
    ).toEqual([{ version: 2, revoked_at: T1 }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM grants').get()).toEqual({
      n: 2,
    });
  });

  it('forbids any version after a revoked one', () => {
    insertGrant(db, 2, T1);

    expect(() => insertGrant(db, 3)).toThrow(
      /revoked grant cannot be extended/,
    );
  });

  it('refuses an organization grantee without roles and a deny grant with baseline', () => {
    expect(() =>
      run(
        db,
        `INSERT INTO grants (id, version, patient_id, effect, grantee_issuer, grantee_organization_id, encounter_id, purpose, categories, max_sensitivity, allow_baseline, valid_from, expires_at, source, created_by_issuer, created_by_subject, created_at)
               VALUES ('g-org', 1, ?, 'allow', ?, 'org-1', 'enc-1', 'direct-treatment', '["dental"]', 'routine', 0, ?, ?, 'owner', ?, 'o', ?)`,
        PATIENT,
        ISSUER,
        T1,
        T2,
        ISSUER,
        T1,
      ),
    ).toThrow(/CHECK/);
    expect(() =>
      run(
        db,
        `INSERT INTO grants (id, version, patient_id, effect, grantee_issuer, grantee_subject, encounter_id, purpose, categories, max_sensitivity, allow_baseline, valid_from, expires_at, source, created_by_issuer, created_by_subject, created_at)
               VALUES ('g-deny', 1, ?, 'deny', ?, 's', 'enc-1', 'direct-treatment', '["mental-health"]', 'restricted', 1, ?, ?, 'owner', ?, 'o', ?)`,
        PATIENT,
        ISSUER,
        T1,
        T2,
        ISSUER,
        T1,
      ),
    ).toThrow(/CHECK/);
  });

  it('refuses a grant for an untrusted issuer or an unknown encounter', () => {
    expect(() =>
      run(
        db,
        `INSERT INTO grants (id, version, patient_id, effect, grantee_issuer, grantee_subject, encounter_id, purpose, categories, max_sensitivity, allow_baseline, valid_from, expires_at, source, created_by_issuer, created_by_subject, created_at)
               VALUES ('g-2', 1, ?, 'allow', 'https://other.example.invalid', 's', 'enc-1', 'direct-treatment', '["dental"]', 'routine', 0, ?, ?, 'owner', ?, 'o', ?)`,
        PATIENT,
        T1,
        T2,
        ISSUER,
        T1,
      ),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      run(
        db,
        `INSERT INTO grants (id, version, patient_id, effect, grantee_issuer, grantee_subject, encounter_id, purpose, categories, max_sensitivity, allow_baseline, valid_from, expires_at, source, created_by_issuer, created_by_subject, created_at)
               VALUES ('g-3', 1, ?, 'allow', ?, 's', 'guessed', 'direct-treatment', '["dental"]', 'routine', 0, ?, ?, 'owner', ?, 'o', ?)`,
        PATIENT,
        ISSUER,
        T1,
        T2,
        ISSUER,
        T1,
      ),
    ).toThrow(/FOREIGN KEY/);
  });

  /**
   * inserts a version-1 grant with the given categories and effect
   * @param id the grant id
   * @param categories the categories JSON text
   * @param effect allow or deny
   */
  function insertWithCategories(
    id: string,
    categories: string,
    effect = 'allow',
  ): void {
    run(
      db,
      `INSERT INTO grants (id, version, patient_id, effect, grantee_issuer, grantee_subject, encounter_id, purpose, categories, max_sensitivity, allow_baseline, valid_from, expires_at, source, created_by_issuer, created_by_subject, created_at)
             VALUES (?, 1, ?, ?, ?, 's', 'enc-1', 'direct-treatment', ?, 'routine', 0, ?, ?, 'owner', ?, 'o', ?)`,
      id,
      PATIENT,
      effect,
      ISSUER,
      categories,
      T1,
      T2,
      ISSUER,
      T1,
    );
  }

  it('has no default effect: a grant must say allow or deny', () => {
    expect(() =>
      run(
        db,
        `INSERT INTO grants (id, version, patient_id, grantee_issuer, grantee_subject, encounter_id, purpose, categories, max_sensitivity, allow_baseline, valid_from, expires_at, source, created_by_issuer, created_by_subject, created_at)
               VALUES ('g-noeffect', 1, ?, ?, 's', 'enc-1', 'direct-treatment', '["dental"]', 'routine', 0, ?, ?, 'owner', ?, 'o', ?)`,
        PATIENT,
        ISSUER,
        T1,
        T2,
        ISSUER,
        T1,
      ),
    ).toThrow(/NOT NULL.*effect/);
    expect(() => insertWithCategories('g-bad', '["dental"]', 'maybe')).toThrow(
      /CHECK/,
    );
  });

  it.each([
    ['an unknown category', '["oncology"]'],
    ['baseline as a category', '["baseline"]'],
    ['a duplicate category', '["dental","dental"]'],
    ['a non-string category', '[1]'],
    ['a null category', '[null]'],
    ['a nested category', '[["dental"]]'],
  ])('refuses %s in grant categories', (_name, categories) => {
    expect(() => insertWithCategories('g-cat', categories)).toThrow(
      /unique known grantable categories/,
    );
    expect(() => insertWithCategories('g-cat', categories, 'deny')).toThrow(
      /unique known grantable categories/,
    );
  });

  it('accepts every grantable category once', () => {
    insertWithCategories(
      'g-all',
      '["cardiac","dental","musculoskeletal","dermatology","mental-health","substance-use"]',
    );
  });

  it('requires an organization and its roles to come together', () => {
    const insert = (
      id: string,
      organization: string | null,
      roles: string,
    ): void =>
      run(
        db,
        `INSERT INTO grants (id, version, patient_id, effect, grantee_issuer, grantee_subject, grantee_organization_id, grantee_roles, encounter_id, purpose, categories, max_sensitivity, allow_baseline, valid_from, expires_at, source, created_by_issuer, created_by_subject, created_at)
               VALUES (?, 1, ?, 'allow', ?, 's', ?, ?, 'enc-1', 'direct-treatment', '["dental"]', 'routine', 0, ?, ?, 'owner', ?, 'o', ?)`,
        id,
        PATIENT,
        ISSUER,
        organization,
        roles,
        T1,
        T2,
        ISSUER,
        T1,
      );

    insert('g-person-org', 'org-1', '["dentist"]');

    expect(() => insert('g-roles-only', null, '["dentist"]')).toThrow(/CHECK/);
    expect(() => insert('g-org-only', 'org-1', '[]')).toThrow(/CHECK/);
  });

  it('refuses INSERT OR REPLACE over an existing grant version', () => {
    for (const recursive of ['OFF', 'ON']) {
      db.exec(`PRAGMA recursive_triggers = ${recursive}`);

      expect(() =>
        run(
          db,
          `INSERT OR REPLACE INTO grants (id, version, patient_id, effect, grantee_issuer, grantee_subject, encounter_id, purpose, categories, max_sensitivity, allow_baseline, valid_from, expires_at, source, created_by_issuer, created_by_subject, created_at)
                 VALUES ('grant-1', 1, ?, 'allow', ?, 'intruder', 'enc-1', 'direct-treatment', '["mental-health"]', 'restricted', 1, ?, ?, 'owner', ?, 'o', ?)`,
          PATIENT,
          ISSUER,
          T1,
          T2,
          ISSUER,
          T1,
        ),
      ).toThrow(/next integer/);
    }

    expect(
      db
        .prepare(
          `SELECT grantee_subject, categories FROM grants WHERE id = 'grant-1'`,
        )
        .get(),
    ).toEqual({ grantee_subject: 'cardiologist-1', categories: '["cardiac"]' });
  });
});

describe('sql:sharing', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = openVault(':memory:');
    seedBase(db);
    run(
      db,
      `INSERT INTO invitations (id, patient_id, token_hash, created_at, expires_at) VALUES ('inv-1', ?, ?, ?, ?)`,
      PATIENT,
      'a'.repeat(64),
      T1,
      T2,
    );
  });

  afterEach(() => {
    db.close();
  });

  it('lets an open invitation be consumed once and never again', () => {
    run(
      db,
      `UPDATE invitations SET status = 'consumed', consumed_at = ?, consumed_by_issuer = ?, consumed_by_subject = 'c-1' WHERE id = 'inv-1'`,
      T1,
      ISSUER,
    );

    expect(() =>
      run(db, `UPDATE invitations SET status = 'revoked' WHERE id = 'inv-1'`),
    ).toThrow(/cannot change/);
    expect(() =>
      run(
        db,
        `UPDATE invitations SET consumed_by_subject = 'someone-else' WHERE id = 'inv-1'`,
      ),
    ).toThrow(/cannot change/);
    expect(() => run(db, `DELETE FROM invitations WHERE id = 'inv-1'`)).toThrow(
      /cannot be deleted/,
    );
  });

  it('refuses a consumed invitation without its consumer and a duplicate token hash', () => {
    expect(() =>
      run(db, `UPDATE invitations SET status = 'consumed' WHERE id = 'inv-1'`),
    ).toThrow(/CHECK/);
    expect(() =>
      run(
        db,
        `INSERT INTO invitations (id, patient_id, token_hash, created_at, expires_at) VALUES ('inv-2', ?, ?, ?, ?)`,
        PATIENT,
        'a'.repeat(64),
        T1,
        T2,
      ),
    ).toThrow(/already exists/);
    expect(() =>
      run(
        db,
        `INSERT INTO invitations (id, patient_id, token_hash, created_at, expires_at) VALUES ('inv-3', ?, 'not-a-hash', ?, ?)`,
        PATIENT,
        T1,
        T2,
      ),
    ).toThrow(/CHECK/);
  });

  it('allows one connection per invitation and freezes it once decided', () => {
    run(
      db,
      `INSERT INTO connections (id, patient_id, invitation_id, requester_issuer, requester_subject, created_at) VALUES ('conn-1', ?, 'inv-1', ?, 'c-1', ?)`,
      PATIENT,
      ISSUER,
      T1,
    );

    expect(() =>
      run(
        db,
        `INSERT INTO connections (id, patient_id, invitation_id, requester_issuer, requester_subject, created_at) VALUES ('conn-2', ?, 'inv-1', ?, 'c-2', ?)`,
        PATIENT,
        ISSUER,
        T1,
      ),
    ).toThrow(/already exists/);

    run(
      db,
      `UPDATE connections SET status = 'declined', decided_at = ? WHERE id = 'conn-1'`,
      T1,
    );

    expect(() =>
      run(
        db,
        `UPDATE connections SET status = 'confirmed', decided_at = ? WHERE id = 'conn-1'`,
        T2,
      ),
    ).toThrow(/cannot change/);
  });

  it('allows only one live connection per requester but a new one after a decline', () => {
    run(
      db,
      `INSERT INTO invitations (id, patient_id, token_hash, created_at, expires_at) VALUES ('inv-2', ?, ?, ?, ?)`,
      PATIENT,
      'b'.repeat(64),
      T1,
      T2,
    );
    run(
      db,
      `INSERT INTO connections (id, patient_id, invitation_id, requester_issuer, requester_subject, created_at) VALUES ('conn-1', ?, 'inv-1', ?, 'c-1', ?)`,
      PATIENT,
      ISSUER,
      T1,
    );

    expect(() =>
      run(
        db,
        `INSERT INTO connections (id, patient_id, invitation_id, requester_issuer, requester_subject, created_at) VALUES ('conn-2', ?, 'inv-2', ?, 'c-1', ?)`,
        PATIENT,
        ISSUER,
        T1,
      ),
    ).toThrow(/already exists/);

    run(
      db,
      `UPDATE connections SET status = 'declined', decided_at = ? WHERE id = 'conn-1'`,
      T1,
    );
    run(
      db,
      `INSERT INTO connections (id, patient_id, invitation_id, requester_issuer, requester_subject, created_at) VALUES ('conn-2', ?, 'inv-2', ?, 'c-1', ?)`,
      PATIENT,
      ISSUER,
      T1,
    );
  });

  it('lets only a confirmed connection end, changing nothing else, and frees the requester for a new one', () => {
    run(
      db,
      `INSERT INTO invitations (id, patient_id, token_hash, created_at, expires_at) VALUES ('inv-2', ?, ?, ?, ?)`,
      PATIENT,
      'b'.repeat(64),
      T1,
      T2,
    );
    run(
      db,
      `INSERT INTO connections (id, patient_id, invitation_id, requester_issuer, requester_subject, created_at) VALUES ('conn-1', ?, 'inv-1', ?, 'c-1', ?)`,
      PATIENT,
      ISSUER,
      T1,
    );

    // a pending connection is decided, never ended
    run(
      db,
      `UPDATE connections SET status = 'confirmed', decided_at = ? WHERE id = 'conn-1'`,
      T1,
    );

    expect(() =>
      run(
        db,
        `UPDATE connections SET status = 'ended', stated_name = 'x' WHERE id = 'conn-1'`,
      ),
    ).toThrow(/cannot change/);
    expect(() =>
      run(
        db,
        `UPDATE connections SET status = 'ended', decided_at = ? WHERE id = 'conn-1'`,
        T2,
      ),
    ).toThrow(/cannot change/);
    expect(() =>
      run(db, `UPDATE connections SET status = 'declined' WHERE id = 'conn-1'`),
    ).toThrow(/cannot change/);

    run(db, `UPDATE connections SET status = 'ended' WHERE id = 'conn-1'`);

    expect(() =>
      run(
        db,
        `UPDATE connections SET status = 'confirmed' WHERE id = 'conn-1'`,
      ),
    ).toThrow(/cannot change/);

    run(
      db,
      `INSERT INTO connections (id, patient_id, invitation_id, requester_issuer, requester_subject, created_at) VALUES ('conn-2', ?, 'inv-2', ?, 'c-1', ?)`,
      PATIENT,
      ISSUER,
      T1,
    );
  });

  it('refuses ending a pending connection', () => {
    run(
      db,
      `INSERT INTO connections (id, patient_id, invitation_id, requester_issuer, requester_subject, created_at) VALUES ('conn-1', ?, 'inv-1', ?, 'c-1', ?)`,
      PATIENT,
      ISSUER,
      T1,
    );

    expect(() =>
      run(
        db,
        `UPDATE connections SET status = 'ended', decided_at = ? WHERE id = 'conn-1'`,
        T1,
      ),
    ).toThrow(/only a confirmed connection can end/);
  });

  it('keeps a scope request idempotent per requester and final once decided', () => {
    const insert = (id: string): void =>
      run(
        db,
        `INSERT INTO scope_requests (id, request_id, patient_id, requester_issuer, requester_subject, encounter_id, requested_categories, reason, desired_expires_at, created_at)
               VALUES (?, 'req-1', ?, ?, 'dentist-1', 'enc-1', '["cardiac"]', 'need it', ?, ?)`,
        id,
        PATIENT,
        ISSUER,
        T2,
        T1,
      );

    insert('sr-1');

    expect(() => insert('sr-2')).toThrow(/already exists/);

    run(
      db,
      `UPDATE scope_requests SET status = 'declined', decided_at = ? WHERE id = 'sr-1'`,
      T1,
    );

    expect(() =>
      run(
        db,
        `UPDATE scope_requests SET status = 'pending', decided_at = NULL WHERE id = 'sr-1'`,
      ),
    ).toThrow(/cannot change/);
    expect(() =>
      run(
        db,
        `UPDATE scope_requests SET status = 'approved', decided_at = ?, grant_id = 'g' WHERE id = 'sr-1'`,
        T2,
      ),
    ).toThrow(/cannot change/);
  });

  it('refuses INSERT OR REPLACE over invitations, connections and scope requests, with or without recursive triggers', () => {
    run(
      db,
      `UPDATE invitations SET status = 'consumed', consumed_at = ?, consumed_by_issuer = ?, consumed_by_subject = 'c-1' WHERE id = 'inv-1'`,
      T1,
      ISSUER,
    );
    run(
      db,
      `INSERT INTO connections (id, patient_id, invitation_id, requester_issuer, requester_subject, created_at) VALUES ('conn-1', ?, 'inv-1', ?, 'c-1', ?)`,
      PATIENT,
      ISSUER,
      T1,
    );
    run(
      db,
      `INSERT INTO scope_requests (id, request_id, patient_id, requester_issuer, requester_subject, encounter_id, requested_categories, reason, desired_expires_at, created_at)
             VALUES ('sr-1', 'req-1', ?, ?, 'dentist-1', 'enc-1', '["dental"]', 'need it', ?, ?)`,
      PATIENT,
      ISSUER,
      T2,
      T1,
    );

    for (const recursive of ['OFF', 'ON']) {
      db.exec(`PRAGMA recursive_triggers = ${recursive}`);

      // same id, and the same token hash under a new id
      for (const id of ['inv-1', 'inv-9']) {
        expect(() =>
          run(
            db,
            `INSERT OR REPLACE INTO invitations (id, patient_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
            id,
            PATIENT,
            'a'.repeat(64),
            T1,
            T2,
          ),
        ).toThrow(/already exists/);
      }

      // same id, same invitation, and the same live requester
      for (const [id, invitation, requester] of [
        ['conn-1', 'inv-1', 'c-1'],
        ['conn-9', 'inv-1', 'c-9'],
        ['conn-8', 'inv-8', 'c-1'],
      ]) {
        expect(() =>
          run(
            db,
            `INSERT OR REPLACE INTO connections (id, patient_id, invitation_id, requester_issuer, requester_subject, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
            id ?? null,
            PATIENT,
            invitation ?? null,
            ISSUER,
            requester ?? null,
            T1,
          ),
        ).toThrow(/already exists/);
      }

      // same id, and the same idempotency key under a new id
      for (const id of ['sr-1', 'sr-9']) {
        expect(() =>
          run(
            db,
            `INSERT OR REPLACE INTO scope_requests (id, request_id, patient_id, requester_issuer, requester_subject, encounter_id, requested_categories, reason, desired_expires_at, created_at)
                   VALUES (?, 'req-1', ?, ?, 'dentist-1', 'enc-1', '["cardiac"]', 'swap', ?, ?)`,
            id,
            PATIENT,
            ISSUER,
            T2,
            T1,
          ),
        ).toThrow(/already exists/);
      }
    }

    expect(
      db.prepare(`SELECT status FROM invitations WHERE id = 'inv-1'`).get(),
    ).toEqual({ status: 'consumed' });
    expect(
      db
        .prepare(
          `SELECT requested_categories FROM scope_requests WHERE id = 'sr-1'`,
        )
        .get(),
    ).toEqual({ requested_categories: '["dental"]' });
  });

  it('still enforces the UNIQUE keys when the collision guards are absent', () => {
    for (const guard of [
      'invitations_no_replace',
      'connections_no_replace',
      'scope_requests_no_replace',
    ]) {
      db.exec(`DROP TRIGGER ${guard}`);
    }

    run(
      db,
      `INSERT INTO connections (id, patient_id, invitation_id, requester_issuer, requester_subject, created_at) VALUES ('conn-1', ?, 'inv-1', ?, 'c-1', ?)`,
      PATIENT,
      ISSUER,
      T1,
    );

    expect(() =>
      run(
        db,
        `INSERT INTO invitations (id, patient_id, token_hash, created_at, expires_at) VALUES ('inv-2', ?, ?, ?, ?)`,
        PATIENT,
        'a'.repeat(64),
        T1,
        T2,
      ),
    ).toThrow(/UNIQUE/);
    expect(() =>
      run(
        db,
        `INSERT INTO connections (id, patient_id, invitation_id, requester_issuer, requester_subject, created_at) VALUES ('conn-2', ?, 'inv-1', ?, 'c-2', ?)`,
        PATIENT,
        ISSUER,
        T1,
      ),
    ).toThrow(/UNIQUE/);
  });

  it('accepts only unique known categories on a scope request', () => {
    const insert = (id: string, categories: string): void =>
      run(
        db,
        `INSERT INTO scope_requests (id, request_id, patient_id, requester_issuer, requester_subject, encounter_id, requested_categories, reason, desired_expires_at, created_at)
               VALUES (?, ?, ?, ?, 'dentist-1', 'enc-1', ?, 'need it', ?, ?)`,
        id,
        id,
        PATIENT,
        ISSUER,
        categories,
        T2,
        T1,
      );

    insert('sr-ok', '["baseline","dental"]');

    for (const bad of [
      '["dental","dental"]',
      '["oncology"]',
      '[1]',
      '[null]',
    ]) {
      expect(() => insert(`sr-${bad.length}${bad.charCodeAt(2)}`, bad)).toThrow(
        /unique known categories/,
      );
    }
  });
});

describe('sql:records', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = openVault(':memory:');
    seedBase(db);
    run(
      db,
      `INSERT INTO record_sources (id, patient_id, provider, box_file_id, version, sha256, verification, imported_at) VALUES (1, ?, 'Northgate', '9100000011', '1', ?, 'synthetic-provider', ?)`,
      PATIENT,
      'c'.repeat(64),
      T1,
    );
  });

  afterEach(() => {
    db.close();
  });

  /**
   * inserts a record row
   * @param fields the record columns
   * @param fields.id primary key of the inserted row
   * @param fields.category curated category under test
   * @param fields.sensitivity label that must agree with the category
   * @param fields.resourceType the column resource type
   * @param fields.jsonType the resourceType inside the JSON, when it differs
   */
  function insertRecord(fields: {
    id: string;
    category: string;
    sensitivity: string;
    resourceType?: string;
    jsonType?: string;
  }): void {
    const { id, category, sensitivity, resourceType = 'Observation' } = fields;
    const jsonType = fields.jsonType ?? resourceType;

    run(
      db,
      `INSERT INTO records (id, patient_id, source_id, resource_type, resource, category, sensitivity) VALUES (?, ?, 1, ?, ?, ?, ?)`,
      id,
      PATIENT,
      resourceType,
      JSON.stringify({ resourceType: jsonType, id }),
      category,
      sensitivity,
    );
  }

  it('stores records and deduplicates sources by file id, version and digest', () => {
    insertRecord({ id: 'rec-1', category: 'cardiac', sensitivity: 'routine' });

    expect(() =>
      run(
        db,
        `INSERT INTO record_sources (patient_id, provider, box_file_id, version, sha256, verification, imported_at) VALUES (?, 'Northgate', '9100000011', '1', ?, 'synthetic-provider', ?)`,
        PATIENT,
        'c'.repeat(64),
        T1,
      ),
    ).toThrow(/UNIQUE/);
    run(
      db,
      `INSERT INTO record_sources (patient_id, provider, box_file_id, version, sha256, verification, imported_at) VALUES (?, 'Northgate', '9100000011', '2', ?, 'synthetic-provider', ?)`,
      PATIENT,
      'd'.repeat(64),
      T1,
    );
  });

  it.each([
    [
      'mislabelled mental-health record',
      { id: 'rec-2', category: 'mental-health', sensitivity: 'routine' },
    ],
    [
      'restricted baseline record',
      { id: 'rec-3', category: 'baseline', sensitivity: 'restricted' },
    ],
    [
      'unknown category',
      { id: 'rec-4', category: 'oncology', sensitivity: 'routine' },
    ],
    [
      'resource type that disagrees with the JSON',
      {
        id: 'rec-5',
        category: 'cardiac',
        sensitivity: 'routine',
        jsonType: 'Condition',
      },
    ],
    [
      'unsupported resource type',
      {
        id: 'rec-6',
        category: 'cardiac',
        sensitivity: 'routine',
        resourceType: 'Bundle',
      },
    ],
  ])('rejects a %s', (_name, fields) => {
    expect(() => insertRecord(fields)).toThrow(/CHECK/);
  });

  it('rejects non-canonical timestamps and non-numeric box ids', () => {
    expect(() =>
      run(
        db,
        `INSERT INTO record_sources (patient_id, provider, box_file_id, version, sha256, verification, imported_at) VALUES (?, 'x', '../1', '1', ?, 'unverified', ?)`,
        PATIENT,
        'e'.repeat(64),
        T1,
      ),
    ).toThrow(/CHECK/);
    expect(() =>
      run(
        db,
        `INSERT INTO record_sources (patient_id, provider, box_file_id, version, sha256, verification, imported_at) VALUES (?, 'x', '2', '1', ?, 'unverified', '2026-11-25T10:00:00Z')`,
        PATIENT,
        'e'.repeat(64),
      ),
    ).toThrow(/CHECK/);
    expect(() =>
      run(
        db,
        `INSERT INTO record_sources (patient_id, provider, box_file_id, version, sha256, verification, imported_at) VALUES (?, 'x', '2', '1', ?, 'unverified', '2026-02-31T10:00:00.000Z')`,
        PATIENT,
        'e'.repeat(64),
      ),
    ).toThrow(/CHECK/);
  });

  it('dedupes owner sync runs by idempotency key', () => {
    const start = (id: string): void =>
      run(
        db,
        `INSERT INTO sync_runs (id, patient_id, idempotency_key, trigger, adapter, folder_id, status, started_at) VALUES (?, ?, 'sync-key-1', 'owner', 'fixture', '1', 'running', ?)`,
        id,
        PATIENT,
        T1,
      );

    start('sync-1');

    expect(() => start('sync-2')).toThrow(/UNIQUE/);
  });

  it('lets only status change after import', () => {
    insertRecord({ id: 'rec-u', category: 'cardiac', sensitivity: 'routine' });

    for (const assignment of [
      `category = 'dental'`,
      `sensitivity = 'restricted'`,
      `category = 'mental-health', sensitivity = 'restricted'`,
      `resource = '{"resourceType":"Observation","id":"rec-u","x":1}'`,
      `source_id = 1, authored_at = '${T1}'`,
      `id = 'rec-renamed'`,
      `resource_type = 'Condition', resource = '{"resourceType":"Condition","id":"rec-u"}'`,
    ]) {
      expect(() =>
        run(db, `UPDATE records SET ${assignment} WHERE id = 'rec-u'`),
      ).toThrow(/only status can change/);
    }

    run(db, `UPDATE records SET status = 'superseded' WHERE id = 'rec-u'`);
    run(
      db,
      `UPDATE records SET status = 'entered-in-error' WHERE id = 'rec-u'`,
    );

    expect(() =>
      run(db, `UPDATE records SET status = 'current' WHERE id = 'rec-u'`),
    ).toThrow(/entered-in-error/);
    expect(
      db
        .prepare(
          `SELECT category, sensitivity, status FROM records WHERE id = 'rec-u'`,
        )
        .get(),
    ).toEqual({
      category: 'cardiac',
      sensitivity: 'routine',
      status: 'entered-in-error',
    });
  });

  it('refuses INSERT OR REPLACE over an existing record, with or without recursive triggers', () => {
    insertRecord({
      id: 'rec-r',
      category: 'mental-health',
      sensitivity: 'restricted',
    });

    for (const recursive of ['OFF', 'ON']) {
      db.exec(`PRAGMA recursive_triggers = ${recursive}`);

      expect(() =>
        run(
          db,
          `INSERT OR REPLACE INTO records (id, patient_id, source_id, resource_type, resource, category, sensitivity) VALUES ('rec-r', ?, 1, 'Observation', '{"resourceType":"Observation","id":"rec-r"}', 'baseline', 'routine')`,
          PATIENT,
        ),
      ).toThrow(/already exists/);
    }

    expect(
      db
        .prepare(`SELECT category, sensitivity FROM records WHERE id = 'rec-r'`)
        .get(),
    ).toEqual({ category: 'mental-health', sensitivity: 'restricted' });
  });

  describe('record_conflicts', () => {
    const NEW_SHA = 'f'.repeat(64);

    beforeEach(() => {
      insertRecord({
        id: 'rec-x',
        category: 'cardiac',
        sensitivity: 'routine',
      });
    });

    /**
     * parks an incoming version beside rec-x
     * @param id primary key of the parked conflict
     * @param version the incoming version
     */
    function conflict(id: string, version = '2'): void {
      run(
        db,
        `INSERT INTO record_conflicts (id, record_id, box_file_id, incoming_version, incoming_sha256, incoming_record, detected_at)
               VALUES (?, 'rec-x', '9100000011', ?, ?, '{"id":"rec-x","category":"dental"}', ?)`,
        id,
        version,
        NEW_SHA,
        T1,
      );
    }

    it('keeps the incoming copy open beside an untouched original', () => {
      conflict('conf-1');

      expect(
        db
          .prepare(
            `SELECT status, resolved_at, incoming_version, incoming_record FROM record_conflicts WHERE id = 'conf-1'`,
          )
          .get(),
      ).toEqual({
        status: 'open',
        resolved_at: null,
        incoming_version: '2',
        incoming_record: '{"id":"rec-x","category":"dental"}',
      });
      expect(
        db
          .prepare(`SELECT category, status FROM records WHERE id = 'rec-x'`)
          .get(),
      ).toEqual({ category: 'cardiac', status: 'current' });
    });

    it('detects the same incoming version of a record once, and refuses REPLACE', () => {
      conflict('conf-1');

      expect(() => conflict('conf-2')).toThrow(/already exists/);
      expect(() => conflict('conf-1', '3')).toThrow(/already exists/);
      conflict('conf-3', '3');

      for (const recursive of ['OFF', 'ON']) {
        db.exec(`PRAGMA recursive_triggers = ${recursive}`);

        expect(() =>
          run(
            db,
            `INSERT OR REPLACE INTO record_conflicts (id, record_id, box_file_id, incoming_version, incoming_sha256, incoming_record, detected_at, status)
                   VALUES ('conf-1', 'rec-x', '9100000011', '9', ?, '{}', ?, 'open')`,
            NEW_SHA,
            T1,
          ),
        ).toThrow(/already exists/);
      }

      expect(
        db
          .prepare(
            `SELECT incoming_version FROM record_conflicts WHERE id = 'conf-1'`,
          )
          .get(),
      ).toEqual({ incoming_version: '2' });
    });

    it('refuses a conflict for a record that does not exist or one that is born resolved', () => {
      expect(() =>
        run(
          db,
          `INSERT INTO record_conflicts (id, record_id, box_file_id, incoming_version, incoming_sha256, incoming_record, detected_at)
                 VALUES ('c-n', 'no-such-record', '9100000011', '2', ?, '{}', ?)`,
          NEW_SHA,
          T1,
        ),
      ).toThrow(/FOREIGN KEY/);
      expect(() =>
        run(
          db,
          `INSERT INTO record_conflicts (id, record_id, box_file_id, incoming_version, incoming_sha256, incoming_record, detected_at, status, resolved_by_issuer, resolved_by_subject, resolved_at)
                 VALUES ('c-r', 'rec-x', '9100000011', '2', ?, '{}', ?, 'kept-original', ?, 'owner-1', ?)`,
          NEW_SHA,
          T1,
          ISSUER,
          T1,
        ),
      ).toThrow(/recorded open/);
    });

    it('resolves forward once, by a named person, and never reopens or edits', () => {
      conflict('conf-1');

      expect(() =>
        run(
          db,
          `UPDATE record_conflicts SET status = 'kept-original', resolved_at = ? WHERE id = 'conf-1'`,
          T1,
        ),
      ).toThrow(/CHECK/);
      expect(() =>
        run(
          db,
          `UPDATE record_conflicts SET incoming_record = '{}' WHERE id = 'conf-1'`,
        ),
      ).toThrow(/can only be resolved/);
      expect(() =>
        run(
          db,
          `UPDATE record_conflicts SET record_id = 'rec-x', incoming_version = '7' WHERE id = 'conf-1'`,
        ),
      ).toThrow(/can only be resolved/);

      run(
        db,
        `UPDATE record_conflicts SET status = 'kept-original', resolved_by_issuer = ?, resolved_by_subject = 'owner-1', resolved_at = ? WHERE id = 'conf-1'`,
        ISSUER,
        T2,
      );

      for (const change of [
        `status = 'open', resolved_by_issuer = NULL, resolved_by_subject = NULL, resolved_at = NULL`,
        `status = 'accepted-incoming', accepted_record_id = 'rec-x2'`,
        `resolved_at = '${T1}'`,
      ]) {
        expect(() =>
          run(db, `UPDATE record_conflicts SET ${change} WHERE id = 'conf-1'`),
        ).toThrow(/can only be resolved/);
      }

      expect(() => run(db, 'DELETE FROM record_conflicts')).toThrow(
        /cannot be deleted/,
      );
    });

    it('accepts an incoming copy only as a new record and leaves the original category and sensitivity alone', () => {
      conflict('conf-1');

      const accept = (acceptedId: string): void =>
        run(
          db,
          `UPDATE record_conflicts SET status = 'accepted-incoming', accepted_record_id = ?, resolved_by_issuer = ?, resolved_by_subject = 'owner-1', resolved_at = ? WHERE id = 'conf-1'`,
          acceptedId,
          ISSUER,
          T2,
        );

      expect(() => accept('rec-x')).toThrow(/CHECK/);
      expect(() => accept('rec-not-imported')).toThrow(/FOREIGN KEY/);

      insertRecord({
        id: 'rec-x2',
        category: 'dental',
        sensitivity: 'routine',
      });
      accept('rec-x2');

      expect(
        db
          .prepare(
            `SELECT id, category, sensitivity FROM records WHERE id IN ('rec-x', 'rec-x2') ORDER BY id`,
          )
          .all(),
      ).toEqual([
        { id: 'rec-x', category: 'cardiac', sensitivity: 'routine' },
        { id: 'rec-x2', category: 'dental', sensitivity: 'routine' },
      ]);
      expect(() =>
        run(db, `UPDATE records SET category = 'dental' WHERE id = 'rec-x'`),
      ).toThrow(/only status can change/);
    });
  });
});

describe('sql:identity', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = openVault(':memory:');
    seedBase(db);
  });

  afterEach(() => {
    db.close();
  });

  it('holds exactly one synthetic patient', () => {
    expect(() =>
      run(
        db,
        `INSERT INTO patient (id, label, owner_issuer, owner_subject, created_at) VALUES ('p-2', 'SYNTHETIC Two', ?, 'o', ?)`,
        ISSUER,
        T1,
      ),
    ).toThrow(/UNIQUE/);
  });

  it('refuses a patient not labelled synthetic', () => {
    const fresh = openVault(':memory:');

    expect(() =>
      run(
        fresh,
        `INSERT INTO patient (id, label, owner_issuer, owner_subject, created_at) VALUES ('p-1', 'Jane Real', ?, 'o', ?)`,
        ISSUER,
        T1,
      ),
    ).toThrow(/CHECK/);
    expect(() =>
      run(
        fresh,
        `INSERT INTO patient (id, synthetic, label, owner_issuer, owner_subject, created_at) VALUES ('p-1', 0, 'SYNTHETIC', ?, 'o', ?)`,
        ISSUER,
        T1,
      ),
    ).toThrow(/CHECK/);
    fresh.close();
  });

  it('keys clinicians by issuer and subject and requires a trusted issuer', () => {
    const insert = (issuer: string, subject: string): void =>
      run(
        db,
        `INSERT INTO clinicians (issuer, subject, display_name, organization_id, roles, verified_at, created_at) VALUES (?, ?, 'Dr Fictional', 'org-1', '["cardiologist"]', ?, ?)`,
        issuer,
        subject,
        T1,
        T1,
      );

    insert(ISSUER, 'c-1');

    expect(() => insert(ISSUER, 'c-1')).toThrow(/UNIQUE|PRIMARY/);
    expect(() => insert('https://other.example.invalid', 'c-1')).toThrow(
      /FOREIGN KEY/,
    );
  });

  it('refuses an encounter with neither clinician nor organization', () => {
    expect(() =>
      run(
        db,
        `INSERT INTO encounters (id, patient_id, purpose, starts_at, ends_at, status, created_by_issuer, created_by_subject, created_at) VALUES ('e-2', ?, 'direct-treatment', ?, ?, 'planned', 'i', 's', ?)`,
        PATIENT,
        T1,
        T2,
        T1,
      ),
    ).toThrow(/CHECK/);
  });

  it('only shrinks an encounter window and only moves its status forward', () => {
    const later = '2027-01-25T10:00:00.000Z';
    const earlier = '2026-12-01T10:00:00.000Z';

    expect(() =>
      run(db, `UPDATE encounters SET ends_at = ? WHERE id = 'enc-1'`, later),
    ).toThrow(/only shrink/);
    expect(() =>
      run(
        db,
        `UPDATE encounters SET starts_at = ? WHERE id = 'enc-1'`,
        earlier,
      ),
    ).toThrow(/only shrink/);

    run(db, `UPDATE encounters SET ends_at = ? WHERE id = 'enc-1'`, earlier);
    run(db, `UPDATE encounters SET status = 'active' WHERE id = 'enc-1'`);

    expect(() =>
      run(db, `UPDATE encounters SET status = 'planned' WHERE id = 'enc-1'`),
    ).toThrow(/only moves forward/);

    run(db, `UPDATE encounters SET status = 'cancelled' WHERE id = 'enc-1'`);

    for (const status of ['active', 'planned', 'closed']) {
      expect(() =>
        run(db, `UPDATE encounters SET status = ? WHERE id = 'enc-1'`, status),
      ).toThrow(/only moves forward/);
    }
  });

  it("fixes an encounter's clinician, organization, purpose and patient", () => {
    for (const assignment of [
      `clinician_subject = 'someone-else'`,
      `clinician_issuer = NULL, clinician_subject = NULL, organization_id = 'org-1'`,
      `organization_id = 'org-1'`,
      `created_by_subject = 'someone-else'`,
      `id = 'enc-renamed'`,
    ]) {
      expect(() =>
        run(db, `UPDATE encounters SET ${assignment} WHERE id = 'enc-1'`),
      ).toThrow(/cannot change/);
    }

    run(db, `UPDATE encounters SET status = 'active' WHERE id = 'enc-1'`);
    run(
      db,
      `UPDATE encounters SET status = 'closed', ends_at = ? WHERE id = 'enc-1'`,
      T2,
    );

    expect(
      db
        .prepare(
          `SELECT clinician_subject, organization_id, status FROM encounters WHERE id = 'enc-1'`,
        )
        .get(),
    ).toEqual({
      clinician_subject: 'cardiologist-1',
      organization_id: null,
      status: 'closed',
    });
  });

  it('refuses INSERT OR REPLACE over an existing encounter, with or without recursive triggers', () => {
    for (const recursive of ['OFF', 'ON']) {
      db.exec(`PRAGMA recursive_triggers = ${recursive}`);

      expect(() =>
        run(
          db,
          `INSERT OR REPLACE INTO encounters (id, patient_id, purpose, clinician_issuer, clinician_subject, starts_at, ends_at, status, created_by_issuer, created_by_subject, created_at)
                 VALUES ('enc-1', ?, 'direct-treatment', ?, 'intruder', ?, ?, 'active', ?, 'owner-1', ?)`,
          PATIENT,
          ISSUER,
          T1,
          T2,
          ISSUER,
          T1,
        ),
      ).toThrow(/already exists/);
    }

    expect(
      db
        .prepare(`SELECT clinician_subject FROM encounters WHERE id = 'enc-1'`)
        .get(),
    ).toEqual({ clinician_subject: 'cardiologist-1' });
  });
});

describe('sql:a2a_tasks and idp_store', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = openVault(':memory:');
    seedBase(db);
  });

  afterEach(() => {
    db.close();
  });

  /**
   * builds a well-formed task id (server-minted ids are 22+ base64url characters)
   * @param name a short label
   * @returns an id of at least 22 characters
   */
  function taskId(name: string): string {
    return name.padEnd(24, '-');
  }

  /**
   * inserts a task
   * @param task the task columns
   * @param task.id primary key of the inserted row
   * @param task.state the A2A task state
   * @param task.caller the caller subject, or null for unbound
   * @param task.messageId the creating message id
   * @param task.expiresAt when artifact access ends
   */
  function insertTask(task: {
    id: string;
    state: string;
    caller: string | null;
    messageId: string;
    expiresAt?: string;
  }): void {
    const { id, state, caller, messageId, expiresAt = T2 } = task;

    run(
      db,
      `INSERT INTO a2a_tasks (id, context_id, caller_issuer, caller_subject, patient_id, origin_message_id, state, status_json, created_at, updated_at, expires_at)
             VALUES (?, 'ctx-1', ?, ?, ?, ?, ?, json_object('state', ?), ?, ?, ?)`,
      id,
      caller ? ISSUER : null,
      caller,
      PATIENT,
      messageId,
      state,
      state,
      T1,
      T1,
      expiresAt,
    );
  }

  /**
   * reads the bound caller of a task
   * @param id the task id
   * @returns the caller subject, or null when unbound
   */
  function callerOf(id: string): string | null {
    const row = db
      .prepare('SELECT caller_subject FROM a2a_tasks WHERE id = ?')
      .get(id) as { caller_subject: string | null };

    return row.caller_subject;
  }

  it('binds tasks to a caller and only lets AUTH_REQUIRED, REJECTED and FAILED tasks be unbound', () => {
    insertTask({
      id: taskId('t-1'),
      state: 'TASK_STATE_COMPLETED',
      caller: 'c-1',
      messageId: 'm-1',
    });
    insertTask({
      id: taskId('t-2'),
      state: 'TASK_STATE_AUTH_REQUIRED',
      caller: null,
      messageId: 'm-2',
    });

    for (const [n, state] of [
      'TASK_STATE_REJECTED',
      'TASK_STATE_FAILED',
    ].entries()) {
      insertTask({
        id: taskId(`t-ended-${n}`),
        state,
        caller: null,
        messageId: `m-ended-${n}`,
      });
    }

    for (const [n, state] of [
      'TASK_STATE_WORKING',
      'TASK_STATE_COMPLETED',
    ].entries()) {
      expect(() =>
        insertTask({
          id: taskId(`t-3-${n}`),
          state,
          caller: null,
          messageId: `m-3-${n}`,
        }),
      ).toThrow(/CHECK/);
    }
    expect(() =>
      insertTask({
        id: taskId('t-4'),
        state: 'TASK_STATE_WORKING',
        caller: 'c-1',
        messageId: 'm-1',
      }),
    ).toThrow(/already exists/);
    insertTask({
      id: taskId('t-5'),
      state: 'TASK_STATE_WORKING',
      caller: 'c-2',
      messageId: 'm-1',
    });
  });

  it('requires an unguessable-shaped task id', () => {
    for (const id of [
      't-1',
      'short-id-0123456789',
      `${'a'.repeat(21)}`,
      'has space in it-0123456789',
      `${'a'.repeat(87)}`,
      'slash/0123456789012345678',
    ]) {
      expect(() =>
        insertTask({
          id,
          state: 'TASK_STATE_WORKING',
          caller: 'c-1',
          messageId: 'm-id',
        }),
      ).toThrow(/CHECK/);
    }

    insertTask({
      id: 'Zm9vYmFyYmF6cXV4MTIzNA',
      state: 'TASK_STATE_WORKING',
      caller: 'c-1',
      messageId: 'm-id',
    });
  });

  it('allows one unbound task per origin message, independent of the collision guard', () => {
    insertTask({
      id: taskId('t-u1'),
      state: 'TASK_STATE_AUTH_REQUIRED',
      caller: null,
      messageId: 'm-dup',
    });

    expect(() =>
      insertTask({
        id: taskId('t-u2'),
        state: 'TASK_STATE_AUTH_REQUIRED',
        caller: null,
        messageId: 'm-dup',
      }),
    ).toThrow(/already exists/);

    db.exec('DROP TRIGGER a2a_tasks_no_replace');

    expect(() =>
      insertTask({
        id: taskId('t-u2'),
        state: 'TASK_STATE_AUTH_REQUIRED',
        caller: null,
        messageId: 'm-dup',
      }),
    ).toThrow(/UNIQUE/);

    // a different message, and a bound task with the same message, are fine
    insertTask({
      id: taskId('t-u3'),
      state: 'TASK_STATE_AUTH_REQUIRED',
      caller: null,
      messageId: 'm-other',
    });
    insertTask({
      id: taskId('t-b1'),
      state: 'TASK_STATE_WORKING',
      caller: 'c-1',
      messageId: 'm-dup',
    });
  });

  it('binds an unbound task once and then locks the caller', () => {
    insertTask({
      id: taskId('t-lock'),
      state: 'TASK_STATE_AUTH_REQUIRED',
      caller: null,
      messageId: 'm-lock',
    });

    run(
      db,
      `UPDATE a2a_tasks SET caller_issuer = ?, caller_subject = 'c-1', state = 'TASK_STATE_WORKING', status_json = '{"state":"TASK_STATE_WORKING"}' WHERE id = ?`,
      ISSUER,
      taskId('t-lock'),
    );

    expect(callerOf(taskId('t-lock'))).toBe('c-1');

    // rebind to someone else
    expect(() =>
      run(
        db,
        `UPDATE a2a_tasks SET caller_subject = 'c-2' WHERE id = ?`,
        taskId('t-lock'),
      ),
    ).toThrow(/locked/);
    expect(() =>
      run(
        db,
        `UPDATE a2a_tasks SET caller_issuer = 'https://other.example.invalid' WHERE id = ?`,
        taskId('t-lock'),
      ),
    ).toThrow(/locked/);
    // revert to unbound AUTH_REQUIRED
    expect(() =>
      run(
        db,
        `UPDATE a2a_tasks SET caller_issuer = NULL, caller_subject = NULL, state = 'TASK_STATE_AUTH_REQUIRED' WHERE id = ?`,
        taskId('t-lock'),
      ),
    ).toThrow(/locked/);
    expect(callerOf(taskId('t-lock'))).toBe('c-1');

    // writing the same binding again, and other columns, still works
    run(
      db,
      `UPDATE a2a_tasks SET caller_subject = 'c-1', state = 'TASK_STATE_COMPLETED', status_json = '{"state":"TASK_STATE_COMPLETED"}' WHERE id = ?`,
      taskId('t-lock'),
    );
  });

  it('refuses to bind an unbound task into a (caller, message) that already has a task', () => {
    insertTask({
      id: taskId('t-bound'),
      state: 'TASK_STATE_WORKING',
      caller: 'c-1',
      messageId: 'm-same',
    });
    insertTask({
      id: taskId('t-wait'),
      state: 'TASK_STATE_AUTH_REQUIRED',
      caller: null,
      messageId: 'm-same',
    });

    expect(() =>
      run(
        db,
        `UPDATE a2a_tasks SET caller_issuer = ?, caller_subject = 'c-1', state = 'TASK_STATE_WORKING', status_json = '{"state":"TASK_STATE_WORKING"}' WHERE id = ?`,
        ISSUER,
        taskId('t-wait'),
      ),
    ).toThrow(/UNIQUE/);
    expect(callerOf(taskId('t-wait'))).toBeNull();
  });

  it('refuses INSERT OR REPLACE that would swap a task caller, with or without recursive triggers', () => {
    insertTask({
      id: taskId('t-rep'),
      state: 'TASK_STATE_WORKING',
      caller: 'c-1',
      messageId: 'm-rep',
    });

    for (const recursive of ['OFF', 'ON']) {
      db.exec(`PRAGMA recursive_triggers = ${recursive}`);

      // same id, different caller
      expect(() =>
        run(
          db,
          `INSERT OR REPLACE INTO a2a_tasks (id, context_id, caller_issuer, caller_subject, patient_id, origin_message_id, state, status_json, created_at, updated_at, expires_at)
                 VALUES (?, 'ctx-1', ?, 'attacker', ?, 'm-new', 'TASK_STATE_WORKING', '{"state":"TASK_STATE_WORKING"}', ?, ?, ?)`,
          taskId('t-rep'),
          ISSUER,
          PATIENT,
          T1,
          T1,
          T2,
        ),
      ).toThrow(/already exists/);
      // new id, same (caller, message): would delete the existing row
      expect(() =>
        run(
          db,
          `INSERT OR REPLACE INTO a2a_tasks (id, context_id, caller_issuer, caller_subject, patient_id, origin_message_id, state, status_json, created_at, updated_at, expires_at)
                 VALUES (?, 'ctx-1', ?, 'c-1', ?, 'm-rep', 'TASK_STATE_WORKING', '{"state":"TASK_STATE_WORKING"}', ?, ?, ?)`,
          taskId('t-new'),
          ISSUER,
          PATIENT,
          T1,
          T1,
          T2,
        ),
      ).toThrow(/already exists/);
    }

    expect(callerOf(taskId('t-rep'))).toBe('c-1');
    expect(db.prepare('SELECT COUNT(*) AS n FROM a2a_tasks').get()).toEqual({
      n: 1,
    });
  });

  it('fixes identity, sets encounter and receipt once, and never extends the expiry', () => {
    insertTask({
      id: taskId('t-fix'),
      state: 'TASK_STATE_WORKING',
      caller: 'c-1',
      messageId: 'm-fix',
    });
    run(
      db,
      `INSERT INTO receipts (id, patient_id, issued_at, request_id, requester_issuer, requester_subject, encounter_id, purpose, policy_version, decision, rationale_code)
             VALUES ('rcpt-t', ?, ?, 'req-t', ?, 'c-1', 'enc-1', 'direct-treatment', 'p', 'denied', 'no-grant')`,
      PATIENT,
      T1,
      ISSUER,
    );

    for (const assignment of [
      `id = '${taskId('t-other')}'`,
      `patient_id = 'p-2'`,
      `origin_message_id = 'm-other'`,
      `context_id = 'ctx-2'`,
      `created_at = '${T2}'`,
    ]) {
      expect(() =>
        run(
          db,
          `UPDATE a2a_tasks SET ${assignment} WHERE id = ?`,
          taskId('t-fix'),
        ),
      ).toThrow(/fixed once set/);
    }

    expect(() =>
      run(
        db,
        `UPDATE a2a_tasks SET receipt_id = 'no-such-receipt' WHERE id = ?`,
        taskId('t-fix'),
      ),
    ).toThrow(/FOREIGN KEY/);

    run(
      db,
      `UPDATE a2a_tasks SET receipt_id = 'rcpt-t', encounter_id = 'enc-1' WHERE id = ?`,
      taskId('t-fix'),
    );

    expect(() =>
      run(
        db,
        `UPDATE a2a_tasks SET receipt_id = NULL WHERE id = ?`,
        taskId('t-fix'),
      ),
    ).toThrow(/fixed once set/);
    expect(() =>
      run(
        db,
        `UPDATE a2a_tasks SET encounter_id = NULL WHERE id = ?`,
        taskId('t-fix'),
      ),
    ).toThrow(/fixed once set/);

    // the expiry may be shortened, never extended
    run(
      db,
      `UPDATE a2a_tasks SET expires_at = '2026-11-26T10:00:00.000Z' WHERE id = ?`,
      taskId('t-fix'),
    );

    expect(() =>
      run(
        db,
        `UPDATE a2a_tasks SET expires_at = ? WHERE id = ?`,
        T2,
        taskId('t-fix'),
      ),
    ).toThrow(/cannot be extended/);
  });

  it('requires a canonical expiry after creation', () => {
    expect(() =>
      insertTask({
        id: taskId('t-e1'),
        state: 'TASK_STATE_WORKING',
        caller: 'c-1',
        messageId: 'm-e1',
        expiresAt: T1,
      }),
    ).toThrow(/CHECK/);
    expect(() =>
      insertTask({
        id: taskId('t-e2'),
        state: 'TASK_STATE_WORKING',
        caller: 'c-1',
        messageId: 'm-e2',
        expiresAt: '2026-12-25T10:00:00Z',
      }),
    ).toThrow(/CHECK/);
    expect(() =>
      run(
        db,
        `INSERT INTO a2a_tasks (id, context_id, caller_issuer, caller_subject, patient_id, origin_message_id, state, status_json, created_at, updated_at)
               VALUES (?, 'ctx-1', ?, 'c-1', ?, 'm-e3', 'TASK_STATE_WORKING', '{"state":"TASK_STATE_WORKING"}', ?, ?)`,
        taskId('t-e3'),
        ISSUER,
        PATIENT,
        T1,
        T1,
      ),
    ).toThrow(/NOT NULL.*expires_at/);
  });

  it('rejects a state outside the A2A 1.0 set and malformed artifacts', () => {
    expect(() =>
      insertTask({
        id: taskId('t-6'),
        state: 'working',
        caller: 'c-1',
        messageId: 'm-6',
      }),
    ).toThrow(/CHECK/);
    insertTask({
      id: taskId('t-7'),
      state: 'TASK_STATE_COMPLETED',
      caller: 'c-1',
      messageId: 'm-7',
    });

    expect(() =>
      run(
        db,
        `UPDATE a2a_tasks SET artifacts = 'not json' WHERE id = ?`,
        taskId('t-7'),
      ),
    ).toThrow(/CHECK/);
    expect(() =>
      run(
        db,
        `UPDATE a2a_tasks SET artifacts = '{}' WHERE id = ?`,
        taskId('t-7'),
      ),
    ).toThrow(/CHECK/);
    run(
      db,
      `UPDATE a2a_tasks SET artifacts = '[]' WHERE id = ?`,
      taskId('t-7'),
    );
  });

  it('keeps the state column and status_json in agreement', () => {
    expect(() =>
      run(
        db,
        `INSERT INTO a2a_tasks (id, context_id, caller_issuer, caller_subject, patient_id, origin_message_id, state, status_json, created_at, updated_at, expires_at)
               VALUES (?, 'ctx-1', ?, 'c-1', ?, 'm-s1', 'TASK_STATE_COMPLETED', '{"state":"TASK_STATE_WORKING"}', ?, ?, ?)`,
        taskId('t-s1'),
        ISSUER,
        PATIENT,
        T1,
        T1,
        T2,
      ),
    ).toThrow(/CHECK/);

    insertTask({
      id: taskId('t-s2'),
      state: 'TASK_STATE_WORKING',
      caller: 'c-1',
      messageId: 'm-s2',
    });

    expect(() =>
      run(
        db,
        `UPDATE a2a_tasks SET state = 'TASK_STATE_COMPLETED' WHERE id = ?`,
        taskId('t-s2'),
      ),
    ).toThrow(/CHECK/);
    expect(() =>
      run(
        db,
        `UPDATE a2a_tasks SET status_json = '{"state":"TASK_STATE_COMPLETED"}' WHERE id = ?`,
        taskId('t-s2'),
      ),
    ).toThrow(/CHECK/);
  });

  it('binds only a task waiting for sign-in, never one whose sign-in ended', () => {
    for (const state of ['TASK_STATE_REJECTED', 'TASK_STATE_FAILED']) {
      insertTask({
        id: taskId(`t-${state}`),
        state,
        caller: null,
        messageId: `m-${state}`,
      });

      expect(() =>
        run(
          db,
          `UPDATE a2a_tasks SET caller_issuer = ?, caller_subject = 'c-1' WHERE id = ?`,
          ISSUER,
          taskId(`t-${state}`),
        ),
      ).toThrow(/only an AUTH_REQUIRED task can be bound/);
      expect(callerOf(taskId(`t-${state}`))).toBeNull();
    }
  });

  it('never deletes a bound task but lets an abandoned unbound one be purged', () => {
    insertTask({
      id: taskId('t-d-bound'),
      state: 'TASK_STATE_COMPLETED',
      caller: 'c-1',
      messageId: 'm-d-b',
    });
    insertTask({
      id: taskId('t-d-unbound'),
      state: 'TASK_STATE_AUTH_REQUIRED',
      caller: null,
      messageId: 'm-d-u',
    });

    expect(() =>
      run(db, `DELETE FROM a2a_tasks WHERE id = ?`, taskId('t-d-bound')),
    ).toThrow(/bound task cannot be deleted/);

    run(db, `DELETE FROM a2a_tasks WHERE id = ?`, taskId('t-d-unbound'));

    expect(
      db
        .prepare(`SELECT id FROM a2a_tasks WHERE id IN (?, ?) ORDER BY id`)
        .all(taskId('t-d-bound'), taskId('t-d-unbound')),
    ).toEqual([{ id: taskId('t-d-bound') }]);
  });

  it('freezes the state and status of a terminal task but still lets its expiry shrink', () => {
    for (const state of [
      'TASK_STATE_COMPLETED',
      'TASK_STATE_FAILED',
      'TASK_STATE_CANCELED',
      'TASK_STATE_REJECTED',
    ]) {
      insertTask({
        id: taskId(`t-f-${state}`),
        state,
        caller: 'c-1',
        messageId: `m-f-${state}`,
      });

      expect(() =>
        run(
          db,
          `UPDATE a2a_tasks SET state = 'TASK_STATE_WORKING', status_json = '{"state":"TASK_STATE_WORKING"}' WHERE id = ?`,
          taskId(`t-f-${state}`),
        ),
      ).toThrow(/terminal task is frozen/);
      expect(() =>
        run(
          db,
          `UPDATE a2a_tasks SET status_json = json_object('state', state, 'parts', json('[]')) WHERE id = ?`,
          taskId(`t-f-${state}`),
        ),
      ).toThrow(/terminal task is frozen/);

      run(
        db,
        `UPDATE a2a_tasks SET expires_at = ?, updated_at = ? WHERE id = ?`,
        '2026-11-25T10:30:00.000Z',
        '2026-11-25T10:30:00.000Z',
        taskId(`t-f-${state}`),
      );
    }

    // an unbound task's ended sign-in is terminal too
    insertTask({
      id: taskId('t-f-unbound'),
      state: 'TASK_STATE_AUTH_REQUIRED',
      caller: null,
      messageId: 'm-f-u',
    });
    run(
      db,
      `UPDATE a2a_tasks SET state = 'TASK_STATE_FAILED', status_json = '{"state":"TASK_STATE_FAILED"}' WHERE id = ?`,
      taskId('t-f-unbound'),
    );

    expect(() =>
      run(
        db,
        `UPDATE a2a_tasks SET state = 'TASK_STATE_AUTH_REQUIRED', status_json = '{"state":"TASK_STATE_AUTH_REQUIRED"}' WHERE id = ?`,
        taskId('t-f-unbound'),
      ),
    ).toThrow(/terminal task is frozen/);
  });

  it('stores oidc-provider models keyed by model and id', () => {
    const put = (model: string, id: string): void =>
      run(
        db,
        `INSERT INTO idp_store (model, id, payload, grant_id, uid, expires_at) VALUES (?, ?, '{"a":1}', 'g-1', 'u-1', ?)`,
        model,
        id,
        T2,
      );

    put('AccessToken', 'tok-1');
    put('Session', 'tok-1');

    expect(() => put('AccessToken', 'tok-1')).toThrow(/UNIQUE|PRIMARY/);
    expect(() =>
      run(
        db,
        `INSERT INTO idp_store (model, id, payload) VALUES ('Client', 'c', '[]')`,
      ),
    ).toThrow(/CHECK/);
    expect(
      db
        .prepare(`SELECT COUNT(*) AS n FROM idp_store WHERE grant_id = 'g-1'`)
        .get(),
    ).toEqual({ n: 2 });
  });
});

describe('sql:trusted_issuers kinds (0009, ADR-9)', () => {
  let db: DatabaseSync;
  const insert = (
    issuer: string,
    kind: string,
    settings: {
      org?: string | null;
      name?: string | null;
      claim?: string | null;
      roles?: string;
      enabled?: number;
    } = {},
  ): void => {
    db.prepare(
      `INSERT INTO trusted_issuers (issuer, label, audience, allowed_algs, created_at, enabled, kind,
                                    organization_id, organization_name, role_claim, allowed_roles)
       VALUES (?, 'test', 'https://medissy.example.invalid', '["ES256"]', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      issuer,
      T1,
      settings.enabled ?? 1,
      kind,
      settings.org ?? null,
      settings.name ?? null,
      settings.claim ?? null,
      settings.roles ?? '[]',
    );
  };
  const institution = {
    org: 'org-northgate-health',
    name: 'Northgate Health (SYNTHETIC)',
    claim: 'roles',
    roles: '["cardiologist"]',
  };

  beforeEach(() => {
    db = openVault(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('defaults an issuer to the patient kind with no institution settings', () => {
    db.prepare(
      `INSERT INTO trusted_issuers (issuer, label, audience, allowed_algs, created_at) VALUES ('https://a.example/demo-idp', 'test', 'aud', '["ES256"]', ?)`,
    ).run(T1);

    expect({
      ...db
        .prepare(
          'SELECT kind, organization_id, allowed_roles FROM trusted_issuers',
        )
        .get(),
    }).toEqual({ kind: 'patient', organization_id: null, allowed_roles: '[]' });
  });

  it('refuses an institution without its organisation, role claim or allowed roles, and a patient issuer with them', () => {
    expect(() =>
      insert('https://a.example/i', 'institution', {
        ...institution,
        org: null,
      }),
    ).toThrow(/kind settings/);
    expect(() =>
      insert('https://a.example/i', 'institution', {
        ...institution,
        claim: null,
      }),
    ).toThrow(/kind settings/);
    expect(() =>
      insert('https://a.example/i', 'institution', {
        ...institution,
        roles: '[]',
      }),
    ).toThrow(/kind settings/);
    expect(() => insert('https://a.example/p', 'patient', institution)).toThrow(
      /kind settings/,
    );
    expect(() =>
      insert('https://a.example/x', 'hospital', institution),
    ).toThrow(/CHECK/);
  });

  it('allows exactly one enabled institution', () => {
    insert('https://a.example/i', 'institution', institution);
    insert('https://b.example/i', 'institution', {
      ...institution,
      enabled: 0,
    });

    expect(() =>
      insert('https://c.example/i', 'institution', institution),
    ).toThrow(/UNIQUE/);
    expect(() =>
      db
        .prepare(
          "UPDATE trusted_issuers SET enabled = 1 WHERE issuer = 'https://b.example/i'",
        )
        .run(),
    ).toThrow(/UNIQUE/);
  });
});
