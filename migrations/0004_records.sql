-- 0004_records: imported source files, FHIR record copies and sync runs.

-- One row per explicit, patient-triggered sync of the allowed Box folder.
CREATE TABLE sync_runs (
  id               TEXT    NOT NULL PRIMARY KEY,
  patient_id       TEXT    NOT NULL REFERENCES patient (id),
  -- idempotency key for an owner-triggered sync (a double click is one run)
  idempotency_key  TEXT    UNIQUE,
  trigger          TEXT    NOT NULL CHECK (trigger IN ('owner', 'seed', 'test')),
  adapter          TEXT    NOT NULL CHECK (adapter IN ('box-connector', 'fixture')),
  folder_id        TEXT    NOT NULL,
  status           TEXT    NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
  started_at       TEXT    NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', started_at) IS started_at),
  finished_at      TEXT    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', finished_at) IS finished_at),
  files_seen       INTEGER NOT NULL DEFAULT 0 CHECK (files_seen >= 0),
  files_imported   INTEGER NOT NULL DEFAULT 0 CHECK (files_imported >= 0),
  files_duplicate  INTEGER NOT NULL DEFAULT 0 CHECK (files_duplicate >= 0),
  files_rejected   INTEGER NOT NULL DEFAULT 0 CHECK (files_rejected >= 0),
  -- a short, content-free summary (counts and reason codes), never file text
  error_summary    TEXT    CHECK (error_summary IS NULL OR length(error_summary) <= 500),
  CHECK ((status = 'running') = (finished_at IS NULL))
) STRICT;

CREATE INDEX sync_runs_recent ON sync_runs (patient_id, started_at);

-- One row per imported Box file version. The natural key (file id, version,
-- digest) is the deduplication key; an unchanged file is never imported twice.
CREATE TABLE record_sources (
  id            INTEGER NOT NULL PRIMARY KEY,
  patient_id    TEXT    NOT NULL REFERENCES patient (id),
  sync_run_id   TEXT    REFERENCES sync_runs (id),
  provider      TEXT    NOT NULL CHECK (length(provider) BETWEEN 1 AND 120),
  box_file_id   TEXT    NOT NULL CHECK (box_file_id <> '' AND box_file_id NOT GLOB '*[^0-9]*'),
  version       TEXT    NOT NULL CHECK (length(version) BETWEEN 1 AND 64),
  sha256        TEXT    NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  verification  TEXT    NOT NULL CHECK (verification IN ('synthetic-provider', 'patient-entered', 'unverified')),
  imported_at   TEXT    NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', imported_at) IS imported_at),
  UNIQUE (box_file_id, version, sha256)
) STRICT;

-- The authorized personal copy. Records are inserted, never overwritten: a
-- source discrepancy is preserved as separate rows, not reconciled. `category`
-- and `sensitivity` are what policy filters on before any model call.
CREATE TABLE records (
  id            TEXT    NOT NULL PRIMARY KEY,
  patient_id    TEXT    NOT NULL REFERENCES patient (id),
  source_id     INTEGER NOT NULL REFERENCES record_sources (id),
  resource_type TEXT    NOT NULL CHECK (resource_type IN ('Patient', 'AllergyIntolerance', 'MedicationStatement', 'Condition', 'Observation', 'DiagnosticReport', 'DocumentReference', 'Provenance')),
  resource      TEXT    NOT NULL CHECK (json_valid(resource) AND json_type(resource) = 'object' AND json_extract(resource, '$.resourceType') = resource_type),
  category      TEXT    NOT NULL CHECK (category IN ('baseline', 'cardiac', 'dental', 'musculoskeletal', 'dermatology', 'mental-health', 'substance-use')),
  sensitivity   TEXT    NOT NULL CHECK (sensitivity IN ('routine', 'restricted')),
  status        TEXT    NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'superseded', 'entered-in-error')),
  authored_at   TEXT    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', authored_at) IS authored_at),
  -- fail closed on mislabelled sensitive categories
  CHECK (category NOT IN ('mental-health', 'substance-use') OR sensitivity = 'restricted'),
  CHECK (category <> 'baseline' OR sensitivity = 'routine')
) STRICT;

-- Policy filter path: patient + category + sensitivity + status.
CREATE INDEX records_policy_filter ON records (patient_id, category, sensitivity, status);
CREATE INDEX records_by_source ON records (source_id);

-- Policy reads category, sensitivity and status, so only status may change
-- after import. A source discrepancy or re-sync inserts new rows. A record
-- marked entered-in-error stays that way.
CREATE TRIGGER records_only_status_changes
BEFORE UPDATE ON records
WHEN NEW.id IS NOT OLD.id
  OR NEW.patient_id IS NOT OLD.patient_id
  OR NEW.source_id IS NOT OLD.source_id
  OR NEW.resource_type IS NOT OLD.resource_type
  OR NEW.resource IS NOT OLD.resource
  OR NEW.category IS NOT OLD.category
  OR NEW.sensitivity IS NOT OLD.sensitivity
  OR NEW.authored_at IS NOT OLD.authored_at
BEGIN
  SELECT RAISE(ABORT, 'records: only status can change; insert a new record instead');
END;

CREATE TRIGGER records_error_is_final
BEFORE UPDATE ON records
WHEN OLD.status = 'entered-in-error' AND NEW.status <> OLD.status
BEGIN
  SELECT RAISE(ABORT, 'records: an entered-in-error record cannot change status');
END;

-- INSERT OR REPLACE would swap category or sensitivity without an UPDATE.
CREATE TRIGGER records_no_replace
BEFORE INSERT ON records
WHEN EXISTS (SELECT 1 FROM records WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'records: a record with this id already exists');
END;

-- A re-synced Box file whose version or digest differs from what was imported
-- never overwrites or drops the existing record (records.id is the key and
-- only status may change). The incoming copy is parked here, visible, until the
-- owner resolves it:
--  * kept-original:    the existing record stays as it is.
--  * accepted-incoming: the incoming copy is imported as a NEW record under
--                       accepted_record_id. The original record's category and
--                       sensitivity are never rewritten; the original can be
--                       marked superseded (a status change) separately.
-- The incoming copy is the full record envelope JSON, kept verbatim.
CREATE TABLE record_conflicts (
  id                   TEXT NOT NULL PRIMARY KEY,
  record_id            TEXT NOT NULL REFERENCES records (id),
  box_file_id          TEXT NOT NULL CHECK (box_file_id <> '' AND box_file_id NOT GLOB '*[^0-9]*'),
  incoming_version     TEXT NOT NULL CHECK (length(incoming_version) BETWEEN 1 AND 64),
  incoming_sha256      TEXT NOT NULL CHECK (length(incoming_sha256) = 64 AND incoming_sha256 NOT GLOB '*[^0-9a-f]*'),
  incoming_record      TEXT NOT NULL CHECK (json_valid(incoming_record) AND json_type(incoming_record) = 'object'),
  detected_at          TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', detected_at) IS detected_at),
  status               TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'kept-original', 'accepted-incoming')),
  resolved_by_issuer   TEXT,
  resolved_by_subject  TEXT,
  resolved_at          TEXT CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at) IS resolved_at),
  accepted_record_id   TEXT REFERENCES records (id),
  -- the same incoming version of the same record is detected once
  UNIQUE (record_id, incoming_version, incoming_sha256),
  CHECK ((status = 'open') = (resolved_at IS NULL)),
  CHECK ((resolved_by_issuer IS NULL) = (resolved_by_subject IS NULL)),
  CHECK ((status = 'open') = (resolved_by_issuer IS NULL)),
  CHECK ((status = 'accepted-incoming') = (accepted_record_id IS NOT NULL)),
  CHECK (accepted_record_id IS NULL OR accepted_record_id <> record_id)
) STRICT;

CREATE INDEX record_conflicts_open ON record_conflicts (status, detected_at);
CREATE INDEX record_conflicts_by_record ON record_conflicts (record_id);

CREATE TRIGGER record_conflicts_no_replace
BEFORE INSERT ON record_conflicts
WHEN EXISTS (
  SELECT 1 FROM record_conflicts
  WHERE id = NEW.id
     OR (record_id = NEW.record_id
         AND incoming_version = NEW.incoming_version
         AND incoming_sha256 = NEW.incoming_sha256)
)
BEGIN
  SELECT RAISE(ABORT, 'record_conflicts: this conflict already exists');
END;

-- A conflict is recorded open; it can only move forward, once, to a resolution,
-- and only the resolution columns change.
CREATE TRIGGER record_conflicts_open_on_insert
BEFORE INSERT ON record_conflicts
WHEN NEW.status <> 'open'
BEGIN
  SELECT RAISE(ABORT, 'record_conflicts: a conflict is recorded open');
END;

CREATE TRIGGER record_conflicts_resolve_forward_only
BEFORE UPDATE ON record_conflicts
WHEN OLD.status <> 'open'
  OR NEW.status = 'open'
  OR NEW.id IS NOT OLD.id
  OR NEW.record_id IS NOT OLD.record_id
  OR NEW.box_file_id IS NOT OLD.box_file_id
  OR NEW.incoming_version IS NOT OLD.incoming_version
  OR NEW.incoming_sha256 IS NOT OLD.incoming_sha256
  OR NEW.incoming_record IS NOT OLD.incoming_record
  OR NEW.detected_at IS NOT OLD.detected_at
BEGIN
  SELECT RAISE(ABORT, 'record_conflicts: an open conflict can only be resolved, once');
END;

CREATE TRIGGER record_conflicts_no_delete
BEFORE DELETE ON record_conflicts
BEGIN
  SELECT RAISE(ABORT, 'record_conflicts: rows cannot be deleted');
END;
