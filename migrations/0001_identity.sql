-- 0001_identity: patient, trusted issuers, clinician registry, encounters.
--
-- Conventions (all migrations):
--  * STRICT tables; foreign keys are enforced (the runner turns them on).
--  * Every *_at column is canonical UTC text, YYYY-MM-DDTHH:MM:SS.sssZ, so
--    string comparison equals time comparison. The CHECK re-formats the value
--    with strftime and requires an exact match; NULL passes only where the
--    column is nullable.
--  * Lists and objects are JSON text guarded by json_valid/json_type.
--  * Migrations are forward-only. Rollback means restoring the backup taken
--    before the run; the runner never drops or rewrites applied history.
--  * Open the database only through openVault() (src/vault/migrate.ts), which
--    turns on foreign keys and recursive triggers. Tables whose rows policy
--    depends on also carry BEFORE INSERT collision guards, so INSERT OR
--    REPLACE cannot overwrite them even on a connection that skipped it.

-- One synthetic patient per vault. `singleton` + UNIQUE caps the table at one
-- row; `synthetic = 1` refuses a row that is not labelled synthetic.
CREATE TABLE patient (
  id            TEXT    NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  singleton     INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (singleton = 1),
  synthetic     INTEGER NOT NULL DEFAULT 1 CHECK (synthetic = 1),
  label         TEXT    NOT NULL CHECK (label LIKE '%SYNTHETIC%'),
  owner_issuer  TEXT    NOT NULL,
  owner_subject TEXT    NOT NULL,
  created_at    TEXT    NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at)
) STRICT;

-- Issuers whose access tokens Medissy accepts. The algorithm allowlist and
-- audience are per issuer so a token from any other issuer is rejected.
CREATE TABLE trusted_issuers (
  issuer       TEXT    NOT NULL PRIMARY KEY CHECK (issuer LIKE 'http://%' OR issuer LIKE 'https://%'),
  label        TEXT    NOT NULL,
  audience     TEXT    NOT NULL,
  allowed_algs TEXT    NOT NULL CHECK (json_valid(allowed_algs) AND json_type(allowed_algs) = 'array' AND json_array_length(allowed_algs) > 0),
  jwks_uri     TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at   TEXT    NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at)
) STRICT;

-- Server-managed registry of verified clinicians, keyed by (issuer, subject).
-- Organization and roles come from here, never from token claims alone.
CREATE TABLE clinicians (
  issuer            TEXT NOT NULL REFERENCES trusted_issuers (issuer),
  subject           TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
  display_name      TEXT NOT NULL,
  organization_id   TEXT,
  organization_name TEXT,
  roles             TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(roles) AND json_type(roles) = 'array'),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  verified_at       TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', verified_at) IS verified_at),
  created_at        TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  PRIMARY KEY (issuer, subject)
) STRICT, WITHOUT ROWID;

CREATE INDEX clinicians_by_organization ON clinicians (organization_id);

-- Encounters are created by the owner only. A request's encounter is always
-- read from this table, never trusted from the caller.
CREATE TABLE encounters (
  id                TEXT NOT NULL PRIMARY KEY,
  patient_id        TEXT NOT NULL REFERENCES patient (id),
  purpose           TEXT NOT NULL CHECK (purpose IN ('direct-treatment')),
  reason            TEXT CHECK (reason IS NULL OR length(reason) <= 500),
  clinician_issuer  TEXT REFERENCES trusted_issuers (issuer),
  clinician_subject TEXT,
  organization_id   TEXT,
  starts_at         TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', starts_at) IS starts_at),
  ends_at           TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', ends_at) IS ends_at),
  status            TEXT NOT NULL CHECK (status IN ('planned', 'active', 'closed', 'cancelled')),
  created_by_issuer  TEXT NOT NULL,
  created_by_subject TEXT NOT NULL,
  created_at        TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  CHECK ((clinician_issuer IS NULL) = (clinician_subject IS NULL)),
  CHECK (clinician_subject IS NOT NULL OR organization_id IS NOT NULL),
  CHECK (starts_at < ends_at)
) STRICT;

CREATE INDEX encounters_by_clinician ON encounters (clinician_issuer, clinician_subject);

-- Policy inputs are fixed once an encounter exists: who it is for, what it is
-- for, and which patient. Status and the time window may change (an owner
-- closes or cancels an encounter); the people and purpose may not, so a grant
-- tied to this encounter cannot be redirected to someone else.
CREATE TRIGGER encounters_policy_inputs_are_fixed
BEFORE UPDATE ON encounters
WHEN NEW.id IS NOT OLD.id
  OR NEW.patient_id IS NOT OLD.patient_id
  OR NEW.purpose IS NOT OLD.purpose
  OR NEW.clinician_issuer IS NOT OLD.clinician_issuer
  OR NEW.clinician_subject IS NOT OLD.clinician_subject
  OR NEW.organization_id IS NOT OLD.organization_id
  OR NEW.created_by_issuer IS NOT OLD.created_by_issuer
  OR NEW.created_by_subject IS NOT OLD.created_by_subject
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'encounters: clinician, organization, purpose and patient cannot change');
END;

-- An encounter's window may only shrink and its lifecycle only moves forward
-- (planned -> active -> closed, or -> cancelled); a closed or cancelled
-- encounter can never be reopened to widen access.
CREATE TRIGGER encounters_window_and_lifecycle
BEFORE UPDATE ON encounters
WHEN NEW.starts_at IS NOT OLD.starts_at
  OR NEW.ends_at > OLD.ends_at
  OR (OLD.status IN ('closed', 'cancelled') AND NEW.status IS NOT OLD.status)
  OR (OLD.status = 'active' AND NEW.status = 'planned')
BEGIN
  SELECT RAISE(ABORT, 'encounters: window may only shrink and status only moves forward');
END;

-- INSERT OR REPLACE would swap an encounter's people without an UPDATE.
CREATE TRIGGER encounters_no_replace
BEFORE INSERT ON encounters
WHEN EXISTS (SELECT 1 FROM encounters WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'encounters: an encounter with this id already exists');
END;
