/**
 * browser sign-in and session guards for the portal
 *
 * sign-in is authorization code + PKCE against the configured issuer, run by
 * Medissy's server: the code is exchanged server-side, the access token is
 * verified and dropped, and only the derived principal is kept in a session;
 * `requireOwner` and `requireClinician` are the preHandlers portal routes
 * use; on any state-changing method they also verify a CSRF token bound to
 * the session
 */
import { SESSION_KINDS, SessionStore } from './sessions';
import { admits, beginSignIn, completeSignIn, SESSION_SCOPE } from './sign-in';
import {
  cookieName,
  csrfTokenFor,
  ensureWebSecurity,
  verifyCsrf,
} from './web-security';

import type {
  FastifyPluginAsync,
  FastifyReply,
  preHandlerHookHandler,
} from 'fastify';

import type { IdentityDirectory } from './directory';
import type { Fetch, IssuerConnection } from './issuer';
import type { PortalSession, SessionKind } from './sessions';
import type { PendingSignIn, SignInContext } from './sign-in';
import type { AccessTokenVerifier } from './verifier';

declare module 'fastify' {
  interface FastifyRequest {
    /** the session a `requireOwner`/`requireClinician` guard admitted */
    portalSession: PortalSession | null;
  }
}

const HTTP_SEE_OTHER = 303;
const HTTP_UNAUTHORIZED = 401;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** default absolute session lifetimes in seconds */
export const DEFAULT_SESSION_TTL: Readonly<Record<SessionKind, number>> = {
  owner: 900,
  clinician: 1800,
};

export { SESSION_SCOPE };

/** options for `createIdentity` */
export interface IdentityOptions {
  directory: IdentityDirectory;
  verifier: AccessTokenVerifier;
  /**
   * the issuer each session kind signs in at: the owner at the patient's
   * issuer, a clinician at the trusted institution (ADR-9)
   */
  connections: Readonly<Record<SessionKind, IssuerConnection>>;
  /** public origin of Medissy; the redirect URI hangs off it */
  publicUrl: string;
  /** resource indicator requested for Medissy's tokens */
  audience: string;
  fetch?: Fetch;
  now?: () => Date;
  /** mark cookies Secure and `__Host-`; only tests turn this off */
  secureCookies?: boolean;
  ttlSeconds?: Partial<Record<SessionKind, number>>;
  /** fixed post-sign-in destinations (no caller-chosen redirect) */
  landing?: Partial<Record<SessionKind, string>>;
}

/** the identity layer handed to portal and agent plugins */
export interface Identity {
  /** register at the root (before portal routes) */
  plugin: FastifyPluginAsync;
  sessions: SessionStore;
  requireOwner: preHandlerHookHandler;
  requireClinician: preHandlerHookHandler;
  /** returns a CSRF token for a form posted within this session */
  csrfToken(reply: FastifyReply, session: PortalSession): string;
}

/**
 * builds the sign-in state the handlers share from the options
 * @param options directory, verifier, issuer connections and cookie settings
 * @returns the shared sign-in state
 */
function signInContext(options: IdentityOptions): SignInContext {
  const now = options.now ?? (() => new Date());
  const secure = options.secureCookies ?? true;
  const origin = options.publicUrl.replace(/\/$/, '');

  return {
    options,
    now,
    fetch: options.fetch ?? globalThis.fetch,
    redirectUri: `${origin}/auth/callback`,
    ttl: { ...DEFAULT_SESSION_TTL, ...options.ttlSeconds },
    landing: {
      owner: '/portal',
      clinician: '/clinician',
      ...options.landing,
    },
    sessions: new SessionStore(now),
    pendingSignIns: new Map<string, PendingSignIn>(),
    signInCookie: cookieName('medissy-signin', secure),
    sessionCookie: {
      owner: cookieName('medissy-owner', secure),
      clinician: cookieName('medissy-clinician', secure),
    },
    cookieOptions: {
      path: '/',
      httpOnly: true,
      secure,
      sameSite: 'lax',
    },
  };
}

/**
 * builds the preHandler that admits only a live session of one kind
 * @param ctx the shared sign-in state
 * @param kind which session kind the route needs
 * @returns a handler that answers 401 without a live session, and checks CSRF on unsafe methods
 */
function sessionGuard(
  ctx: SignInContext,
  kind: SessionKind,
): preHandlerHookHandler {
  return (request, reply, done) => {
    const id = request.cookies[ctx.sessionCookie[kind]];
    const session = id ? ctx.sessions.find(kind, id) : null;

    if (!session || !admits(ctx, session)) {
      void reply
        .code(HTTP_UNAUTHORIZED)
        .send({ error: 'sign_in_required', signIn: `/auth/${kind}/sign-in` });

      return;
    }

    request.portalSession = session;

    if (SAFE_METHODS.has(request.method)) {
      done();

      return;
    }

    verifyCsrf(request, reply, { binding: session.id, done });
  };
}

/**
 * builds the identity layer: sign-in routes, sessions and guards
 * @param options directory, verifier, issuer connections and cookie settings
 * @returns the plugin and the guards
 */
export function createIdentity(options: IdentityOptions): Identity {
  const ctx = signInContext(options);
  const secure = options.secureCookies ?? true;

  const plugin: FastifyPluginAsync = async (app) => {
    await ensureWebSecurity(app, { secureCookies: secure });
    app.decorateRequest('portalSession', null);

    app.get('/auth/:kind/sign-in', async (request, reply) =>
      beginSignIn(ctx, request, reply),
    );
    app.get('/auth/callback', async (request, reply) =>
      completeSignIn(ctx, request, reply),
    );

    for (const kind of SESSION_KINDS) {
      app.post(
        `/auth/${kind}/sign-out`,
        { preHandler: sessionGuard(ctx, kind) },
        async (request, reply) => {
          if (request.portalSession) {
            ctx.sessions.destroy(request.portalSession.id);
          }

          return reply
            .clearCookie(ctx.sessionCookie[kind], ctx.cookieOptions)
            .redirect('/', HTTP_SEE_OTHER);
        },
      );
    }
  };

  // share the decorators and routes with the root instance
  Object.assign(plugin, {
    [Symbol.for('skip-override')]: true,
    [Symbol.for('fastify.display-name')]: 'medissy-identity',
  });

  return {
    plugin,
    sessions: ctx.sessions,
    requireOwner: sessionGuard(ctx, 'owner'),
    requireClinician: sessionGuard(ctx, 'clinician'),
    csrfToken: (reply, session) => csrfTokenFor(reply, session.id),
  };
}
