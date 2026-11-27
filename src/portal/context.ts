/**
 * what every portal route is bound to, and the session helpers they share;
 * routes read the verified person from the IDN session only, never from a
 * form field
 */
import type { FastifyRequest } from 'fastify';

import type { PersonRef } from '../contracts';
import type { DisclosureDeps } from '../disclosure';
import type { Identity, PortalSession } from '../identity';
import type { SharingDeps } from '../sharing';

/** owner-triggered source sync runner */
export type PortalSync = (
  owner: PersonRef,
) => Promise<{ status: string; imported: number }>;

/** the portal's bound dependencies */
export interface PortalContext {
  identity: Identity;
  sharing: SharingDeps;
  disclosure: DisclosureDeps;
  now: () => Date;
  sync?: PortalSync;
  /** the step-up return cookie's name */
  stepUpCookie: string;
  secureCookies: boolean;
}

/**
 * returns the session the guard admitted
 * @param request a request that passed requireOwner or requireClinician
 * @returns the admitted session
 * @throws {Error} when a route forgot its guard
 */
export function sessionOf(request: FastifyRequest): PortalSession {
  const session = request.portalSession;

  if (!session) {
    throw new Error('portal route registered without a session guard');
  }

  return session;
}

/**
 * returns the verified person of a session
 * @param session the admitted session
 * @returns its issuer and subject
 */
export function personOf(session: PortalSession): PersonRef {
  return {
    issuer: session.principal.issuer,
    subject: session.principal.subject,
  };
}
