/**
 * the vault database: numbered migrations and the only supported way to open
 * it
 *
 * `openVault` is the ONLY way application code opens the vault database; it
 * sets the connection settings the schema's integrity rules rely on (foreign
 * keys, `recursive_triggers`, a busy timeout, WAL and full sync for files) and
 * brings the schema up to date; never construct a `DatabaseSync` for the vault
 * directly: a bare connection has `foreign_keys` off, so foreign keys and the
 * receipt, grant and task integrity they back would not be enforced; the
 * append-only and collision-guard triggers hold even then (they do not depend
 * on a pragma), but the foreign keys do not; `migrate` and
 * `configureConnection` are exported for tests and tools that already hold a
 * connection; they apply the same settings
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** `0001_name.sql`: four-digit version, snake_case name */
const MIGRATION_FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const BUSY_TIMEOUT_MS = 5000;
const IN_MEMORY = ':memory:';

/** a numbered SQL migration read from disk */
export interface Migration {
  /** dense, 1-based version taken from the file name */
  version: number;
  name: string;
  sql: string;
  /** SHA-256 of the file contents, recorded when the migration is applied */
  checksum: string;
}

/** what a `migrate` call did */
export interface MigrationResult {
  /** versions applied by this call, in order */
  applied: number[];
  /** highest version present after the call (0 when there are none) */
  current: number;
}

/** options for `migrate` and `openVault` */
export interface MigrateOptions {
  /** directory holding the numbered `.sql` files; defaults to `migrations/` */
  dir?: string;
  /** use these migrations instead of reading `dir` (tests) */
  migrations?: readonly Migration[];
  /** clock used for `applied_at`; defaults to `new Date()` */
  now?: () => Date;
}

/** an error raised when the migration set or the database history is inconsistent */
export class MigrationError extends Error {
  /**
   * @param message failure text naming the migration version
   * @param options standard error options carrying the underlying cause
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

/**
 * locates the repository `migrations/` directory from this module, which works
 * both from `src/vault` and from the built `dist/vault`
 * @returns the absolute path of the default migrations directory
 */
export function defaultMigrationsDir(): string {
  return resolve(import.meta.dirname, '..', '..', 'migrations');
}

/**
 * reads and validates the numbered migrations in a directory
 * @param dir directory holding `NNNN_name.sql` files
 * @returns the migrations in ascending version order
 */
export function loadMigrations(
  dir: string = defaultMigrationsDir(),
): Migration[] {
  const migrations: Migration[] = [];

  for (const file of readdirSync(dir).sort()) {
    const match = MIGRATION_FILE.exec(file);

    if (!match) {
      if (file.endsWith('.sql')) {
        throw new MigrationError(
          `migration file name is not NNNN_name.sql: ${file}`,
        );
      }

      continue;
    }

    const sql = readFileSync(join(dir, file), 'utf8');

    migrations.push({
      version: Number(match[1]),
      name: match[2] ?? '',
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }

  assertDense(migrations);

  return migrations;
}

/**
 * requires versions 1..n with no gaps or duplicates
 * @param migrations the migrations to check, in ascending order
 */
function assertDense(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new MigrationError(
        `migration versions must be 1..n without gaps or duplicates; expected ${index + 1}, found ${migration.version}`,
      );
    }
  });
}

/**
 * applies the per-connection settings Medissy's schema relies on: foreign keys
 * are enforced, and `recursive_triggers` makes the implicit delete of an
 * `INSERT OR REPLACE` fire the append-only and frozen-row triggers
 * @param db an open database
 */
export function configureConnection(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA recursive_triggers = ON');
}

/**
 * applies every pending migration, each in its own `BEGIN IMMEDIATE`
 * transaction; SQLite DDL is transactional, so a failing migration leaves no
 * trace; the call is idempotent: applied migrations are verified against their
 * recorded checksum and skipped; migrations are forward-only
 * @param db an open database
 * @param options where to read migrations from, and the clock
 * @returns the versions applied and the resulting schema version
 */
export function migrate(
  db: DatabaseSync,
  options: MigrateOptions = {},
): MigrationResult {
  const migrations = options.migrations ?? loadMigrations(options.dir);
  const now = options.now ?? (() => new Date());

  assertDense(migrations);
  configureConnection(db);
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER NOT NULL PRIMARY KEY,
    name       TEXT    NOT NULL,
    checksum   TEXT    NOT NULL,
    applied_at TEXT    NOT NULL
  ) STRICT`);

  verifyHistory(db, migrations);

  const applied: number[] = [];

  for (const migration of migrations) {
    if (applyOne(db, migration, now())) {
      applied.push(migration.version);
    }
  }

  return { applied, current: migrations.length };
}

/**
 * checks that the database history is a checksum-identical prefix of the code
 * @param db an open database holding `schema_migrations`
 * @param migrations the migrations the code ships
 */
function verifyHistory(
  db: DatabaseSync,
  migrations: readonly Migration[],
): void {
  const rows = db
    .prepare(
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
    )
    .all() as Array<{ version: number; name: string; checksum: string }>;

  rows.forEach((row, index) => {
    const expected = migrations[index];

    if (row.version !== index + 1) {
      throw new MigrationError(
        `database migration history has a gap at version ${index + 1}`,
      );
    }

    if (!expected) {
      throw new MigrationError(
        `database is at version ${row.version}, newer than this code (${migrations.length})`,
      );
    }

    if (expected.name !== row.name || expected.checksum !== row.checksum) {
      throw new MigrationError(
        `applied migration ${row.version} (${row.name}) was edited after it ran; add a new migration instead`,
      );
    }
  });
}

/**
 * applies one migration unless another process already has
 * @param db an open database
 * @param migration the migration to apply
 * @param at the application time
 * @returns true when this call applied the migration
 */
function applyOne(db: DatabaseSync, migration: Migration, at: Date): boolean {
  db.exec('BEGIN IMMEDIATE');

  try {
    const done = db
      .prepare('SELECT 1 FROM schema_migrations WHERE version = ?')
      .get(migration.version);

    if (done) {
      db.exec('COMMIT');

      return false;
    }

    db.exec(migration.sql);
    db.prepare(
      'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
    ).run(
      migration.version,
      migration.name,
      migration.checksum,
      at.toISOString(),
    );
    db.exec('COMMIT');

    return true;
  } catch (error) {
    db.exec('ROLLBACK');

    throw new MigrationError(
      `migration ${migration.version} (${migration.name}) failed`,
      {
        cause: error,
      },
    );
  }
}

/**
 * opens the vault database with Medissy's connection settings and brings its
 * schema up to date; foreign keys are enforced and a busy timeout is set;
 * file databases use WAL with full synchronous durability so an audit write
 * that returned is on disk
 * @param path a database file path, or `:memory:`
 * @param options migration options
 * @returns the open, migrated database
 */
export function openVault(
  path: string,
  options: MigrateOptions = {},
): DatabaseSync {
  const db = new DatabaseSync(path);

  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);

  if (path !== IN_MEMORY) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
  }

  migrate(db, options);

  return db;
}
