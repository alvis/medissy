-- 0003_grants: versioned, immutable patient grants.
--
-- A grant id has many versions; each version is its own row and no row is ever
-- updated or deleted. A change, including revocation, inserts version + 1 (a
-- revocation is a new version with revoked_at set). The effective grant is the
-- highest version of an id (view current_grants).
--
-- Evaluation semantics live in src/contracts/grant.ts (the exact release
-- predicate): deny-overrides, and an allow grant covers a record only on the
-- intersection of category, sensitivity and (optionally) record id.
-- `effect` has no default: every grant states allow or deny.

CREATE TABLE grants (
  id                       TEXT    NOT NULL,
  version                  INTEGER NOT NULL CHECK (version >= 1),
  patient_id               TEXT    NOT NULL REFERENCES patient (id),
  effect                   TEXT    NOT NULL CHECK (effect IN ('allow', 'deny')),
  grantee_issuer           TEXT    NOT NULL REFERENCES trusted_issuers (issuer),
  grantee_subject          TEXT,
  grantee_organization_id  TEXT,
  grantee_roles            TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(grantee_roles) AND json_type(grantee_roles) = 'array'),
  encounter_id             TEXT    NOT NULL REFERENCES encounters (id),
  purpose                  TEXT    NOT NULL CHECK (purpose IN ('direct-treatment')),
  categories               TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(categories) AND json_type(categories) = 'array'),
  max_sensitivity          TEXT    NOT NULL CHECK (max_sensitivity IN ('routine', 'restricted')),
  allow_baseline           INTEGER NOT NULL CHECK (allow_baseline IN (0, 1)),
  allowed_record_ids       TEXT    CHECK (allowed_record_ids IS NULL OR (json_valid(allowed_record_ids) AND json_type(allowed_record_ids) = 'array' AND json_array_length(allowed_record_ids) > 0)),
  valid_from               TEXT    NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', valid_from) IS valid_from),
  expires_at               TEXT    NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at),
  revoked_at               TEXT    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at) IS revoked_at),
  source                   TEXT    NOT NULL CHECK (source IN ('owner', 'scope-request')),
  scope_request_id         TEXT    REFERENCES scope_requests (id),
  created_by_issuer        TEXT    NOT NULL,
  created_by_subject       TEXT    NOT NULL,
  created_at               TEXT    NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  PRIMARY KEY (id, version),
  CHECK (valid_from < expires_at),
  -- a person, or an organization with roles; an organization and its roles
  -- come together, and an organization alone is not enough
  CHECK (grantee_subject IS NOT NULL OR grantee_organization_id IS NOT NULL),
  CHECK ((grantee_organization_id IS NULL) = (json_array_length(grantee_roles) = 0)),
  CHECK ((source = 'scope-request') = (scope_request_id IS NOT NULL)),
  -- an allow grant must cover something; a deny grant names categories only
  CHECK (effect = 'deny' OR allow_baseline = 1 OR json_array_length(categories) > 0),
  CHECK (effect = 'allow' OR (json_array_length(categories) > 0 AND allow_baseline = 0 AND allowed_record_ids IS NULL))
) STRICT, WITHOUT ROWID;

CREATE INDEX grants_by_grantee ON grants (grantee_issuer, grantee_subject, encounter_id);
CREATE INDEX grants_by_encounter ON grants (encounter_id);

-- Versions must be dense (1, 2, 3, ...) and a revoked grant is final: no later
-- version may follow a version that carries revoked_at.
CREATE TRIGGER grants_version_is_next
BEFORE INSERT ON grants
WHEN NEW.version <> COALESCE((SELECT MAX(version) FROM grants WHERE id = NEW.id), 0) + 1
BEGIN
  SELECT RAISE(ABORT, 'grants: version must be the next integer for this grant id');
END;

CREATE TRIGGER grants_revoked_is_final
BEFORE INSERT ON grants
WHEN EXISTS (SELECT 1 FROM grants WHERE id = NEW.id AND revoked_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'grants: a revoked grant cannot be extended');
END;

-- categories is a closed set of grantable categories with no duplicates; the
-- JSON column alone would accept any string. Baseline is not a category here:
-- it is released only through allow_baseline.
CREATE TRIGGER grants_categories_valid
BEFORE INSERT ON grants
WHEN json_valid(NEW.categories) AND json_type(NEW.categories) = 'array'
 AND (
   EXISTS (
     SELECT 1 FROM json_each(NEW.categories)
     WHERE type <> 'text'
        OR value NOT IN ('cardiac', 'dental', 'musculoskeletal', 'dermatology', 'mental-health', 'substance-use')
   )
   OR (SELECT COUNT(*) FROM json_each(NEW.categories))
      <> (SELECT COUNT(DISTINCT value) FROM json_each(NEW.categories))
 )
BEGIN
  SELECT RAISE(ABORT, 'grants: categories must be unique known grantable categories');
END;

CREATE TRIGGER grants_no_update
BEFORE UPDATE ON grants
BEGIN
  SELECT RAISE(ABORT, 'grants: rows are immutable; insert a new version');
END;

CREATE TRIGGER grants_no_delete
BEFORE DELETE ON grants
BEGIN
  SELECT RAISE(ABORT, 'grants: rows cannot be deleted');
END;

-- The effective version of every grant. Policy must read this view (or take
-- MAX(version) itself), never an arbitrary version.
CREATE VIEW current_grants AS
SELECT g.*
FROM grants AS g
WHERE g.version = (SELECT MAX(version) FROM grants WHERE id = g.id);
