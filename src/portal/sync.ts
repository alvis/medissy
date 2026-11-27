/**
 * the owner's "sync now" button, wired to the existing Box ingestion
 * (`runSync`) when the Sprites Box connector and the curated catalogue are
 * configured; without them the portal shows NOT CONFIGURED
 */
import {
  createConnectorAdapter,
  connectorConfigFromEnv,
} from '../box/connector';
import { loadCuration } from '../box/curation';
import { runSync } from '../box/sync';
import { readPatientId } from '../policy/repository';

import type { DatabaseSync } from 'node:sqlite';

import type { SourceAdapter } from '../box/types';

import type { PortalSync } from './context';

/** the `.env.example` placeholder for an unset value */
const PLACEHOLDER = 'replace-me';

/** what the owner sync runs over */
export interface BoxSyncOptions {
  db: DatabaseSync;
  adapter: SourceAdapter;
  /** the curated catalogue of record envelopes (`BOX_CURATION_PATH`) */
  curationPath: string;
  now?: () => Date;
}

/**
 * binds `runSync` to the vault, the adapter and the curated catalogue
 * @param options the vault, adapter and catalogue path
 * @returns the portal's sync port
 */
export function createBoxSync(options: BoxSyncOptions): PortalSync {
  return async (owner) => {
    const patientId = readPatientId(options.db);

    if (!patientId) {
      throw new Error('the vault has no patient yet');
    }

    const summary = await runSync(
      {
        db: options.db,
        adapter: options.adapter,
        curation: loadCuration(options.curationPath, patientId),
        patientId,
        ...(options.now ? { now: options.now } : {}),
      },
      {
        trigger: 'owner',
        actor: { kind: 'owner', issuer: owner.issuer, subject: owner.subject },
      },
    );

    return { status: summary.status, imported: summary.imported };
  };
}

/**
 * builds the owner sync from the environment, when Box is configured
 * @param env the environment (BOX_GATEWAY_CONNECTION_ID, BOX_ALLOWED_FOLDER_ID, BOX_CURATION_PATH)
 * @param db the vault
 * @param fetchImpl the fetch the connector uses
 * @returns the sync port, or undefined (NOT CONFIGURED)
 * @throws {Error} when a Box setting is present but malformed
 */
export function boxSyncFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  db: DatabaseSync,
  fetchImpl: typeof fetch = fetch,
): PortalSync | undefined {
  const present = (value: string | undefined): value is string =>
    Boolean(value) && value !== PLACEHOLDER;
  const curationPath = env.BOX_CURATION_PATH;

  if (
    !present(env.BOX_GATEWAY_CONNECTION_ID) ||
    !present(env.BOX_ALLOWED_FOLDER_ID) ||
    !present(curationPath)
  ) {
    return undefined;
  }

  return createBoxSync({
    db,
    curationPath,
    adapter: createConnectorAdapter({
      ...connectorConfigFromEnv(env),
      fetch: fetchImpl,
    }),
  });
}
