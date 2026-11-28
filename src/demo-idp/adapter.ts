/**
 * oidc-provider adapter over the vault's `idp_store` table (migration 0005);
 * one table holds every model; the extra columns back the lookups the
 * provider needs; the database must come from `openVault`
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';

import type { Adapter, AdapterPayload } from 'oidc-provider';

const MS_PER_SECOND = 1000;

interface StoredRow {
  payload: string;
  expiresAt: string | null;
}

interface Statements {
  upsert: StatementSync;
  purge: StatementSync;
  byId: StatementSync;
  byUid: StatementSync;
  byUserCode: StatementSync;
  consume: StatementSync;
  destroy: StatementSync;
  revoke: StatementSync;
}

const SELECT = 'SELECT payload, expires_at AS expiresAt FROM idp_store';

/**
 * prepares the adapter's statements once per connection
 * @param db the vault
 * @returns the prepared statements
 */
function prepare(db: DatabaseSync): Statements {
  return {
    // an update keeps `consumed`: once a one-time artifact (authorization or
    // device code) is consumed, a later save of the same id cannot revive it
    upsert: db.prepare(
      `INSERT INTO idp_store (model, id, payload, grant_id, user_code, uid, consumed_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT (model, id) DO UPDATE SET
         payload = CASE
           WHEN idp_store.consumed_at IS NULL THEN excluded.payload
           ELSE json_set(excluded.payload, '$.consumed', json_extract(idp_store.payload, '$.consumed'))
         END,
         grant_id = excluded.grant_id,
         user_code = excluded.user_code,
         uid = excluded.uid,
         expires_at = excluded.expires_at`,
    ),
    purge: db.prepare(
      'DELETE FROM idp_store WHERE expires_at IS NOT NULL AND expires_at <= ?',
    ),
    byId: db.prepare(`${SELECT} WHERE model = ? AND id = ?`),
    byUid: db.prepare(`${SELECT} WHERE model = ? AND uid = ?`),
    byUserCode: db.prepare(`${SELECT} WHERE model = ? AND user_code = ?`),
    consume: db.prepare(
      `UPDATE idp_store SET consumed_at = ?, payload = json_set(payload, '$.consumed', ?)
       WHERE model = ? AND id = ?`,
    ),
    destroy: db.prepare('DELETE FROM idp_store WHERE model = ? AND id = ?'),
    revoke: db.prepare('DELETE FROM idp_store WHERE grant_id = ?'),
  };
}

/**
 * builds one model's adapter
 * @param model the provider model name
 * @param sql the prepared statements
 * @param now the clock used for expiry
 * @returns an adapter that stores that model's records in the vault
 */
function modelAdapter(
  model: string,
  sql: Statements,
  now: () => Date,
): Adapter {
  const live = (row: unknown): AdapterPayload | undefined => {
    const stored = row as StoredRow | undefined;

    if (!stored) {
      return undefined;
    }

    if (stored.expiresAt !== null && stored.expiresAt <= now().toISOString()) {
      return undefined;
    }

    return JSON.parse(stored.payload) as AdapterPayload;
  };

  return {
    /**
     * stores or replaces a record and purges expired ones
     * @param id the record id
     * @param payload the record body
     * @param expiresIn the lifetime in seconds, if it expires
     */
    async upsert(id, payload, expiresIn) {
      const at = now();
      const expiresAt =
        typeof expiresIn === 'number'
          ? new Date(at.getTime() + expiresIn * MS_PER_SECOND).toISOString()
          : null;

      sql.purge.run(at.toISOString());
      sql.upsert.run(
        model,
        id,
        JSON.stringify(payload),
        payload.grantId ?? null,
        payload.userCode ?? null,
        payload.uid ?? null,
        expiresAt,
      );
    },
    find: async (id) => live(sql.byId.get(model, id)),
    findByUid: async (uid) => live(sql.byUid.get(model, uid)),
    findByUserCode: async (userCode) =>
      live(sql.byUserCode.get(model, userCode)),
    /**
     * marks a record as consumed
     * @param id the record id
     */
    async consume(id) {
      const at = now();

      sql.consume.run(
        at.toISOString(),
        Math.floor(at.getTime() / MS_PER_SECOND),
        model,
        id,
      );
    },
    /**
     * deletes a record
     * @param id the record id
     */
    async destroy(id) {
      sql.destroy.run(model, id);
    },
    /**
     * deletes every record issued under a grant
     * @param grantId the grant whose records go
     */
    async revokeByGrantId(grantId) {
      sql.revoke.run(grantId);
    },
  };
}

/**
 * builds an adapter factory bound to one vault connection
 * @param db a vault opened through `openVault`
 * @param now the clock used for expiry
 * @returns the factory oidc-provider calls once per model
 */
export function createSqliteAdapter(
  db: DatabaseSync,
  now: () => Date = () => new Date(),
): (model: string) => Adapter {
  const sql = prepare(db);

  return (model) => modelAdapter(model, sql, now);
}
