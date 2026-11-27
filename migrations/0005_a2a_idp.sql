-- 0005_a2a_idp: durable A2A task store and the oidc-provider adapter store.

-- Durable A2A task store (the SDK's InMemoryTaskStore is not restart-safe).
--
-- Decision D10: there is no per-client credential; a calling agent addresses a
-- task by its id alone, so the id is a bearer capability. It is minted by the
-- server from >= 128 random bits (src/contracts/task.ts newTaskId) and the
-- shape check below refuses short or odd ids. A poll carries no caller
-- identity, so the id is the only check on reads (accepted under D10; A08 is
-- recorded partial/FAIL). Releases are decided for the bound (caller_issuer,
-- caller_subject), the grant is re-checked on every poll, and artifacts are
-- served only before expires_at. A creating message whose id collides with an
-- unbound task must get an error, never the existing task.
--
-- Binding: an unbound task is waiting for sign-in (TASK_STATE_AUTH_REQUIRED)
-- or ended without one (TASK_STATE_REJECTED or TASK_STATE_FAILED). Only an
-- AUTH_REQUIRED task may be bound. The binding goes NULL -> value once and is
-- then locked, so it can never be rebound to someone else or reverted to
-- unbound.
--
-- status_json carries the A2A TaskStatus; its state always equals the state
-- column, so write both in the same statement. A terminal task (COMPLETED,
-- FAILED, CANCELED, REJECTED) is frozen: A2A terminal states are immutable,
-- so neither the state nor the status changes again. Its expiry may still be
-- shortened (an access-ended task stays COMPLETED and serves nothing).
--
-- Write the store as INSERT (create) then UPDATE (change). An upsert or INSERT
-- OR REPLACE is refused by the collision guard because it could swap the
-- bound caller of an existing task.
--
-- receipt_id points at the disclosure receipt the task's artifacts were built
-- from; it is set once, after the receipt exists.
CREATE TABLE a2a_tasks (
  id                 TEXT NOT NULL PRIMARY KEY
                     CHECK (length(id) BETWEEN 22 AND 86 AND id NOT GLOB '*[^A-Za-z0-9_-]*'),
  context_id         TEXT NOT NULL,
  caller_issuer      TEXT,
  caller_subject     TEXT,
  patient_id         TEXT NOT NULL REFERENCES patient (id),
  encounter_id       TEXT REFERENCES encounters (id),
  receipt_id         TEXT REFERENCES receipts (id),
  -- messageId of the SendMessage that created the task; the idempotency key
  origin_message_id  TEXT NOT NULL CHECK (length(origin_message_id) BETWEEN 1 AND 256),
  state              TEXT NOT NULL CHECK (state IN (
                       'TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING', 'TASK_STATE_COMPLETED',
                       'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_INPUT_REQUIRED',
                       'TASK_STATE_REJECTED', 'TASK_STATE_AUTH_REQUIRED')),
  status_json        TEXT NOT NULL CHECK (json_valid(status_json) AND json_type(status_json) = 'object'),
  artifacts          TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(artifacts) AND json_type(artifacts) = 'array'),
  history            TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(history) AND json_type(history) = 'array'),
  metadata           TEXT CHECK (metadata IS NULL OR (json_valid(metadata) AND json_type(metadata) = 'object')),
  created_at         TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at         TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  -- artifacts are served only before this instant
  expires_at         TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at),
  CHECK (created_at < expires_at),
  CHECK ((caller_issuer IS NULL) = (caller_subject IS NULL)),
  CHECK (caller_subject IS NOT NULL OR state IN (
           'TASK_STATE_AUTH_REQUIRED', 'TASK_STATE_REJECTED', 'TASK_STATE_FAILED')),
  CHECK (json_extract(status_json, '$.state') IS state),
  -- bound tasks: one task per (caller, message)
  UNIQUE (caller_issuer, caller_subject, origin_message_id)
) STRICT;

-- UNIQUE treats NULLs as distinct, so unbound tasks need their own index: a
-- replayed message must not create a second unbound task.
CREATE UNIQUE INDEX a2a_tasks_one_unbound_per_message
  ON a2a_tasks (origin_message_id) WHERE caller_subject IS NULL;

CREATE INDEX a2a_tasks_by_caller_context ON a2a_tasks (caller_issuer, caller_subject, context_id);
CREATE INDEX a2a_tasks_by_state ON a2a_tasks (state, updated_at);
CREATE INDEX a2a_tasks_by_expiry ON a2a_tasks (expires_at);

-- Collision guard (see the module note on INSERT OR REPLACE): refuse an insert
-- that collides on the id, the bound (caller, message) key, or the unbound
-- message key. IS compares NULL callers as equal.
CREATE TRIGGER a2a_tasks_no_replace
BEFORE INSERT ON a2a_tasks
WHEN EXISTS (
  SELECT 1 FROM a2a_tasks
  WHERE id = NEW.id
     OR (caller_issuer IS NEW.caller_issuer
         AND caller_subject IS NEW.caller_subject
         AND origin_message_id = NEW.origin_message_id)
)
BEGIN
  SELECT RAISE(ABORT, 'a2a_tasks: a task with this id or origin message already exists');
END;

-- NULL -> value once, then never again: the caller cannot be rebound to
-- someone else, and a bound task can never revert to an unbound
-- AUTH_REQUIRED task.
CREATE TRIGGER a2a_tasks_binding_is_locked
BEFORE UPDATE ON a2a_tasks
WHEN OLD.caller_subject IS NOT NULL
 AND (NEW.caller_issuer IS NOT OLD.caller_issuer OR NEW.caller_subject IS NOT OLD.caller_subject)
BEGIN
  SELECT RAISE(ABORT, 'a2a_tasks: the caller binding is locked once set');
END;

-- Only a task waiting for sign-in can be bound: an unbound task that ended
-- (sign-in declined or lapsed) stays unbound for good.
CREATE TRIGGER a2a_tasks_bind_from_auth_required
BEFORE UPDATE ON a2a_tasks
WHEN OLD.caller_subject IS NULL
 AND NEW.caller_subject IS NOT NULL
 AND OLD.state IS NOT 'TASK_STATE_AUTH_REQUIRED'
BEGIN
  SELECT RAISE(ABORT, 'a2a_tasks: only an AUTH_REQUIRED task can be bound');
END;

-- A2A terminal states are immutable: once COMPLETED, FAILED, CANCELED or
-- REJECTED, the state and status never change (the expiry may still shrink).
CREATE TRIGGER a2a_tasks_terminal_is_frozen
BEFORE UPDATE ON a2a_tasks
WHEN OLD.state IN ('TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED')
 AND (NEW.state IS NOT OLD.state OR NEW.status_json IS NOT OLD.status_json)
BEGIN
  SELECT RAISE(ABORT, 'a2a_tasks: a terminal task is frozen');
END;

-- Identity and authorization context never change; encounter_id and receipt_id
-- may be filled once; the expiry may be shortened but never extended.
CREATE TRIGGER a2a_tasks_identity_is_fixed
BEFORE UPDATE ON a2a_tasks
WHEN NEW.id IS NOT OLD.id
  OR NEW.patient_id IS NOT OLD.patient_id
  OR NEW.context_id IS NOT OLD.context_id
  OR NEW.origin_message_id IS NOT OLD.origin_message_id
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.encounter_id IS NOT NULL AND NEW.encounter_id IS NOT OLD.encounter_id)
  OR (OLD.receipt_id IS NOT NULL AND NEW.receipt_id IS NOT OLD.receipt_id)
BEGIN
  SELECT RAISE(ABORT, 'a2a_tasks: id, patient, context, origin message, encounter and receipt are fixed once set');
END;

CREATE TRIGGER a2a_tasks_expiry_never_extends
BEFORE UPDATE ON a2a_tasks
WHEN NEW.expires_at > OLD.expires_at
BEGIN
  SELECT RAISE(ABORT, 'a2a_tasks: expires_at cannot be extended');
END;

-- Only abandoned sign-ins are purged: a task bound to a clinician is an audit
-- anchor (its receipt link) and is never deleted.
CREATE TRIGGER a2a_tasks_bound_never_deleted
BEFORE DELETE ON a2a_tasks
WHEN OLD.caller_subject IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a2a_tasks: a bound task cannot be deleted');
END;

-- oidc-provider adapter store: one table for every model (Session, AccessToken,
-- AuthorizationCode, Grant, DeviceCode, Interaction, ...). The extra columns
-- back the adapter lookups (findByUid, findByUserCode, revokeByGrantId,
-- consume). expires_at is NULL for models without a lifetime.
CREATE TABLE idp_store (
  model        TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 64),
  id           TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 512),
  payload      TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  grant_id     TEXT,
  user_code    TEXT,
  uid          TEXT,
  consumed_at  TEXT CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', consumed_at) IS consumed_at),
  expires_at   TEXT CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at),
  PRIMARY KEY (model, id)
) STRICT, WITHOUT ROWID;

CREATE INDEX idp_store_by_grant ON idp_store (grant_id) WHERE grant_id IS NOT NULL;
CREATE INDEX idp_store_by_uid ON idp_store (uid) WHERE uid IS NOT NULL;
CREATE INDEX idp_store_by_user_code ON idp_store (user_code) WHERE user_code IS NOT NULL;
CREATE INDEX idp_store_by_expiry ON idp_store (expires_at) WHERE expires_at IS NOT NULL;
