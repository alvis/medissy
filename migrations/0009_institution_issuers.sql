-- 0009_institution_issuers: trusted institutions vouch for their doctors (ADR-9).
--
-- A trusted issuer is now one of two kinds:
--  * `patient`: signs in the vault owner only and vouches for nothing else.
--    Every issuer trusted before this migration was the patient's demo IdP,
--    so existing rows become `patient`.
--  * `institution`: a hospital whose ID token names the person's roles in
--    `role_claim`. Medissy accepts only the roles in `allowed_roles`, and the
--    organisation is this row's `organization_id` / `organization_name`,
--    never a token claim.
--
-- This supersedes the 0001 comment on `clinicians` ("Organization and roles
-- come from here, never from token claims alone"; 0001 cannot be edited, its
-- checksum is recorded). `clinicians` is now a just-in-time record written at
-- every verified institution sign-in: roles from the institution's ID token,
-- organisation from the issuer row, `status` (the patient's `suspended` kill
-- switch) left untouched.
--
-- Exactly one institution may be enabled at a time (partial unique index).

ALTER TABLE trusted_issuers ADD COLUMN kind TEXT NOT NULL DEFAULT 'patient'
  CHECK (kind IN ('patient', 'institution'));
ALTER TABLE trusted_issuers ADD COLUMN organization_id TEXT
  CHECK (organization_id IS NULL OR length(organization_id) BETWEEN 1 AND 128);
ALTER TABLE trusted_issuers ADD COLUMN organization_name TEXT
  CHECK (organization_name IS NULL OR length(organization_name) BETWEEN 1 AND 120);
ALTER TABLE trusted_issuers ADD COLUMN role_claim TEXT
  CHECK (role_claim IS NULL OR length(role_claim) BETWEEN 1 AND 64);
ALTER TABLE trusted_issuers ADD COLUMN allowed_roles TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(allowed_roles) AND json_type(allowed_roles) = 'array');

-- An institution must say which organisation it is, which claim carries roles
-- and which roles count; a patient issuer configures none of these.
CREATE TRIGGER trusted_issuers_kind_settings_insert
BEFORE INSERT ON trusted_issuers
WHEN (NEW.kind = 'institution' AND (NEW.organization_id IS NULL OR NEW.organization_name IS NULL
        OR NEW.role_claim IS NULL OR json_array_length(NEW.allowed_roles) = 0))
  OR (NEW.kind = 'patient' AND (NEW.organization_id IS NOT NULL OR NEW.organization_name IS NOT NULL
        OR NEW.role_claim IS NOT NULL OR json_array_length(NEW.allowed_roles) > 0))
BEGIN
  SELECT RAISE(ABORT, 'trusted_issuers: kind settings are incomplete or misplaced');
END;

CREATE TRIGGER trusted_issuers_kind_settings_update
BEFORE UPDATE ON trusted_issuers
WHEN (NEW.kind = 'institution' AND (NEW.organization_id IS NULL OR NEW.organization_name IS NULL
        OR NEW.role_claim IS NULL OR json_array_length(NEW.allowed_roles) = 0))
  OR (NEW.kind = 'patient' AND (NEW.organization_id IS NOT NULL OR NEW.organization_name IS NOT NULL
        OR NEW.role_claim IS NOT NULL OR json_array_length(NEW.allowed_roles) > 0))
BEGIN
  SELECT RAISE(ABORT, 'trusted_issuers: kind settings are incomplete or misplaced');
END;

CREATE UNIQUE INDEX trusted_issuers_one_enabled_institution
  ON trusted_issuers (kind) WHERE kind = 'institution' AND enabled = 1;

-- Registry rows written before this migration came from the patient's demo
-- IdP, which no longer vouches for clinicians: they keep their status but
-- lose their roles, so they release nothing until an institution sign-in.
UPDATE clinicians SET roles = '[]';
