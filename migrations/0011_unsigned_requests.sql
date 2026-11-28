-- 0011_unsigned_requests: requests that stopped at sign-in, as day counts.
--
-- Every A2A skill starts as an unbound AUTH_REQUIRED task. A task nobody ever
-- signs in to is purged once it expires (src/a2a/task-store.ts); just before
-- that, it is counted here, so the patient's log covers callers that never
-- proved an identity too. Nothing about the caller is kept: no address, no
-- message, no task id, only the UTC day the task was created, its skill and
-- a count. One row per day and skill keeps the table small however many
-- strangers call, so the log cannot be flooded.

CREATE TABLE unsigned_requests (
  patient_id TEXT    NOT NULL REFERENCES patient (id),
  day        TEXT    NOT NULL CHECK (date(day) IS day),
  -- closed set; keep in step with taskMetadataSchema.skill (src/a2a/task-store.ts)
  skill      TEXT    NOT NULL CHECK (skill IN (
               'clinical-evidence-request', 'redeem-invitation', 'share-code', 'submit-record')),
  stopped    INTEGER NOT NULL CHECK (stopped > 0),
  PRIMARY KEY (patient_id, day, skill)
) STRICT;
