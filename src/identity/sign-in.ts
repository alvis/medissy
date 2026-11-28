/**
 * the browser sign-in handlers: authorization code + PKCE, run by Medissy's
 * server; the issuer is chosen by the session kind, never by the caller: the
 * owner signs in at the patient's issuer, a clinician at the trusted
 * institution (ADR-9); the code is exchanged server-side, the tokens are
 * verified and dropped, and only the derived principal is kept in a session;
 * `createIdentity` wires these into routes
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import { SCOPE_OWNER, SCOPE_REQUEST } from '../contracts';

import { SESSION_KINDS } from './sessions';

import type { FastifyReply, FastifyRequest } from 'fastify';

import type { IdentityDirectory } from './directory';
import type { Fetch, IssuerConnection } from './issuer';
import type { PortalSession, SessionKind, SessionStore } from './sessions';
import type {
  AccessTokenVerifier,
  IssuedTokens,
  VerifyResult,
} from './verifier';

const RANDOM_BYTES = 32;
const MS_PER_SECOND = 1000;
const SIGN_IN_TTL_SECONDS = 600;
const MAX_PENDING_SIGN_INS = 1000;
const HTTP_SEE_OTHER = 303;
const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_BAD_GATEWAY = 502;

/** scope each session kind requires on its access token */
export const SESSION_SCOPE: Readonly<Record<SessionKind, string>> = {
  owner: SCOPE_OWNER,
  clinician: SCOPE_REQUEST,
};

/** a sign-in the browser started and has not finished */
export interface PendingSignIn {
  kind: SessionKind;
  codeVerifier: string;
  nonce: string;
  expiresAt: number;
}

/** everything the sign-in handlers share, built once by `createIdentity` */
export interface SignInContext {
  options: {
    directory: IdentityDirectory;
    verifier: AccessTokenVerifier;
    /** the issuer each session kind signs in at */
    connections: Readonly<Record<SessionKind, IssuerConnection>>;
    audience: string;
  };
  now: () => Date;
  fetch: Fetch;
  redirectUri: string;
  ttl: Record<SessionKind, number>;
  landing: Record<SessionKind, string>;
  sessions: SessionStore;
  pendingSignIns: Map<string, PendingSignIn>;
  signInCookie: string;
  sessionCookie: Record<SessionKind, string>;
  cookieOptions: {
    path: string;
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'lax';
  };
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  id_token: z.string().min(1).optional(),
});

/**
 * owner sign-ins always re-authenticate at the issuer (D3 step-up): an
 * existing issuer session never signs the owner in silently, and the ID
 * token's `auth_time` records this login
 */
const OWNER_REAUTHENTICATE = { prompt: 'login', max_age: '0' } as const;

/**
 * compares two strings in constant time
 * @param a first value
 * @param b second value
 * @returns true when equal
 */
function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * checks whether a session still satisfies its kind's requirements
 * @param ctx the shared sign-in state
 * @param session the stored portal session to check
 * @returns true when admitted
 */
export function admits(ctx: SignInContext, session: PortalSession): boolean {
  if (!session.principal.scopes.includes(SESSION_SCOPE[session.kind])) {
    return false;
  }

  if (session.kind === 'clinician') {
    return true;
  }

  const owner = ctx.options.directory.findPatientOwner();

  return (
    owner !== null &&
    owner.issuer === session.principal.issuer &&
    owner.subject === session.principal.subject
  );
}

/**
 * verifies the owner's tokens: the access token, then the ID token for the
 * step-up `auth_time`, which only counts when it names the same person
 * @param ctx the shared sign-in state
 * @param tokens the token response
 * @param pending the stored sign-in attempt
 * @returns the verification result and sign-in time
 */
async function verifyOwner(
  ctx: SignInContext,
  tokens: IssuedTokens,
  pending: PendingSignIn,
): Promise<{ result: VerifyResult; authTime?: Date }> {
  const { verifier, connections } = ctx.options;
  const result = await verifier.verify(tokens.accessToken, SCOPE_OWNER);
  const identified =
    result.ok && tokens.idToken && verifier.verifyIdToken
      ? await verifier.verifyIdToken(tokens.idToken, {
          clientId: connections.owner.portalClientId,
          nonce: pending.nonce,
        })
      : undefined;
  const authTime =
    result.ok &&
    identified?.ok &&
    identified.issuer === result.principal.issuer &&
    identified.subject === result.principal.subject
      ? identified.authTime
      : undefined;

  return { result, ...(authTime ? { authTime } : {}) };
}

/**
 * verifies a clinician's institution sign-in (access and ID token, ADR-9)
 * @param ctx the shared sign-in state
 * @param tokens the token response
 * @param pending the stored sign-in attempt
 * @returns the verification result and sign-in time
 */
async function verifyClinicianSignIn(
  ctx: SignInContext,
  tokens: IssuedTokens,
  pending: PendingSignIn,
): Promise<{ result: VerifyResult; authTime?: Date }> {
  const result = await ctx.options.verifier.verifyClinician(tokens, {
    scope: SCOPE_REQUEST,
    clientId: ctx.options.connections.clinician.portalClientId,
    nonce: pending.nonce,
  });
  const authTime = result.ok ? result.authTime : undefined;

  return { result, ...(authTime ? { authTime } : {}) };
}

/**
 * exchanges an authorization code for a verified principal
 * @param ctx the shared sign-in state
 * @param code the authorization code
 * @param pending the stored sign-in attempt
 * @returns the verification result, or undefined when the issuer failed
 */
async function exchange(
  ctx: SignInContext,
  code: string,
  pending: PendingSignIn,
): Promise<{ result: VerifyResult; authTime?: Date } | undefined> {
  const { options } = ctx;
  const connection = options.connections[pending.kind];
  const response = await ctx
    .fetch(connection.tokenEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'accept': 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: ctx.redirectUri,
        client_id: connection.portalClientId,
        code_verifier: pending.codeVerifier,
        resource: options.audience,
      }).toString(),
    })
    .catch(() => undefined);
  const parsed = tokenResponseSchema.safeParse(
    await response?.json().catch(() => undefined),
  );

  if (!response?.ok || !parsed.success) {
    return undefined;
  }

  // verified, then dropped: the tokens are never stored, logged or returned
  const { access_token: accessToken, id_token: idToken } = parsed.data;
  const tokens = { accessToken, ...(idToken ? { idToken } : {}) };

  return pending.kind === 'owner'
    ? verifyOwner(ctx, tokens, pending)
    : verifyClinicianSignIn(ctx, tokens, pending);
}

/**
 * drops expired sign-ins, then remembers a new one
 * @param ctx the shared sign-in state
 * @param kind which session the sign-in is for
 * @returns the secrets of the new attempt, or undefined when too many are pending
 */
function rememberSignIn(
  ctx: SignInContext,
  kind: SessionKind,
): { state: string; codeVerifier: string; nonce: string } | undefined {
  const at = ctx.now().getTime();

  for (const [state, entry] of ctx.pendingSignIns) {
    if (entry.expiresAt <= at) {
      ctx.pendingSignIns.delete(state);
    }
  }

  if (ctx.pendingSignIns.size >= MAX_PENDING_SIGN_INS) {
    return undefined;
  }

  const state = randomBytes(RANDOM_BYTES).toString('base64url');
  const codeVerifier = randomBytes(RANDOM_BYTES).toString('base64url');
  const nonce = randomBytes(RANDOM_BYTES).toString('base64url');

  ctx.pendingSignIns.set(state, {
    kind,
    codeVerifier,
    nonce,
    expiresAt: at + SIGN_IN_TTL_SECONDS * MS_PER_SECOND,
  });

  return { state, codeVerifier, nonce };
}

/**
 * builds the issuer URL that starts the sign-in
 * @param ctx the shared sign-in state
 * @param kind which session the sign-in is for
 * @param attempt the secrets of the attempt
 * @param attempt.state the state the browser must return
 * @param attempt.codeVerifier the PKCE verifier, hashed into the challenge
 * @param attempt.nonce the nonce the ID token must carry
 * @returns the issuer endpoint with the PKCE challenge, state and nonce in its query
 */
function authorizationUrl(
  ctx: SignInContext,
  kind: SessionKind,
  attempt: { state: string; codeVerifier: string; nonce: string },
): string {
  const { options } = ctx;
  const connection = options.connections[kind];
  const url = new URL(connection.authorizationEndpoint);

  url.search = new URLSearchParams({
    client_id: connection.portalClientId,
    response_type: 'code',
    scope: `openid ${SESSION_SCOPE[kind]}`,
    redirect_uri: ctx.redirectUri,
    state: attempt.state,
    nonce: attempt.nonce,
    code_challenge: createHash('sha256')
      .update(attempt.codeVerifier)
      .digest('base64url'),
    code_challenge_method: 'S256',
    resource: options.audience,
    ...(kind === 'owner' ? OWNER_REAUTHENTICATE : {}),
  }).toString();

  return url.toString();
}

/**
 * starts a browser sign-in: remembers it and redirects to the issuer
 * @param ctx the shared sign-in state
 * @param request the sign-in request, whose `kind` param picks the session
 * @param reply the reply to redirect on
 * @returns the reply
 */
export function beginSignIn(
  ctx: SignInContext,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  const { kind: requested } = request.params as Record<string, unknown>;
  const kind = SESSION_KINDS.find((k) => k === requested);

  if (!kind) {
    return reply.code(HTTP_BAD_REQUEST).send({ error: 'unknown_kind' });
  }

  const attempt = rememberSignIn(ctx, kind);

  if (!attempt) {
    return reply.code(HTTP_BAD_GATEWAY).send({ error: 'busy' });
  }

  return reply
    .setCookie(ctx.signInCookie, attempt.state, {
      ...ctx.cookieOptions,
      maxAge: SIGN_IN_TTL_SECONDS,
    })
    .header('cache-control', 'no-store')
    .redirect(authorizationUrl(ctx, kind, attempt), HTTP_SEE_OTHER);
}

/**
 * opens the session for a verified sign-in and sends the browser on
 * @param ctx the shared sign-in state
 * @param exchange the request and reply of the callback
 * @param exchange.request the callback request
 * @param exchange.reply the reply to redirect on
 * @param signedIn the verified sign-in
 * @param signedIn.pending the attempt the browser started
 * @param signedIn.result the verified principal
 * @param signedIn.authTime when the person authenticated at the issuer
 * @returns the reply
 */
function openSession(
  ctx: SignInContext,
  exchange: { request: FastifyRequest; reply: FastifyReply },
  signedIn: {
    pending: PendingSignIn;
    result: Extract<VerifyResult, { ok: true }>;
    authTime?: Date;
  },
): FastifyReply {
  const { request, reply } = exchange;
  const { pending, result, authTime } = signedIn;
  const { sessions } = ctx;
  const session = sessions.create({
    kind: pending.kind,
    principal: result.principal,
    clinician: result.clinician,
    ttlSeconds: ctx.ttl[pending.kind],
    notAfter: result.expiresAt,
    ...(authTime ? { authTime } : {}),
  });

  if (!admits(ctx, session)) {
    sessions.destroy(session.id);

    return reply.code(HTTP_FORBIDDEN).send({ error: 'not_owner' });
  }

  // always a fresh id (no fixation); drop the browser's previous one
  const previous = request.cookies[ctx.sessionCookie[pending.kind]];

  if (previous) {
    sessions.destroy(previous);
  }

  return reply
    .setCookie(ctx.sessionCookie[pending.kind], session.id, {
      ...ctx.cookieOptions,
      maxAge: Math.max(
        0,
        Math.floor(
          (session.expiresAt.getTime() - ctx.now().getTime()) / MS_PER_SECOND,
        ),
      ),
    })
    .redirect(ctx.landing[pending.kind], HTTP_SEE_OTHER);
}

/**
 * finishes a browser sign-in at the callback: checks the state, exchanges the
 * code and opens the session
 * @param ctx the shared sign-in state
 * @param request the callback request
 * @param reply the reply to answer on
 * @returns the reply
 */
export async function completeSignIn(
  ctx: SignInContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const { code, state, error } = request.query as Partial<
    Record<'code' | 'state' | 'error', string>
  >;
  const bound = request.cookies[ctx.signInCookie];

  reply
    .clearCookie(ctx.signInCookie, ctx.cookieOptions)
    .header('cache-control', 'no-store');

  // the state must be the one this browser started (login CSRF guard)
  if (!state || !bound || !sameText(state, bound)) {
    return reply.code(HTTP_BAD_REQUEST).send({ error: 'invalid_state' });
  }

  const pending = ctx.pendingSignIns.get(state);

  ctx.pendingSignIns.delete(state);

  if (!pending || pending.expiresAt <= ctx.now().getTime()) {
    return reply.code(HTTP_BAD_REQUEST).send({ error: 'invalid_state' });
  }

  if (error || !code) {
    return reply.code(HTTP_FORBIDDEN).send({ error: 'sign_in_cancelled' });
  }

  const exchanged = await exchange(ctx, code, pending);
  const result = exchanged?.result;

  if (!result) {
    return reply.code(HTTP_BAD_GATEWAY).send({ error: 'issuer_failed' });
  }

  if (!result.ok) {
    return reply
      .code(HTTP_FORBIDDEN)
      .send({ error: 'sign_in_rejected', reason: result.reason });
  }

  return openSession(
    ctx,
    { request, reply },
    { pending, result, authTime: exchanged.authTime },
  );
}
