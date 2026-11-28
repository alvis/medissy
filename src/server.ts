import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import Fastify from 'fastify';

import { sourceReaderFromEnv } from './a2a/downloads';
import { createA2aSetup } from './a2a/plugin';
import { createDemoIdentity } from './demo-idp/compose';
import { parseKeyEncryptionKey } from './demo-idp/keys';
import { passphrasesFromEnv } from './demo-idp/secrets';
import { DEMO_USERS } from './demo-idp/users';
import { createSelectorClient, parseConflictLinks } from './disclosure';
import { secureStoreFromEnv } from './inbound/env';
import { boxSyncFromEnv, createPortalSetup } from './portal';
import { openVault } from './vault/migrate';

import type { DatabaseSync } from 'node:sqlite';

import type { FastifyInstance } from 'fastify';

import type { ConflictLink } from './disclosure';

const DEFAULT_PORT = 8080;
const DEFAULT_HOST = '127.0.0.1';
const HTTP_NOT_FOUND = 404;
const HTTP_MISDIRECTED = 421;
/** proxy hops trusted for `X-Forwarded-*`: only the Sprite's TLS proxy */
const TRUSTED_PROXY_HOPS = 1;
/** answered for any Host, so platform health checks keep working */
const HEALTH_PATH = '/healthz';
/** the curated synthetic manifest, whose `conflicts` list is used by default */
const DEFAULT_CONFLICTS_PATH = fileURLToPath(
  new URL('../fixtures/synthetic/manifest.json', import.meta.url),
);

/** shared resources every feature setup receives */
export interface AppContext {
  /** the vault, opened once by the caller through `openVault` */
  db?: DatabaseSync;
}

/** plugin or route registration on the root instance (not encapsulated) */
export type AppSetup = (
  app: FastifyInstance,
  context: AppContext,
) => PromiseLike<unknown>;

/** options for `createApp` */
export interface AppOptions {
  /** request logging (method and path only; query strings are never logged) */
  logger?: boolean;
  /** `X-Forwarded-*` trust from exactly one proxy hop (the Sprite's TLS proxy) */
  trustProxy?: boolean;
  /**
   * hosts (`host[:port]`) the app answers; any other Host, including a
   * forwarded one, gets 421; unset means any host (tests of the bare app)
   */
  allowedHosts?: readonly string[];
  /** the vault, passed to every setup and closed with the app */
  db?: DatabaseSync;
  /** feature setups (identity, A2A, portal, Box sync), run in order */
  setup?: readonly AppSetup[];
}

/**
 * refuses requests addressed to a host Medissy does not serve, so no response
 * (redirects, form actions, issuer URLs) is built for a foreign host
 * @param app the root instance
 * @param allowed the allowed hosts
 */
function guardHost(app: FastifyInstance, allowed: readonly string[]): void {
  const hosts = new Set(allowed.map((host) => host.toLowerCase()));

  app.addHook('onRequest', async (request, reply) => {
    if (request.url === HEALTH_PATH || hosts.has(request.host.toLowerCase())) {
      return;
    }

    return reply.code(HTTP_MISDIRECTED).send({ error: 'misdirected_request' });
  });
}

/**
 * creates the Medissy Fastify app: a generic health route, a JSON 404, and
 * whatever features the caller registers through `setup`; it carries no
 * patient data itself
 * @param options logging, proxy trust, hosts, vault and feature setups
 * @returns the app, ready to `listen` or `inject`
 */
export async function createApp(
  options: AppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    // trust only the immediate peer (hop 0), never addresses it forwards
    trustProxy: options.trustProxy
      ? (_address: string, hop: number) => hop < TRUSTED_PROXY_HOPS
      : false,
    logger: options.logger
      ? {
          serializers: {
            // drop the query: it can carry authorization codes or user codes
            req: (request) => ({
              method: request.method,
              path: request.url.split('?')[0],
            }),
          },
        }
      : false,
  });

  if (options.allowedHosts) {
    guardHost(app, options.allowedHosts);
  }

  app.get(HEALTH_PATH, async () => ({ status: 'ok', synthetic: true }));
  app.setNotFoundHandler(async (_request, reply) =>
    reply.code(HTTP_NOT_FOUND).send({ error: 'not_found' }),
  );

  const { db } = options;

  if (db) {
    app.addHook('onClose', async () => {
      db.close();
    });
  }

  for (const setup of options.setup ?? []) {
    await setup(app, { db });
  }

  await app.ready();

  return app;
}

/**
 * refuses a deployment whose client buckets would collapse: behind the
 * Sprite's TLS proxy (an https `MEDISSY_PUBLIC_URL`), without
 * `TRUST_PROXY=1` every caller has the proxy's IP, so the per-IP rate
 * limits, sign-in caps and lockouts would all share one bucket
 * @param env the process environment
 * @throws {Error} when MEDISSY_PUBLIC_URL is https and TRUST_PROXY is not 1
 */
export function assertProxyTrust(env: NodeJS.ProcessEnv): void {
  const publicUrl = env.MEDISSY_PUBLIC_URL;

  if (
    publicUrl &&
    URL.parse(publicUrl)?.protocol === 'https:' &&
    env.TRUST_PROXY !== '1'
  ) {
    throw new Error(
      'TRUST_PROXY=1 is required when MEDISSY_PUBLIC_URL is https (behind the Sprite TLS proxy); without it every caller shares one rate-limit and lockout bucket',
    );
  }
}

/**
 * loads the curated conflict links that pairing and the evidence card use to
 * keep conflicting records together and flagged; a missing or malformed file
 * fails boot rather than silently dropping every conflict
 * @param env the process environment (`CONFLICTS_PATH`, defaulting to the curated synthetic manifest)
 * @returns the validated links
 * @throws {Error} when the file cannot be read or parsed
 */
export function conflictLinksFromEnv(env: NodeJS.ProcessEnv): ConflictLink[] {
  const configured = env.CONFLICTS_PATH?.trim();
  const path = configured?.length ? configured : DEFAULT_CONFLICTS_PATH;

  return parseConflictLinks(JSON.parse(readFileSync(path, 'utf8')));
}

/**
 * composes the app from the environment; identity (and the demo IdP) is
 * enabled when both `DATABASE_PATH` and `MEDISSY_PUBLIC_URL` are set; the
 * vault is opened once and shared by every feature
 * @param env the process environment
 * @returns the app
 */
async function createFromEnv(env: NodeJS.ProcessEnv): Promise<FastifyInstance> {
  assertProxyTrust(env);

  const trustProxy = env.TRUST_PROXY === '1';
  const setup: AppSetup[] = [];
  const publicUrl = env.MEDISSY_PUBLIC_URL;
  let db: DatabaseSync | undefined;

  if (env.DATABASE_PATH && publicUrl) {
    const secure = new URL(publicUrl).protocol === 'https:';
    const kek = env.DEMO_IDP_KEY_ENCRYPTION_KEY;

    if (secure && !kek) {
      throw new Error(
        'DEMO_IDP_KEY_ENCRYPTION_KEY is required when MEDISSY_PUBLIC_URL is https',
      );
    }

    mkdirSync(dirname(env.DATABASE_PATH), { recursive: true });
    db = openVault(env.DATABASE_PATH);

    const identity = await createDemoIdentity({
      db,
      publicUrl,
      passphrases: passphrasesFromEnv(
        env,
        DEMO_USERS.map((user) => user.key),
      ),
      cookieKeys: env.DEMO_IDP_COOKIE_KEYS?.split(',').filter(Boolean),
      keyEncryptionKey: kek ? parseKeyEncryptionKey(kek) : undefined,
      secureCookies: secure,
    });

    const selectorClient = createSelectorClient(env);
    const conflictLinks = conflictLinksFromEnv(env);
    const sync = boxSyncFromEnv(env, db);

    setup.push(
      ...identity.setup,
      createA2aSetup({
        publicUrl,
        deviceFlow: identity.deviceFlow,
        ownerDeviceFlow: identity.ownerDeviceFlow,
        selectorClient,
        conflictLinks,
        reader: sourceReaderFromEnv(env),
        secureStore: secureStoreFromEnv(env),
      }),
      createPortalSetup({
        identity: identity.identity,
        publicOrigin: publicUrl,
        selectorClient,
        conflictLinks,
        secureCookies: secure,
        ...(sync ? { sync } : {}),
      }),
    );
  }

  return createApp({
    logger: true,
    trustProxy,
    allowedHosts: publicUrl ? [new URL(publicUrl).host] : undefined,
    db,
    setup,
  });
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const host = process.env.HOST ?? DEFAULT_HOST;
  const app = await createFromEnv(process.env);

  await app.listen({ port, host });
}
