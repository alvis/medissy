-- 0010_inbound_records: records a clinician hands back (ADR-10).
--
-- A verified clinician with an active grant submits a record over A2A; it is
-- filed into the patient's secure store (the Box folder) and imported through
-- the ordinary provenance path (record_sources with the Box file id, version
-- and digest, sync_run_id NULL), so a later sync treats the file as already
-- imported. inbound_submissions is the patient's receipt for each one.
--
-- 1. audit_events gains two closed-set types, record.submitted and
--    record.removed. SQLite cannot alter a CHECK, so the table is rebuilt with
--    every row, index and append-only trigger kept. DROP TABLE's implicit
--    delete fires no trigger, and nothing references audit_events.

CREATE TABLE audit_events_v9 (
  seq           INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  id            TEXT    NOT NULL UNIQUE,
  occurred_at   TEXT    NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) IS occurred_at),
  -- closed set; keep in step with AUDIT_EVENT_TYPES (src/contracts/audit.ts),
  -- which a spec test checks value by value
  type          TEXT    NOT NULL CHECK (type IN (
                  'disclosure.released', 'disclosure.denied', 'grant.created', 'grant.revoked',
                  'scope.requested', 'scope.approved', 'scope.declined',
                  'invitation.created', 'invitation.consumed',
                  'connection.confirmed', 'connection.declined',
                  'sync.completed', 'sync.failed', 'task.denied', 'auth.rejected',
                  'record.submitted', 'record.removed')),
  outcome       TEXT    NOT NULL CHECK (outcome IN ('success', 'denied', 'error')),
  actor_kind    TEXT    NOT NULL CHECK (actor_kind IN ('owner', 'clinician', 'system', 'anonymous')),
  actor_issuer  TEXT,
  actor_subject TEXT,
  patient_id    TEXT    REFERENCES patient (id),
  request_id    TEXT,
  receipt_id    TEXT,
  target_type   TEXT,
  target_id     TEXT,
  -- scalars only; clinical text never belongs here
  details       TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(details) AND json_type(details) = 'object'),
  CHECK ((actor_issuer IS NULL) = (actor_subject IS NULL)),
  CHECK ((actor_kind IN ('owner', 'clinician')) = (actor_issuer IS NOT NULL)),
  CHECK ((target_type IS NULL) = (target_id IS NULL))
) STRICT;

INSERT INTO audit_events_v9 (seq, id, occurred_at, type, outcome, actor_kind, actor_issuer, actor_subject,
                             patient_id, request_id, receipt_id, target_type, target_id, details)
SELECT seq, id, occurred_at, type, outcome, actor_kind, actor_issuer, actor_subject,
       patient_id, request_id, receipt_id, target_type, target_id, details
FROM audit_events ORDER BY seq;

DROP TABLE audit_events;
ALTER TABLE audit_events_v9 RENAME TO audit_events;

CREATE INDEX audit_events_by_time ON audit_events (patient_id, occurred_at);
CREATE INDEX audit_events_by_request ON audit_events (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX audit_events_by_receipt ON audit_events (receipt_id) WHERE receipt_id IS NOT NULL;

CREATE TRIGGER audit_events_no_replace
BEFORE INSERT ON audit_events
WHEN EXISTS (SELECT 1 FROM audit_events WHERE id = NEW.id OR seq = NEW.seq)
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only: row already exists');
END;

CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only: UPDATE is not allowed');
END;

CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only: DELETE is not allowed');
END;

-- 2. One receipt per filed submission. Who submitted it is the verified
--    clinician bound to the task, with the registry name and organisation at
--    the time. Its status is the record's (current until the patient removes
--    it as entered-in-error); removal is recorded once and never undone.
CREATE TABLE inbound_submissions (
  id                 TEXT    NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  patient_id         TEXT    NOT NULL REFERENCES patient (id),
  record_id          TEXT    NOT NULL UNIQUE REFERENCES records (id),
  source_id          INTEGER NOT NULL UNIQUE REFERENCES record_sources (id),
  request_id         TEXT    NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  grant_id           TEXT    NOT NULL CHECK (length(grant_id) BETWEEN 1 AND 128),
  submitter_issuer   TEXT    NOT NULL CHECK (length(submitter_issuer) BETWEEN 1 AND 512),
  submitter_subject  TEXT    NOT NULL CHECK (length(submitter_subject) BETWEEN 1 AND 255),
  submitter_name     TEXT    NOT NULL CHECK (length(submitter_name) BETWEEN 1 AND 120),
  organization_name  TEXT    CHECK (organization_name IS NULL OR length(organization_name) BETWEEN 1 AND 120),
  filed_name         TEXT    NOT NULL CHECK (length(filed_name) BETWEEN 1 AND 120),
  resource_type      TEXT    NOT NULL CHECK (resource_type IN ('AllergyIntolerance', 'MedicationStatement', 'Condition', 'Observation', 'DiagnosticReport', 'DocumentReference')),
  category           TEXT    NOT NULL CHECK (category IN ('cardiac', 'dental', 'musculoskeletal', 'dermatology')),
  submitted_at       TEXT    NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', submitted_at) IS submitted_at),
  removed_at         TEXT    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', removed_at) IS removed_at),
  removed_by_issuer  TEXT,
  removed_by_subject TEXT,
  CHECK ((removed_at IS NULL) = (removed_by_issuer IS NULL)),
  CHECK ((removed_by_issuer IS NULL) = (removed_by_subject IS NULL))
) STRICT;

CREATE INDEX inbound_submissions_recent ON inbound_submissions (patient_id, submitted_at);

-- Only the removal fields may change, and only from unset to set.
CREATE TRIGGER inbound_submissions_only_removal
BEFORE UPDATE ON inbound_submissions
WHEN OLD.removed_at IS NOT NULL
  OR NEW.id IS NOT OLD.id
  OR NEW.patient_id IS NOT OLD.patient_id
  OR NEW.record_id IS NOT OLD.record_id
  OR NEW.source_id IS NOT OLD.source_id
  OR NEW.request_id IS NOT OLD.request_id
  OR NEW.grant_id IS NOT OLD.grant_id
  OR NEW.submitter_issuer IS NOT OLD.submitter_issuer
  OR NEW.submitter_subject IS NOT OLD.submitter_subject
  OR NEW.submitter_name IS NOT OLD.submitter_name
  OR NEW.organization_name IS NOT OLD.organization_name
  OR NEW.filed_name IS NOT OLD.filed_name
  OR NEW.resource_type IS NOT OLD.resource_type
  OR NEW.category IS NOT OLD.category
  OR NEW.submitted_at IS NOT OLD.submitted_at
BEGIN
  SELECT RAISE(ABORT, 'inbound_submissions: only a first removal may be recorded');
END;

CREATE TRIGGER inbound_submissions_no_delete
BEFORE DELETE ON inbound_submissions
BEGIN
  SELECT RAISE(ABORT, 'inbound_submissions: DELETE is not allowed');
END;

CREATE TRIGGER inbound_submissions_no_replace
BEFORE INSERT ON inbound_submissions
WHEN EXISTS (SELECT 1 FROM inbound_submissions WHERE id = NEW.id OR record_id = NEW.record_id OR source_id = NEW.source_id)
BEGIN
  SELECT RAISE(ABORT, 'inbound_submissions: row already exists');
END;
