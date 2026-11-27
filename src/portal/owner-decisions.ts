/**
 * the owner portal's decisions: the step-up freshness check and the confirm
 * page's POST handling; the routes in `owner-routes.ts` call these; every
 * grant is still created only by the sharing module's confirm functions
 */
import { GRANTABLE_CATEGORIES, SENSITIVITIES } from '../contracts';
import { readClinician } from '../policy';
import { approveScopeRequest, confirmConnection } from '../sharing';

import { choice, field, fields } from './forms';
import { messagePage, sendPage } from './layout';
import { refusalPage } from './outcomes';
import { ENCOUNTER_DAYS, STEP_UP_MINUTES, VALIDITY_HOURS } from './owner-pages';

import type { FastifyReply, FastifyRequest } from 'fastify';

import type { GrantableCategory, PersonRef, Sensitivity } from '../contracts';
import type { PortalSession } from '../identity';
import type { SharingDenial } from '../sharing';

import type { PortalContext } from './context';
import type { RequesterView } from './owner-confirm-pages';

const MS_PER_MINUTE = 60_000;
/** how far ahead of the server clock an issuer auth_time may be */
const MAX_CLOCK_SKEW_MS = 30_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
/** how long a step-up return remembers the confirm page */
const STEP_UP_RETURN_SECONDS = 600;
const HTTP_SEE_OTHER = 303;
const HTTP_UNAUTHORIZED = 401;
/** the shape of a connection or scope request id */
export const ID_SHAPE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * checks whether the owner authenticated at the issuer recently enough to create a
 * grant: the verified ID token's `auth_time` (from a `prompt=login`,
 * `max_age=0` sign-in) within the step-up window, and not ahead of the
 * server clock by more than the allowed skew; no `auth_time`, no grant
 * @param context the portal context
 * @param session the owner session
 * @returns true within the step-up window
 */
export function isFresh(
  context: PortalContext,
  session: PortalSession,
): boolean {
  const age = session.authTime
    ? context.now().getTime() - session.authTime.getTime()
    : Number.POSITIVE_INFINITY;

  // an auth_time in the future is accepted only within the allowed skew
  return age >= -MAX_CLOCK_SKEW_MS && age <= STEP_UP_MINUTES * MS_PER_MINUTE;
}

/**
 * builds the requester view for a confirm page
 * @param context the portal context
 * @param who the owner session, the person being granted and the CSRF token
 * @param who.session the owner session
 * @param who.requester the person being granted
 * @param who.csrf the session's CSRF token
 * @returns the view with the requester's registry entry
 */
export function requesterView(
  context: PortalContext,
  who: { session: PortalSession; requester: PersonRef; csrf: string },
): RequesterView {
  const { session, requester, csrf } = who;

  return {
    registry: readClinician(context.sharing.db, requester),
    authenticatedAt: session.authTime,
    now: context.now(),
    csrf,
  };
}

/**
 * returns the categories ticked on a form, keeping only grantable ones
 * @param request the form post request
 * @returns the grantable categories that were ticked
 */
function tickedCategories(request: FastifyRequest): GrantableCategory[] {
  return fields(request, 'categories').filter(
    (value): value is GrantableCategory =>
      (GRANTABLE_CATEGORIES as readonly string[]).includes(value),
  );
}

/**
 * returns the sensitivity chosen on a form
 * @param request the form post request
 * @returns the sensitivity, or undefined when invalid
 */
function chosenSensitivity(request: FastifyRequest): Sensitivity | undefined {
  const value = field(request, 'maxSensitivity');

  return SENSITIVITIES.find((sensitivity) => sensitivity === value);
}

/**
 * sends the outcome of a decision: back to the dashboard, or a refusal
 * @param reply the reply to answer on
 * @param outcome the decision's result
 * @returns the reply
 */
export function settle(
  reply: FastifyReply,
  outcome: { ok: true } | SharingDenial,
): FastifyReply {
  return outcome.ok
    ? reply.redirect('/owner', HTTP_SEE_OTHER)
    : sendPage(reply, refusalPage(outcome.code, '/owner'));
}

/**
 * confirms a pending connection from the posted form
 * @param context the portal context
 * @param request the form post request
 * @param target the verified owner and the pending connection
 * @param target.owner the verified owner
 * @param target.connectionId the id of the pending connection
 * @returns the decision's result
 */
export function postConnection(
  context: PortalContext,
  request: FastifyRequest,
  target: { owner: PersonRef; connectionId: string },
): { ok: true } | SharingDenial {
  const { owner, connectionId } = target;
  const now = context.now().getTime();
  const hours = choice(request, 'validityHours', VALIDITY_HOURS);
  const days = choice(request, 'newEncounterDays', ENCOUNTER_DAYS);
  const sensitivity = chosenSensitivity(request);
  const encounter = field(request, 'encounter');
  const reason = field(request, 'newEncounterReason').trim();

  if (hours === undefined || sensitivity === undefined) {
    return { ok: false, code: 'invalid-input' };
  }

  if (encounter === 'new' && days === undefined) {
    return { ok: false, code: 'invalid-input' };
  }

  return confirmConnection(context.sharing, {
    owner,
    connectionId,
    choice: {
      encounter: encounter.startsWith('existing:')
        ? { kind: 'existing', id: encounter.slice('existing:'.length) }
        : {
            kind: 'new',
            ...(reason ? { reason } : {}),
            endsAt: new Date(now + (days ?? 0) * MS_PER_DAY).toISOString(),
          },
      categories: tickedCategories(request),
      allowBaseline: field(request, 'baseline') === 'on',
      maxSensitivity: sensitivity,
      expiresAt: new Date(now + hours * MS_PER_HOUR).toISOString(),
    },
  });
}

/**
 * approves a pending scope request from the posted form
 * @param context the portal context
 * @param request the form post request
 * @param target the verified owner and the pending scope request
 * @param target.owner the verified owner
 * @param target.scopeRequestId the id of the pending scope request
 * @param target.desiredExpiresAt the requester's desired expiry
 * @returns the decision's result
 */
export function postScope(
  context: PortalContext,
  request: FastifyRequest,
  target: {
    owner: PersonRef;
    scopeRequestId: string;
    desiredExpiresAt: string;
  },
): { ok: true } | SharingDenial {
  const { owner, scopeRequestId, desiredExpiresAt } = target;
  const sensitivity = chosenSensitivity(request);
  const requested = field(request, 'validityHours') === 'requested';
  const hours = choice(request, 'validityHours', VALIDITY_HOURS);

  if (sensitivity === undefined || (!requested && hours === undefined)) {
    return { ok: false, code: 'invalid-input' };
  }

  const chosen = requested
    ? Date.parse(desiredExpiresAt)
    : context.now().getTime() + (hours ?? 0) * MS_PER_HOUR;

  return approveScopeRequest(context.sharing, {
    owner,
    scopeRequestId,
    approval: {
      categories: tickedCategories(request),
      maxSensitivity: sensitivity,
      expiresAt: new Date(
        Math.min(chosen, Date.parse(desiredExpiresAt)),
      ).toISOString(),
    },
  });
}

/**
 * remembers the confirm page and asks the owner to sign in again
 * @param context the portal context
 * @param reply the reply to redirect on
 * @param id the pending item
 * @returns the reply
 */
export function requireStepUp(
  context: PortalContext,
  reply: FastifyReply,
  id: string,
): FastifyReply {
  void reply.setCookie(context.stepUpCookie, id, {
    path: '/',
    httpOnly: true,
    secure: context.secureCookies,
    sameSite: 'lax',
    maxAge: STEP_UP_RETURN_SECONDS,
  });

  return sendPage(
    reply,
    messagePage({
      status: HTTP_UNAUTHORIZED,
      title: 'Sign in again to share',
      message: `Creating a grant needs a sign-in from the last ${STEP_UP_MINUTES} minutes. Nothing was shared. Sign in again and you will return to this request.`,
      next: { href: '/auth/owner/sign-in', label: 'Sign in again' },
    }),
  );
}
