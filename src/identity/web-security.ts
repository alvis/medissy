/**
 * shared browser-facing plumbing: cookie parsing, form bodies and CSRF tokens;
 * registered once at the root so the demo IdP's interaction pages and every
 * portal route share one CSRF configuration
 *
 * CSRF tokens are bound to a per-request `csrfBinding` (a session id or an
 * interaction uid) through `@fastify/csrf-protection`'s `userInfo`, so a token
 * minted for one session or interaction is rejected on another
 */
import { randomBytes } from 'node:crypto';

import fastifyCookie from '@fastify/cookie';
import fastifyCsrfProtection from '@fastify/csrf-protection';
import fastifyFormbody from '@fastify/formbody';

import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /** what the CSRF token of this request must be bound to */
    csrfBinding: string;
  }
}

const HMAC_KEY_BYTES = 32;
const FORM_BODY_LIMIT = 16_384;

/** options for the shared web-security plugin */
export interface WebSecurityOptions {
  /** mark cookies Secure and use `__Host-` names; only tests turn this off */
  secureCookies?: boolean;
  /** key binding CSRF tokens to their session; random per process by default */
  csrfHmacKey?: Buffer;
}

/**
 * builds the cookie name, with the `__Host-` prefix whenever cookies are Secure, so the
 * browser refuses a version set for a sub-domain or another path
 * @param name the base name
 * @param secure whether cookies are Secure
 * @returns the cookie name to use
 */
export function cookieName(name: string, secure: boolean): string {
  return secure ? `__Host-${name}` : name;
}

/**
 * registers cookie parsing, form bodies and CSRF protection on the instance it
 * is registered on (it does not create its own encapsulation context)
 * @param app the Fastify instance
 * @param options cookie security and the CSRF key
 */
const webSecurity: FastifyPluginAsync<WebSecurityOptions> = async (
  app,
  options,
) => {
  const secure = options.secureCookies ?? true;

  await app.register(fastifyCookie);
  await app.register(fastifyFormbody, { bodyLimit: FORM_BODY_LIMIT });
  app.decorateRequest('csrfBinding', '');
  await app.register(fastifyCsrfProtection, {
    sessionPlugin: '@fastify/cookie',
    cookieKey: cookieName('medissy-csrf', secure),
    cookieOpts: { path: '/', sameSite: 'strict', httpOnly: true, secure },
    getUserInfo: (request: FastifyRequest) => request.csrfBinding,
    csrfOpts: {
      hmacKey: options.csrfHmacKey ?? randomBytes(HMAC_KEY_BYTES),
      userInfo: true,
    },
  });
};

// share the decorators with the parent instead of an encapsulated child
Object.assign(webSecurity, {
  [Symbol.for('skip-override')]: true,
  [Symbol.for('fastify.display-name')]: 'medissy-web-security',
});

export const webSecurityPlugin = webSecurity;

/**
 * registers the web-security plugin unless an ancestor already did
 * @param app the instance that needs CSRF and cookies
 * @param options used only when it is not registered yet
 */
export async function ensureWebSecurity(
  app: FastifyInstance,
  options: WebSecurityOptions,
): Promise<void> {
  if (!app.hasReplyDecorator('generateCsrf')) {
    await app.register(webSecurityPlugin, options);
  }
}

/**
 * mints a CSRF token bound to a session id or interaction uid
 * @param reply the reply (sets the CSRF secret cookie when missing)
 * @param binding the session id or interaction uid
 * @returns the token to embed in the form
 */
export function csrfTokenFor(reply: FastifyReply, binding: string): string {
  return reply.generateCsrf({ userInfo: binding });
}

/**
 * verifies the request's CSRF token against `binding`; on failure the reply is
 * a 403 and `done` is never called
 * @param request the request carrying `_csrf` or a CSRF header
 * @param reply the reply to refuse on a bad token
 * @param check what to bind the token to, and how to continue
 * @param check.binding the session id or interaction uid the token must be bound to
 * @param check.done continue the request
 */
export function verifyCsrf(
  request: FastifyRequest,
  reply: FastifyReply,
  check: { binding: string; done: () => void },
): void {
  request.csrfBinding = check.binding;
  request.server.csrfProtection(request, reply, check.done);
}
