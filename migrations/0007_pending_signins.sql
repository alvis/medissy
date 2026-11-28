-- 0007_pending_signins: durable in-task device sign-ins (contract:
-- src/contracts/signin.ts).
--
-- One row per device authorization Medissy started for an AUTH_REQUIRED task.
-- The A2A engine polls by task id alone (the task id is already the D10
-- capability), so nothing about the sign-in is kept in task metadata and a
-- restart loses nothing. There is no second bearer handle: the row id is a
-- random server-side key that is never handed out.
--
-- device_code is the RFC 8628 device code. It is server-only: it is read only
-- by src/identity/device-flow.ts and never appears in a task, a log, an audit
-- event or an API response. It is useless after expires_at.
--
-- Status moves once, from 'pending' to a terminal value. Write the store as
-- INSERT (start) then UPDATE (poll); an upsert or INSERT OR REPLACE is refused
-- by the collision guard. At most one sign-in per task is pending; starting a
-- new one marks the old one 'superseded' first.
CREATE TABLE pending_signins (
  id                TEXT NOT NULL PRIMARY KEY
                    CHECK (length(id) BETWEEN 22 AND 86 AND id NOT GLOB '*[^A-Za-z0-9_-]*'),
  task_id           TEXT NOT NULL REFERENCES a2a_tasks (id) ON DELETE CASCADE,
  device_code       TEXT NOT NULL CHECK (length(device_code) BETWEEN 1 AND 512),
  status            TEXT NOT NULL CHECK (status IN (
                      'pending', 'verified', 'denied', 'expired', 'failed', 'superseded')),
  interval_seconds  INTEGER NOT NULL CHECK (interval_seconds BETWEEN 1 AND 300),
  -- the next instant Medissy may call the token endpoint for this row
  next_poll_at      TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', next_poll_at) IS next_poll_at),
  expires_at        TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at),
  created_at        TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at        TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  CHECK (created_at < expires_at)
) STRICT;

CREATE UNIQUE INDEX pending_signins_one_pending_per_task
  ON pending_signins (task_id) WHERE status = 'pending';
CREATE UNIQUE INDEX pending_signins_device_code ON pending_signins (device_code);
CREATE INDEX pending_signins_by_expiry ON pending_signins (expires_at);

-- Collision guard: refuse an insert that collides on the id or the device
-- code, so INSERT OR REPLACE can never swap a row's task or device code.
CREATE TRIGGER pending_signins_no_replace
BEFORE INSERT ON pending_signins
WHEN EXISTS (
  SELECT 1 FROM pending_signins WHERE id = NEW.id OR device_code = NEW.device_code
)
BEGIN
  SELECT RAISE(ABORT, 'pending_signins: a sign-in with this id or device code already exists');
END;

-- A new row is always pending.
CREATE TRIGGER pending_signins_start_pending
BEFORE INSERT ON pending_signins
WHEN NEW.status IS NOT 'pending'
BEGIN
  SELECT RAISE(ABORT, 'pending_signins: a sign-in starts pending');
END;

-- The task, device code, creation time and expiry never change; the expiry
-- cannot be extended.
CREATE TRIGGER pending_signins_identity_is_fixed
BEFORE UPDATE ON pending_signins
WHEN NEW.id IS NOT OLD.id
  OR NEW.task_id IS NOT OLD.task_id
  OR NEW.device_code IS NOT OLD.device_code
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.expires_at IS NOT OLD.expires_at
BEGIN
  SELECT RAISE(ABORT, 'pending_signins: id, task, device code, created_at and expires_at are fixed');
END;

-- A terminal sign-in is final.
CREATE TRIGGER pending_signins_terminal_is_final
BEFORE UPDATE ON pending_signins
WHEN OLD.status IS NOT 'pending'
BEGIN
  SELECT RAISE(ABORT, 'pending_signins: a finished sign-in cannot change');
END;
