/**
 * Fastify wiring for one synthetic issuer (`/demo-idp` or `/institution-idp`):
 * the oidc-provider mount and Medissy's own interaction pages (synthetic
 * account picker with a per-persona demo passphrase); each issuer is
 * registered separately, with its own lockout and only its own accounts;
 * the provider runs through `callback()` with the request hijacked and the
 * URL rewritten (SPK06), in a child context whose body parsers leave the
 * stream unread for the provider
 */
import { clientKey } from '../identity/rate-limit';
import {
  csrfTokenFor,
  ensureWebSecurity,
  verifyCsrf,
} from '../identity/web-security';

import { lockoutKey } from './lockout';
import { errorPage, loginPage, PAGE_CSP } from './pages';
import { CLIENT_NAMES } from './provider';
import { findDemoUserByKey } from './users';

import type { IncomingMessage } from 'node:http';

import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from 'fastify';
import type { Interaction } from 'oidc-provider';

import type { Lockout } from './lockout';
import type { DemoProvider } from './provider';
import type { PassphraseBook } from './secrets';
import type { DemoUser } from './users';

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SEE_OTHER = 303;

/** options for the demo IdP plugin */
export interface DemoIdpPluginOptions {
  idp: DemoProvider;
  /** per-persona demo passphrases */
  passphrases: PassphraseBook;
  /** per-(persona, client) lockout after repeated wrong passphrases */
  lockout: Lockout;
  /** mark cookies Secure; only tests turn this off */
  secureCookies?: boolean;
}

/**
 * reads a request parameter or interaction value that must be a string
 * @param value the raw value
 * @returns the string, or '' for anything else
 */
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * reads the interaction uid from the route
 * @param request the interaction route request
 * @returns the interaction uid, or '' when absent
 */
function uidOf(request: FastifyRequest): string {
  return text((request.params as Record<string, unknown>).uid);
}

/**
 * reads a form field from the parsed urlencoded body
 * @param request the form post request
 * @param name which field to read
 * @returns the value, or ''
 */
function field(request: FastifyRequest, name: string): string {
  return text((request.body as Record<string, unknown> | undefined)?.[name]);
}

/**
 * sends a labelled HTML page with the demo security headers
 * @param reply the reply to send on
 * @param html the complete page markup
 * @param status the HTTP status
 * @returns the reply
 */
function sendPage(
  reply: FastifyReply,
  html: string,
  status = HTTP_OK,
): FastifyReply {
  return reply
    .code(status)
    .header('content-security-policy', PAGE_CSP)
    .header('cache-control', 'no-store')
    .type('text/html; charset=utf-8')
    .send(html);
}

/**
 * builds an onRequest hook that replaces every forwarding header with values
 * Medissy vouches for: the configured public origin and Fastify's own client
 * address (which honours only the one trusted proxy hop); the provider runs
 * with `proxy` on, so it then builds URLs and Secure cookies for the public
 * origin and never for a client-supplied host
 * @param issuer the issuer URL (public origin plus mount)
 * @returns the onRequest hook
 */
function pinForwardedHeaders(
  issuer: string,
): (request: FastifyRequest) => Promise<void> {
  const { protocol, host } = new URL(issuer);

  return async (request) => {
    const headers = request.raw.headers;

    for (const name of Object.keys(headers)) {
      if (name.startsWith('x-forwarded-') || name === 'forwarded') {
        delete headers[name];
      }
    }

    headers['x-forwarded-proto'] = protocol.slice(0, -1);
    headers['x-forwarded-host'] = host;
    headers['x-forwarded-for'] = request.ip;
  };
}

/**
 * builds the grant for a chosen account; only the scopes this account may
 * hold; the rest are rejected explicitly so the provider does not ask again
 * and the token simply lacks the scope
 * @param idp the provider
 * @param interaction the login interaction
 * @param user the chosen account
 * @returns the grant id
 */
async function grantFor(
  idp: DemoProvider,
  interaction: Interaction,
  user: DemoUser,
): Promise<string> {
  const requested = text(interaction.params.scope).split(' ').filter(Boolean);
  const grant = new idp.provider.Grant({
    accountId: user.subject,
    clientId: text(interaction.params.client_id),
  });

  if (requested.includes('openid')) {
    grant.addOIDCScope('openid');
  }

  const resourceScopes = idp.profile.resourceScopes;

  for (const scope of requested.filter((s) => resourceScopes.includes(s))) {
    if (user.allowedScopes.includes(scope)) {
      grant.addResourceScope(idp.audience, scope);
    } else {
      grant.rejectResourceScope(idp.audience, scope);
    }
  }

  return grant.save();
}

/**
 * loads the interaction named in the URL; it must match the signed interaction
 * cookie the provider set
 * @param idp the issuer holding the interaction
 * @param request the interaction route request
 * @param reply the reply used for an error page
 * @returns the interaction, or undefined after an error page was sent
 */
async function loadInteraction(
  idp: DemoProvider,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<Interaction | undefined> {
  const interaction = await idp.provider
    .interactionDetails(request.raw, reply.raw)
    .catch(() => undefined);

  if (interaction?.uid === uidOf(request)) {
    return interaction;
  }

  sendPage(
    reply,
    errorPage({
      label: idp.profile.label,
      title: 'Sign-in expired',
      detail:
        'This sign-in request is no longer valid. Start again from your agent or the portal.',
    }),
    HTTP_BAD_REQUEST,
  );

  return undefined;
}

/**
 * shows the account picker, with a fresh CSRF token bound to the interaction
 * @param reply the reply to send the picker on
 * @param login the issuer whose accounts are offered and its login interaction
 * @param login.idp the issuer whose accounts are offered
 * @param login.interaction the provider interaction awaiting a sign-in
 * @param refusal an error to show after a refused attempt, and its status
 * @param refusal.message what to tell the person
 * @param refusal.status the HTTP status
 * @returns the reply
 */
function sendPicker(
  reply: FastifyReply,
  login: { idp: DemoProvider; interaction: Interaction },
  refusal?: { message: string; status: number },
): FastifyReply {
  const { idp, interaction } = login;
  const action = `${idp.profile.mount}/interaction/${encodeURIComponent(interaction.uid)}`;

  return sendPage(
    reply,
    loginPage({
      label: idp.profile.label,
      action,
      abortAction: `${action}/abort`,
      csrfToken: csrfTokenFor(reply, interaction.uid),
      clientName:
        CLIENT_NAMES[text(interaction.params.client_id)] ?? 'An application',
      users: idp.profile.users,
      message: refusal?.message,
    }),
    refusal?.status ?? HTTP_OK,
  );
}

/**
 * builds the handler for the picker POST, which checks the persona's
 * passphrase, then finishes the login with a grant limited to what the persona
 * may hold
 * @param options the provider and passphrases
 * @returns the route handler
 */
function loginHandler(
  options: DemoIdpPluginOptions,
): (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply> {
  const { idp } = options;

  return async (request, reply) => {
    const interaction = await loadInteraction(idp, request, reply);

    if (!interaction) {
      return reply;
    }

    // only this issuer's accounts: a persona of the other issuer is unknown
    const user = findDemoUserByKey(idp.profile, field(request, 'account'));
    // per persona and client: a guesser locks only itself out
    const locked = user ? lockoutKey(user.key, clientKey(request.ip)) : '';
    // checked before scrypt runs: a locked client refuses even the right one
    const lockedFor = user ? options.lockout.lockedFor(locked) : 0;

    if (lockedFor > 0) {
      reply.header('retry-after', String(lockedFor));

      return sendPicker(
        reply,
        { idp, interaction },
        {
          message:
            'This account is locked after too many wrong passphrases. Try again later.',
          status: HTTP_TOO_MANY_REQUESTS,
        },
      );
    }

    // always run the check, so an unknown account costs the same time
    const valid = await options.passphrases.check(
      user?.key ?? '',
      field(request, 'passphrase'),
    );

    if (!user || !valid) {
      if (user) {
        options.lockout.fail(locked);
      }

      return sendPicker(
        reply,
        { idp, interaction },
        {
          message: 'That account and passphrase do not match.',
          status: HTTP_UNAUTHORIZED,
        },
      );
    }

    options.lockout.reset(locked);

    const grantId = await grantFor(idp, interaction, user);
    const returnTo = await idp.provider.interactionResult(
      request.raw,
      reply.raw,
      { login: { accountId: user.subject }, consent: { grantId } },
      { mergeWithLastSubmission: false },
    );

    return reply.redirect(returnTo, HTTP_SEE_OTHER);
  };
}

/**
 * registers the interaction pages: GET shows the picker, POST signs in, and
 * `/abort` denies the request
 * @param app the encapsulated plugin instance
 * @param options the provider and passphrases
 */
function registerInteractions(
  app: FastifyInstance,
  options: DemoIdpPluginOptions,
): void {
  const { idp } = options;
  const route = `${idp.profile.mount}/interaction/:uid`;
  const csrf: preHandlerHookHandler = (request, reply, done) => {
    verifyCsrf(request, reply, { binding: uidOf(request), done });
  };

  app.get(route, async (request, reply) => {
    const interaction = await loadInteraction(idp, request, reply);

    return interaction ? sendPicker(reply, { idp, interaction }) : reply;
  });

  app.post(route, { preHandler: csrf }, loginHandler(options));

  app.post(`${route}/abort`, { preHandler: csrf }, async (request, reply) => {
    const interaction = await loadInteraction(idp, request, reply);

    if (!interaction) {
      return reply;
    }

    const returnTo = await idp.provider.interactionResult(
      request.raw,
      reply.raw,
      {
        error: 'access_denied',
        error_description: 'End-User aborted interaction',
      },
      { mergeWithLastSubmission: false },
    );

    return reply.redirect(returnTo, HTTP_SEE_OTHER);
  });
}

/**
 * mounts the provider's own endpoints under the issuer's path
 * @param mount a child context with no body parsing
 * @param idp the demo identity provider to mount
 */
function mountProvider(mount: FastifyInstance, idp: DemoProvider): void {
  // the provider reads its own bodies, so leave the stream untouched
  mount.removeAllContentTypeParsers();
  mount.addContentTypeParser('*', (_request, _payload, done) => {
    done(null, undefined);
  });

  const { mount: path } = idp.profile;
  const callback = idp.provider.callback();
  const handler = (request: FastifyRequest, reply: FastifyReply): void => {
    const raw = request.raw as IncomingMessage & { originalUrl?: string };
    const original = raw.url ?? path;
    const rest = original.slice(path.length);

    reply.hijack();
    raw.originalUrl = original;
    raw.url = rest.startsWith('/') ? rest : `/${rest}`;
    callback(raw, reply.raw);
  };

  mount.all(path, handler);
  mount.all(`${path}/*`, handler);
}

/**
 * registers one issuer under its mount, with its interaction pages
 * @param app the Fastify instance (an encapsulated child)
 * @param options the configured provider and passphrases
 */
export const demoIdpPlugin: FastifyPluginAsync<DemoIdpPluginOptions> = async (
  app,
  options,
) => {
  await ensureWebSecurity(app, { secureCookies: options.secureCookies });

  app.addHook('onRequest', pinForwardedHeaders(options.idp.issuer));
  registerInteractions(app, options);
  await app.register(async (mount) => {
    mountProvider(mount, options.idp);
  });
};
