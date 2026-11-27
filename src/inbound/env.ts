/**
 * which secure store records handed back are filed into (ADR-10), chosen by
 * `MEDISSY_INBOUND_STORE` so the skill is never advertised by accident:
 *
 * - unset or empty: no store; the `submit-record` skill is unavailable;
 * - `box`: the allowed Box folder through the Sprites connector; set it only
 *   after the connector policy allows `/upload/files/content`
 *   (scripts/deploy.md); the BOX_* settings must be present;
 * - `fixture`: an in-memory, tests-and-local-only store, refused under
 *   `NODE_ENV=production`; files vanish when the process stops
 */
import { connectorConfigFromEnv, createConnectorStore } from '../box/connector';
import { createFixtureStore } from '../box/fixture';

import type { FetchLike } from '../box/connector';
import type { SecureStore } from '../box/types';

/** folder id the local fixture store pretends to file into */
export const LOCAL_FIXTURE_FOLDER = '9000000001';

/**
 * builds the secure store from the environment
 * @param env the environment (MEDISSY_INBOUND_STORE and, for `box`, BOX_*)
 * @param fetchImpl the fetch the connector uses
 * @returns the store, or undefined (skill unavailable)
 * @throws {Error} on an unknown mode, missing Box settings, or `fixture` in
 *   production
 */
export function secureStoreFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl: FetchLike = fetch,
): SecureStore | undefined {
  const mode = env.MEDISSY_INBOUND_STORE ?? '';

  switch (mode) {
    case '':
      return undefined;
    case 'box':
      return createConnectorStore({
        ...connectorConfigFromEnv(env),
        fetch: fetchImpl,
      });
    case 'fixture':
      return createFixtureStore(LOCAL_FIXTURE_FOLDER);
    default:
      throw new Error('MEDISSY_INBOUND_STORE must be box, fixture or unset');
  }
}
