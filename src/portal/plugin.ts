/**
 * the portal setup: the owner portal, the step-up confirm page and the
 * clinician portal, in one encapsulated context registered after identity;
 * a guard's JSON 401 becomes a labelled HTML page with a sign-in link
 */
import { cookieName } from '../identity';

import { registerClinicianRoutes } from './clinician';
import { messagePage, pageHeaders } from './layout';
import { registerOwnerRoutes } from './owner-routes';

import type { DatabaseSync } from 'node:sqlite';

import type { FastifyInstance, FastifyReply } from 'fastify';

import type {
  ConflictLink,
  DisclosureLogger,
  SelectorClient,
} from '../disclosure';
import type { Identity } from '../identity';
import type { AppSetup } from '../server';
import type { SharingLogger } from '../sharing';

import type { PortalContext, PortalSync } from './context';

const HTTP_UNAUTHORIZED = 401;
const SIGN_IN_PATHS = new Set([
  '/auth/owner/sign-in',
  '/auth/clinician/sign-in',
]);

/** options for `createPortalSetup` */
export interface PortalOptions {
  identity: Identity;
  /** Medissy's configured public origin; invitation URLs hang off it */
  publicOrigin: string;
  /** the vault; defaults to the app context's */
  db?: DatabaseSync;
  now?: () => Date;
  newId?: () => string;
  /** sharing log lines (event and outcome only); Fastify's log by default */
  logger?: SharingLogger;
  /** disclosure log lines for re-checks; Fastify's log by default */
  disclosureLogger?: DisclosureLogger;
  selectorClient?: SelectorClient;
  conflictLinks?: readonly ConflictLink[];
  /** the owner-triggered source sync; NOT CONFIGURED when absent */
  sync?: PortalSync;
  /** secure, `__Host-` cookies; on for an https origin by default */
  secureCookies?: boolean;
}

/**
 * returns the sign-in path of a guard's JSON 401, if that is what is being sent
 * @param reply the reply being sent
 * @param payload the serialized payload
 * @returns the sign-in path, or undefined
 */
function signInPathOf(
  reply: FastifyReply,
  payload: unknown,
): string | undefined {
  const type = String(reply.getHeader('content-type') ?? '');

  if (
    reply.statusCode !== HTTP_UNAUTHORIZED ||
    typeof payload !== 'string' ||
    !type.startsWith('application/json')
  ) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(payload) as { error?: unknown; signIn?: unknown };

    return parsed.error === 'sign_in_required' &&
      typeof parsed.signIn === 'string' &&
      SIGN_IN_PATHS.has(parsed.signIn)
      ? parsed.signIn
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * turns the guards' JSON 401 into a page a person can act on
 * @param app the encapsulated portal instance
 */
function htmlSignInRequired(app: FastifyInstance): void {
  app.addHook('onSend', async (_request, reply, payload) => {
    const signIn = signInPathOf(reply, payload);

    if (!signIn) {
      return payload;
    }

    const built = messagePage({
      status: HTTP_UNAUTHORIZED,
      title: 'Sign in required',
      message:
        'This page needs a sign-in of the right kind. If you opened a share link, sign in as a clinician and open the link again.',
      next: { href: signIn, label: 'Sign in' },
    });

    pageHeaders(reply);

    return built.document;
  });
}

/**
 * builds the portal setup
 * @param options identity, origin, vault and the optional sync port
 * @returns a setup to register after the identity setup
 */
export function createPortalSetup(options: PortalOptions): AppSetup {
  return async (app, appContext) => {
    const db = options.db ?? appContext.db;

    if (!db) {
      throw new Error('the portal needs the vault');
    }

    const now = options.now ?? (() => new Date());
    const secure =
      options.secureCookies ??
      new URL(options.publicOrigin).protocol === 'https:';
    const appLog = {
      info: (entry: object) => app.log.info(entry),
      error: (entry: object) => app.log.error(entry),
    };
    const context: PortalContext = {
      identity: options.identity,
      now,
      secureCookies: secure,
      stepUpCookie: cookieName('medissy-stepup', secure),
      sharing: {
        db,
        clock: now,
        publicOrigin: options.publicOrigin,
        logger: options.logger ?? appLog,
        ...(options.newId ? { newId: options.newId } : {}),
      },
      disclosure: {
        db,
        clock: now,
        selectorClient: options.selectorClient,
        logger: options.disclosureLogger ?? appLog,
        ...(options.conflictLinks
          ? { conflictLinks: options.conflictLinks }
          : {}),
        ...(options.newId ? { newId: options.newId } : {}),
      },
      ...(options.sync ? { sync: options.sync } : {}),
    };

    await app.register(async (portal) => {
      htmlSignInRequired(portal);
      registerOwnerRoutes(portal, context);
      registerClinicianRoutes(portal, context);
    });
  };
}
