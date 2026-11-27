-- 0002_sharing: single-use invitations, connections and scope requests.

-- A share QR/link is a single-use invitation. Only the SHA-256 of the random
-- token is stored. Once consumed or revoked the row is frozen by a trigger, so
-- single use is a database invariant, not only application logic.
CREATE TABLE invitations (
  id                TEXT NOT NULL PRIMARY KEY,
  patient_id        TEXT NOT NULL REFERENCES patient (id),
  token_hash        TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  label             TEXT CHECK (label IS NULL OR length(label) BETWEEN 1 AND 80),
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'consumed', 'revoked')),
  created_at        TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  expires_at        TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at),
  consumed_at       TEXT CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', consumed_at) IS consumed_at),
  consumed_by_issuer  TEXT,
  consumed_by_subject TEXT,
  CHECK (created_at < expires_at),
  CHECK ((status = 'consumed') = (consumed_at IS NOT NULL AND consumed_by_issuer IS NOT NULL AND consumed_by_subject IS NOT NULL))
) STRICT;

CREATE TRIGGER invitations_terminal_is_final
BEFORE UPDATE ON invitations
WHEN OLD.status <> 'open'
BEGIN
  SELECT RAISE(ABORT, 'invitations: a consumed or revoked invitation cannot change');
END;

-- INSERT OR REPLACE deletes a colliding row without an UPDATE or DELETE
-- statement, so a consumed invitation could be replaced by an open one with the
-- same token. Refuse any insert that collides with an existing row.
CREATE TRIGGER invitations_no_replace
BEFORE INSERT ON invitations
WHEN EXISTS (SELECT 1 FROM invitations WHERE id = NEW.id OR token_hash = NEW.token_hash)
BEGIN
  SELECT RAISE(ABORT, 'invitations: an invitation with this id or token already exists');
END;

CREATE TRIGGER invitations_no_delete
BEFORE DELETE ON invitations
BEGIN
  SELECT RAISE(ABORT, 'invitations: rows cannot be deleted');
END;

-- Consuming an invitation opens a pending connection that the owner confirms
-- or declines. Display fields are what the requester stated (untrusted).
CREATE TABLE connections (
  id                   TEXT NOT NULL PRIMARY KEY,
  patient_id           TEXT NOT NULL REFERENCES patient (id),
  invitation_id        TEXT NOT NULL UNIQUE REFERENCES invitations (id),
  requester_issuer     TEXT NOT NULL,
  requester_subject    TEXT NOT NULL,
  stated_name          TEXT,
  stated_organization  TEXT,
  stated_role          TEXT,
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'declined', 'ended')),
  created_at           TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  decided_at           TEXT CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', decided_at) IS decided_at),
  CHECK ((status = 'pending') = (decided_at IS NULL))
) STRICT;

-- At most one live (pending or confirmed) connection per requester.
CREATE UNIQUE INDEX connections_one_live_per_requester
  ON connections (patient_id, requester_issuer, requester_subject)
  WHERE status IN ('pending', 'confirmed');

-- A decision is final, except that a confirmed connection may end (its last
-- live grant was revoked); nothing else about the row changes, and an ended
-- connection is final.
CREATE TRIGGER connections_decision_is_final
BEFORE UPDATE ON connections
WHEN OLD.status <> 'pending'
  AND NOT (
    OLD.status = 'confirmed' AND NEW.status = 'ended'
    AND NEW.id IS OLD.id
    AND NEW.patient_id IS OLD.patient_id
    AND NEW.invitation_id IS OLD.invitation_id
    AND NEW.requester_issuer IS OLD.requester_issuer
    AND NEW.requester_subject IS OLD.requester_subject
    AND NEW.stated_name IS OLD.stated_name
    AND NEW.stated_organization IS OLD.stated_organization
    AND NEW.stated_role IS OLD.stated_role
    AND NEW.created_at IS OLD.created_at
    AND NEW.decided_at IS OLD.decided_at
  )
BEGIN
  SELECT RAISE(ABORT, 'connections: a decided connection cannot change');
END;

CREATE TRIGGER connections_end_only_confirmed
BEFORE UPDATE ON connections
WHEN NEW.status = 'ended' AND OLD.status <> 'confirmed'
BEGIN
  SELECT RAISE(ABORT, 'connections: only a confirmed connection can end');
END;

CREATE TRIGGER connections_no_replace
BEFORE INSERT ON connections
WHEN EXISTS (
  SELECT 1 FROM connections
  WHERE id = NEW.id
     OR invitation_id = NEW.invitation_id
     OR (NEW.status IN ('pending', 'confirmed')
         AND patient_id = NEW.patient_id
         AND requester_issuer = NEW.requester_issuer
         AND requester_subject = NEW.requester_subject
         AND status IN ('pending', 'confirmed'))
)
BEGIN
  SELECT RAISE(ABORT, 'connections: a connection for this id, invitation or live requester already exists');
END;

CREATE TRIGGER connections_no_delete
BEFORE DELETE ON connections
BEGIN
  SELECT RAISE(ABORT, 'connections: rows cannot be deleted');
END;

-- A clinician's request to widen scope. `request_id` is the requester's
-- idempotency key. `grant_id` is the first grant version issued on approval;
-- it has no foreign key because grants.scope_request_id already points here and
-- a grant id is only unique together with its version.
CREATE TABLE scope_requests (
  id                  TEXT NOT NULL PRIMARY KEY,
  request_id          TEXT NOT NULL,
  patient_id          TEXT NOT NULL REFERENCES patient (id),
  requester_issuer    TEXT NOT NULL REFERENCES trusted_issuers (issuer),
  requester_subject   TEXT NOT NULL,
  encounter_id        TEXT NOT NULL REFERENCES encounters (id),
  requested_categories TEXT NOT NULL CHECK (json_valid(requested_categories) AND json_type(requested_categories) = 'array' AND json_array_length(requested_categories) > 0),
  reason              TEXT NOT NULL CHECK (length(reason) <= 1000),
  desired_expires_at  TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', desired_expires_at) IS desired_expires_at),
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'expired', 'cancelled')),
  created_at          TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  decided_at          TEXT CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', decided_at) IS decided_at),
  grant_id            TEXT,
  UNIQUE (requester_issuer, requester_subject, request_id),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK ((status = 'approved') = (grant_id IS NOT NULL))
) STRICT;

CREATE INDEX scope_requests_pending ON scope_requests (patient_id, status, created_at);

CREATE TRIGGER scope_requests_decision_is_final
BEFORE UPDATE ON scope_requests
WHEN OLD.status <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'scope_requests: a decided request cannot change');
END;

CREATE TRIGGER scope_requests_no_replace
BEFORE INSERT ON scope_requests
WHEN EXISTS (
  SELECT 1 FROM scope_requests
  WHERE id = NEW.id
     OR (requester_issuer = NEW.requester_issuer
         AND requester_subject = NEW.requester_subject
         AND request_id = NEW.request_id)
)
BEGIN
  SELECT RAISE(ABORT, 'scope_requests: a request with this id or idempotency key already exists');
END;

-- Requested categories are a closed, duplicate-free set of record categories.
CREATE TRIGGER scope_requests_categories_valid
BEFORE INSERT ON scope_requests
WHEN json_valid(NEW.requested_categories) AND json_type(NEW.requested_categories) = 'array'
 AND (
   EXISTS (
     SELECT 1 FROM json_each(NEW.requested_categories)
     WHERE type <> 'text'
        OR value NOT IN ('baseline', 'cardiac', 'dental', 'musculoskeletal', 'dermatology', 'mental-health', 'substance-use')
   )
   OR (SELECT COUNT(*) FROM json_each(NEW.requested_categories))
      <> (SELECT COUNT(DISTINCT value) FROM json_each(NEW.requested_categories))
 )
BEGIN
  SELECT RAISE(ABORT, 'scope_requests: requested_categories must be unique known categories');
END;

CREATE TRIGGER scope_requests_no_delete
BEFORE DELETE ON scope_requests
BEGIN
  SELECT RAISE(ABORT, 'scope_requests: rows cannot be deleted');
END;
