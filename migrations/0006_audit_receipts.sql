-- 0006_audit_receipts: append-only audit log and disclosure receipts.
--
-- Limits, stated honestly: the triggers stop UPDATE and DELETE through SQL on
-- these tables. They do not stop someone with file access from dropping a
-- trigger, dropping the table, or editing the database file. This is
-- append-only enforcement, not tamper-proofing; no hash chain is provided.
--
-- INSERT OR REPLACE would delete a conflicting row without firing the DELETE
-- trigger (unless recursive_triggers is on), so each table also has a BEFORE
-- INSERT guard that refuses any insert colliding with an existing row.

CREATE TABLE audit_events (
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
                  'sync.completed', 'sync.failed', 'task.denied', 'auth.rejected')),
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

-- One receipt per decision (released or denied). (requester, request_id) is
-- the idempotency key: a replayed request id can never mint a second release.
-- encounter_id is as attempted and deliberately has no foreign key, so a
-- denial for a guessed encounter id can still be recorded.
--
-- What was released, and under which grant, lives in receipt_records, one row
-- per record, because different records in one release can rest on different
-- grants. released_count says how many rows the receipt owns; write the
-- receipt and its rows in one transaction, and view receipt_release_mismatches
-- lists any receipt whose rows do not add up.
CREATE TABLE receipts (
  id                 TEXT    NOT NULL PRIMARY KEY,
  patient_id         TEXT    NOT NULL REFERENCES patient (id),
  issued_at          TEXT    NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', issued_at) IS issued_at),
  request_id         TEXT    NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  requester_issuer   TEXT    NOT NULL,
  requester_subject  TEXT    NOT NULL,
  organization_id    TEXT,
  roles              TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(roles) AND json_type(roles) = 'array'),
  encounter_id       TEXT    NOT NULL CHECK (length(encounter_id) BETWEEN 1 AND 128),
  purpose            TEXT    NOT NULL CHECK (purpose IN ('direct-treatment')),
  policy_version     TEXT    NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 64),
  approved_categories TEXT   NOT NULL DEFAULT '[]' CHECK (json_valid(approved_categories) AND json_type(approved_categories) = 'array'),
  released_count     INTEGER NOT NULL DEFAULT 0 CHECK (released_count >= 0),
  decision           TEXT    NOT NULL CHECK (decision IN ('released', 'denied')),
  rationale_code     TEXT    NOT NULL CHECK (length(rationale_code) BETWEEN 1 AND 64),
  UNIQUE (requester_issuer, requester_subject, request_id),
  -- a denial releases nothing; a release releases at least one record
  CHECK ((decision = 'released') = (released_count > 0))
) STRICT;

CREATE INDEX receipts_by_time ON receipts (patient_id, issued_at);

-- One row per released record: the record, the source version it came from,
-- and the exact grant version that covered it. A row can only be added to a
-- release that still has room, and only while that grant version is the
-- latest, unrevoked, allow, in-window, for this receipt's encounter.
CREATE TABLE receipt_records (
  receipt_id     TEXT    NOT NULL REFERENCES receipts (id),
  record_id      TEXT    NOT NULL REFERENCES records (id),
  source_version TEXT    NOT NULL CHECK (length(source_version) BETWEEN 1 AND 64),
  grant_id       TEXT    NOT NULL,
  grant_version  INTEGER NOT NULL,
  PRIMARY KEY (receipt_id, record_id),
  FOREIGN KEY (grant_id, grant_version) REFERENCES grants (id, version)
) STRICT, WITHOUT ROWID;

CREATE INDEX receipt_records_by_grant ON receipt_records (grant_id, grant_version);
CREATE INDEX receipt_records_by_record ON receipt_records (record_id);

CREATE VIEW receipt_release_mismatches AS
SELECT r.id AS receipt_id, r.released_count, COUNT(c.record_id) AS recorded
FROM receipts AS r
LEFT JOIN receipt_records AS c ON c.receipt_id = r.id
GROUP BY r.id
HAVING r.released_count <> COUNT(c.record_id);

CREATE TRIGGER receipt_records_no_replace
BEFORE INSERT ON receipt_records
WHEN EXISTS (SELECT 1 FROM receipt_records WHERE receipt_id = NEW.receipt_id AND record_id = NEW.record_id)
BEGIN
  SELECT RAISE(ABORT, 'receipt_records is append-only: this record is already on the receipt');
END;

CREATE TRIGGER receipt_records_receipt_has_room
BEFORE INSERT ON receipt_records
WHEN NOT EXISTS (
  SELECT 1 FROM receipts AS r
  WHERE r.id = NEW.receipt_id
    AND r.decision = 'released'
    AND (SELECT COUNT(*) FROM receipt_records WHERE receipt_id = r.id) < r.released_count
)
BEGIN
  SELECT RAISE(ABORT, 'receipt_records: the receipt is not a release, or already lists all its records');
END;

CREATE TRIGGER receipt_records_grant_is_live
BEFORE INSERT ON receipt_records
WHEN NOT EXISTS (
  SELECT 1
  FROM grants AS g
  JOIN receipts AS r ON r.id = NEW.receipt_id
  WHERE g.id = NEW.grant_id
    AND g.version = NEW.grant_version
    AND g.version = (SELECT MAX(version) FROM grants WHERE id = g.id)
    AND g.revoked_at IS NULL
    AND g.effect = 'allow'
    AND g.valid_from <= r.issued_at
    AND r.issued_at < g.expires_at
    AND g.encounter_id = r.encounter_id
    AND g.patient_id = r.patient_id
)
BEGIN
  SELECT RAISE(ABORT, 'receipt_records: the grant must be the latest unrevoked allow version in force for this encounter');
END;

CREATE TRIGGER receipt_records_no_update
BEFORE UPDATE ON receipt_records
BEGIN
  SELECT RAISE(ABORT, 'receipt_records is append-only: UPDATE is not allowed');
END;

CREATE TRIGGER receipt_records_no_delete
BEFORE DELETE ON receipt_records
BEGIN
  SELECT RAISE(ABORT, 'receipt_records is append-only: DELETE is not allowed');
END;

CREATE TRIGGER receipts_no_replace
BEFORE INSERT ON receipts
WHEN EXISTS (
  SELECT 1 FROM receipts
  WHERE id = NEW.id
     OR (requester_issuer = NEW.requester_issuer AND requester_subject = NEW.requester_subject AND request_id = NEW.request_id)
)
BEGIN
  SELECT RAISE(ABORT, 'receipts is append-only: a receipt for this id or request already exists');
END;

CREATE TRIGGER receipts_no_update
BEFORE UPDATE ON receipts
BEGIN
  SELECT RAISE(ABORT, 'receipts is append-only: UPDATE is not allowed');
END;

CREATE TRIGGER receipts_no_delete
BEFORE DELETE ON receipts
BEGIN
  SELECT RAISE(ABORT, 'receipts is append-only: DELETE is not allowed');
END;
