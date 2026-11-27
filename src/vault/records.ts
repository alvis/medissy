/**
 * record reads for policy and the pre-model filter; policy sees labels only
 * (id, category, sensitivity, resource type, status), never a record body;
 * bodies are read solely for record ids a policy decision already allowed;
 * errors name the failure only; they never echo record contents
 *
 * only the `records` table is read for labels and bodies; an uncurated file is
 * a `record_sources` row with no record, and a changed file's incoming copy
 * lives only in `record_conflicts`, so neither can ever be labelled, selected
 * or released; a record under an open conflict is released only as its
 * original, and only while the incoming copy's labels are no stricter than
 * the original's (same category, sensitivity rank no higher); otherwise the
 * record is withheld until the conflict is resolved
 */
import { z } from 'zod';

import {
  idSchema,
  recordCategorySchema,
  recordEnvelopeSchema,
  resourceTypeSchema,
  SENSITIVITY_RANK,
  sensitivitySchema,
} from '../contracts';

import type { DatabaseSync } from 'node:sqlite';

import type { RecordEnvelope } from '../contracts';
import type { RecordLabel } from '../policy/decide';

/** an error raised when a stored record cannot be read as its contract requires */
export class VaultReadError extends Error {
  /**
   * @param message a fixed description that never contains record content
   * @param options standard error options carrying the underlying cause
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'VaultReadError';
  }
}

const RECORD_STATUSES = [
  'current',
  'superseded',
  'entered-in-error',
] as const satisfies ReadonlyArray<RecordEnvelope['status']>;

const recordLabelSchema = z.strictObject({
  id: idSchema,
  category: recordCategorySchema,
  resourceType: resourceTypeSchema,
  sensitivity: sensitivitySchema,
  status: z.enum(RECORD_STATUSES),
});

/** how an open conflict affects the release of its stored record */
export type ConflictEffect = 'flag' | 'withhold';

/**
 * lists the policy labels of every releasable record of a patient, without bodies;
 * a record whose open conflict carries stricter incoming labels is left out,
 * so policy can never select it
 * @param db an open vault
 * @param patientId the vault patient
 * @returns the labels, ordered by record id
 */
export function readRecordLabels(
  db: DatabaseSync,
  patientId: string,
): RecordLabel[] {
  const conflicts = readOpenConflicts(db, patientId);

  return db
    .prepare(
      `SELECT id, category, resource_type, sensitivity, status
       FROM records WHERE patient_id = ? ORDER BY id`,
    )
    .all(patientId)
    .filter((row) => conflicts.get(String(row.id)) !== 'withhold')
    .map((row) => {
      const label = recordLabelSchema.safeParse({
        id: row.id,
        category: row.category,
        resourceType: row.resource_type,
        sensitivity: row.sensitivity,
        status: row.status,
      });

      if (!label.success) {
        throw new VaultReadError('stored record label failed validation', {
          cause: label.error,
        });
      }

      return label.data;
    });
}

/**
 * lists the records of a patient under an open conflict, each with its effect: a
 * conflict whose incoming copy changes the category, raises the sensitivity
 * or carries labels that are not valid withholds the record; any other open
 * conflict only flags it; only the incoming labels are read, never its body
 * @param db an open vault
 * @param patientId the vault patient
 * @returns the effect per record id; `withhold` wins over `flag`
 */
export function readOpenConflicts(
  db: DatabaseSync,
  patientId: string,
): ReadonlyMap<string, ConflictEffect> {
  const effects = new Map<string, ConflictEffect>();
  const rows = db
    .prepare(
      `SELECT c.record_id, r.category, r.sensitivity,
              json_extract(c.incoming_record, '$.category') AS incoming_category,
              json_extract(c.incoming_record, '$.sensitivity') AS incoming_sensitivity
       FROM record_conflicts AS c JOIN records AS r ON r.id = c.record_id
       WHERE c.status = 'open' AND r.patient_id = ?`,
    )
    .all(patientId);

  for (const row of rows) {
    const recordId = String(row.record_id);
    const effect = conflictEffect(row);

    if (effects.get(recordId) !== 'withhold') {
      effects.set(recordId, effect);
    }
  }

  return effects;
}

/**
 * reads full envelopes for exactly these record ids of the patient, and no
 * others; every id must exist and every envelope must validate
 * @param db an open vault
 * @param patientId the vault patient
 * @param recordIds the ids a policy decision allowed
 * @returns the envelopes, in the order of `recordIds`
 */
export function readRecords(
  db: DatabaseSync,
  patientId: string,
  recordIds: readonly string[],
): RecordEnvelope[] {
  const placeholders = recordIds.map(() => '?').join(', ');
  const rows = recordIds.length
    ? db
        .prepare(
          `SELECT r.id, r.patient_id, r.resource_type, r.resource, r.category, r.sensitivity, r.status,
                  r.authored_at, s.provider, s.box_file_id, s.version, s.sha256, s.imported_at, s.verification
           FROM records AS r JOIN record_sources AS s ON s.id = r.source_id
           WHERE r.patient_id = ? AND r.id IN (${placeholders})`,
        )
        .all(patientId, ...recordIds)
    : [];
  const byId = new Map(rows.map((row) => [row.id, row]));

  return recordIds.map((recordId) => {
    const row = byId.get(recordId);

    if (!row) {
      throw new VaultReadError('an allowed record is missing from the vault');
    }

    return toEnvelope(row);
  });
}

/**
 * classifies one open conflict by comparing incoming with stored labels;
 * anything that is not a valid, no-stricter label fails closed
 * @param row the joined conflict row
 * @returns `flag` when the incoming labels are no stricter, else `withhold`
 */
function conflictEffect(row: Record<string, unknown>): ConflictEffect {
  const stored = sensitivitySchema.safeParse(row.sensitivity);
  const incoming = sensitivitySchema.safeParse(row.incoming_sensitivity);
  const sameCategory =
    typeof row.incoming_category === 'string' &&
    row.incoming_category === row.category;

  return sameCategory &&
    stored.success &&
    incoming.success &&
    SENSITIVITY_RANK[incoming.data] <= SENSITIVITY_RANK[stored.data]
    ? 'flag'
    : 'withhold';
}

/**
 * maps and validates one joined record row
 * @param row the raw row
 * @returns the validated envelope
 */
function toEnvelope(row: Record<string, unknown>): RecordEnvelope {
  const envelope = recordEnvelopeSchema.safeParse({
    id: row.id,
    patientId: row.patient_id,
    resourceType: row.resource_type,
    resource: parseResource(row.resource),
    category: row.category,
    sensitivity: row.sensitivity,
    source: {
      provider: row.provider,
      boxFileId: row.box_file_id,
      version: row.version,
      sha256: row.sha256,
      authoredAt: row.authored_at ?? undefined,
      importedAt: row.imported_at,
      verification: row.verification,
    },
    status: row.status,
  });

  if (!envelope.success) {
    throw new VaultReadError('stored record failed validation', {
      cause: envelope.error,
    });
  }

  return envelope.data;
}

/**
 * parses the stored FHIR resource JSON
 * @param value the `resource` column
 * @returns the parsed resource
 */
function parseResource(value: unknown): unknown {
  try {
    return JSON.parse(String(value)) as unknown;
  } catch {
    // the SyntaxError quotes the record body, so it is deliberately not
    // chained: a restricted body must never reach an error message (A06)
    throw new VaultReadError('stored record body is not JSON');
  }
}
