/**
 * the owner portal; grants are created only by the confirm page's POST (D3),
 * which requires the owner session, its CSRF token and a sign-in no older
 * than five minutes (step-up), all checked here on the server
 */
import { readLastSyncAt } from '../disclosure';
import { listSubmissions, removeSubmission } from '../inbound';
import { readGrants } from '../policy';
import {
  createInvitation,
  declineConnection,
  declineScopeRequest,
  encountersAdmitting,
  hasLapsed,
  listConnections,
  listScopeRequests,
  readConnection,
  readScopeRequest,
  readVaultOwner,
  revokeGrant,
} from '../sharing';
import { renderQrSvg } from '../widgets/qr';

import { personOf, sessionOf } from './context';
import { param } from './forms';
import { sendPage } from './layout';
import { refusalPage } from './outcomes';
import { confirmConnectionPage, confirmScopePage } from './owner-confirm-pages';
import {
  readLedger,
  readLatestSync,
  readReceipts,
  readUnsignedRequests,
  readSources,
} from './owner-data';
import {
  ID_SHAPE,
  isFresh,
  postConnection,
  postScope,
  requesterView,
  requireStepUp,
  settle,
} from './owner-decisions';
import { dashboardPage } from './owner-pages';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { SharingDenial } from '../sharing';

import type { PortalContext } from './context';
import type { DashboardView, ShareView } from './owner-pages';

const HTTP_SEE_OTHER = 303;
const HTTP_SERVICE_UNAVAILABLE = 503;
const HTTP_BAD_GATEWAY = 502;

/** extra content for a dashboard render */
interface DashboardExtras {
  share?: ShareView;
  syncMessage?: string;
  status?: number;
}

/**
 * builds the dashboard view from the vault
 * @param context the portal context
 * @param csrf the session's CSRF token
 * @returns what the dashboard lists and the forms it carries
 */
function dashboardView(context: PortalContext, csrf: string): DashboardView {
  const { db } = context.sharing;
  const now = context.now();
  const patientId = readVaultOwner(db)?.patientId ?? '';

  return {
    origin: new URL(context.sharing.publicOrigin).origin,
    csrf,
    now,
    syncConfigured: context.sync !== undefined,
    sources: readSources(db),
    latestSync: readLatestSync(db),
    lastSyncAt: readLastSyncAt(db, patientId),
    connections: listConnections(db, ['pending']).map((connection) => ({
      ...connection,
      lapsed: hasLapsed(connection, now),
    })),
    scopeRequests: listScopeRequests(db, { statuses: ['pending'] }).filter(
      (request) => Date.parse(request.desiredExpiresAt) > now.getTime(),
    ),
    grants: readGrants(db, patientId).grants,
    receipts: readReceipts(db),
    unsigned: readUnsignedRequests(db, now),
    inbound: listSubmissions(db, patientId),
    ledger: readLedger(db),
  };
}

/**
 * renders the dashboard
 * @param context the portal context
 * @param exchange the owner's request and the reply to send the page on
 * @param exchange.request the owner's request
 * @param exchange.reply the reply to send the page on
 * @param extras a fresh share code, a sync message or a status
 * @returns the reply
 */
function sendDashboard(
  context: PortalContext,
  exchange: { request: FastifyRequest; reply: FastifyReply },
  extras: DashboardExtras = {},
): FastifyReply {
  const { request, reply } = exchange;
  const csrf = context.identity.csrfToken(reply, sessionOf(request));
  const built = dashboardPage({
    ...dashboardView(context, csrf),
    ...(extras.share ? { share: extras.share } : {}),
    ...(extras.syncMessage ? { syncMessage: extras.syncMessage } : {}),
  });

  return sendPage(reply, { ...built, status: extras.status ?? built.status });
}

/**
 * checks whether an id names a pending connection or scope request
 * @param context the portal context
 * @param id the connection or scope request id
 * @returns true when the owner can still decide it
 */
function isPending(context: PortalContext, id: string): boolean {
  const { db } = context.sharing;

  return (
    readConnection(db, id)?.status === 'pending' ||
    readScopeRequest(db, id)?.status === 'pending'
  );
}

/**
 * runs a Box sync for the owner and shows the dashboard with its result
 * @param context the portal context
 * @param exchange the owner's request and the reply
 * @param exchange.request the owner's request
 * @param exchange.reply the reply to send the page on
 * @returns the reply
 */
async function syncDashboard(
  context: PortalContext,
  exchange: { request: FastifyRequest; reply: FastifyReply },
): Promise<FastifyReply> {
  const { request, reply } = exchange;

  if (!context.sync) {
    return sendDashboard(
      context,
      { request, reply },
      {
        status: HTTP_SERVICE_UNAVAILABLE,
        syncMessage:
          'Box sync is NOT CONFIGURED in this deployment. Nothing was imported.',
      },
    );
  }

  const run = await context
    .sync(personOf(sessionOf(request)))
    .catch(() => undefined);

  return sendDashboard(
    context,
    { request, reply },
    run
      ? {
          syncMessage: `Sync ${run.status}: ${run.imported} new record(s) imported.`,
        }
      : {
          status: HTTP_BAD_GATEWAY,
          syncMessage: 'Sync failed. Nothing was imported; try again later.',
        },
  );
}

/**
 * shows the confirm page for a pending connection or scope request
 * @param context the portal context
 * @param exchange the owner's request and the reply
 * @param exchange.request the owner's request
 * @param exchange.reply the reply to send the page on
 * @returns the reply
 */
function showConfirm(
  context: PortalContext,
  exchange: { request: FastifyRequest; reply: FastifyReply },
): FastifyReply {
  const { request, reply } = exchange;
  const { db } = context.sharing;

  const session = sessionOf(request);
  const csrf = context.identity.csrfToken(reply, session);
  const id = param(request, 'id');
  const connection = readConnection(db, id);
  const scope = connection ? undefined : readScopeRequest(db, id);
  const now = context.now();

  if (connection?.status === 'pending') {
    return sendPage(
      reply,
      confirmConnectionPage({
        connection: { ...connection, lapsed: hasLapsed(connection, now) },
        encounters: encountersAdmitting(db, connection.requester, now),
        view: requesterView(context, {
          session,
          requester: connection.requester,
          csrf,
        }),
      }),
    );
  }

  if (scope?.status === 'pending') {
    return sendPage(
      reply,
      confirmScopePage({
        request: scope,
        view: requesterView(context, {
          session,
          requester: scope.requester,
          csrf,
        }),
      }),
    );
  }

  return sendPage(
    reply,
    refusalPage(connection || scope ? 'not-pending' : 'not-found', '/owner'),
  );
}

/**
 * registers the landing after owner sign-in and the dashboard routes
 * @param app the encapsulated portal instance
 * @param context the portal context
 */
function registerDashboard(app: FastifyInstance, context: PortalContext): void {
  const guard = { preHandler: context.identity.requireOwner };

  app.get('/portal', guard, async (request, reply) => {
    const back = request.cookies[context.stepUpCookie] ?? '';

    void reply.clearCookie(context.stepUpCookie, { path: '/' });

    return ID_SHAPE.test(back) && isPending(context, back)
      ? reply.redirect(`/owner/confirm/${back}`, HTTP_SEE_OTHER)
      : reply.redirect('/owner', HTTP_SEE_OTHER);
  });

  app.get('/owner', guard, async (request, reply) =>
    sendDashboard(context, { request, reply }),
  );

  app.post('/owner/invitations', guard, async (request, reply) => {
    const created = createInvitation(context.sharing, {
      owner: personOf(sessionOf(request)),
    });

    if (!created.ok) {
      return sendPage(reply, refusalPage(created.code, '/owner'));
    }

    return sendDashboard(
      context,
      { request, reply },
      {
        share: {
          url: created.share.url,
          expiresAt: created.share.expiresAt,
          svg: renderQrSvg(created.share.url),
        },
      },
    );
  });

  app.post('/owner/grants/:id/revoke', guard, async (request, reply) =>
    settle(
      reply,
      revokeGrant(context.sharing, {
        owner: personOf(sessionOf(request)),
        grantId: param(request, 'id'),
      }),
    ),
  );

  app.post('/owner/sync', guard, async (request, reply) =>
    syncDashboard(context, { request, reply }),
  );

  app.post('/owner/inbound/:id/remove', guard, async (request, reply) =>
    settle(reply, removeInbound(context, request)),
  );
}

/**
 * removes a record the care team handed back (ADR-10): it becomes
 * entered-in-error and is never released again; removing twice is a no-op
 * @param context the portal context
 * @param request the owner's POST naming the receipt
 * @returns success, or not-found for an unknown or malformed receipt id
 */
function removeInbound(
  context: PortalContext,
  request: FastifyRequest,
): { ok: true } | SharingDenial {
  const { db } = context.sharing;
  const submissionId = param(request, 'id');
  const patientId = readVaultOwner(db)?.patientId;

  if (!ID_SHAPE.test(submissionId) || patientId === undefined) {
    return { ok: false, code: 'not-found' };
  }

  const outcome = removeSubmission(db, {
    submissionId,
    patientId,
    owner: personOf(sessionOf(request)),
    now: context.now(),
  });

  return outcome === 'not-found'
    ? { ok: false, code: 'not-found' }
    : { ok: true };
}

/**
 * registers the confirm page (GET shows, POST decides) and decline
 * @param app the encapsulated portal instance
 * @param context the portal context
 */
function registerConfirm(app: FastifyInstance, context: PortalContext): void {
  const guard = { preHandler: context.identity.requireOwner };
  const { db } = context.sharing;

  app.get('/owner/confirm/:id', guard, async (request, reply) =>
    showConfirm(context, { request, reply }),
  );

  app.post('/owner/confirm/:id', guard, async (request, reply) => {
    const session = sessionOf(request);
    const id = param(request, 'id');

    if (!isFresh(context, session)) {
      return ID_SHAPE.test(id)
        ? requireStepUp(context, reply, id)
        : sendPage(reply, refusalPage('not-found', '/owner'));
    }

    const owner = personOf(session);
    const scope = readConnection(db, id) ? undefined : readScopeRequest(db, id);

    return settle(
      reply,
      scope
        ? postScope(context, request, {
            owner,
            scopeRequestId: id,
            desiredExpiresAt: scope.desiredExpiresAt,
          })
        : postConnection(context, request, { owner, connectionId: id }),
    );
  });

  app.post('/owner/confirm/:id/decline', guard, async (request, reply) => {
    const owner = personOf(sessionOf(request));
    const id = param(request, 'id');

    return settle(
      reply,
      readScopeRequest(db, id)
        ? declineScopeRequest(context.sharing, { owner, scopeRequestId: id })
        : declineConnection(context.sharing, { owner, connectionId: id }),
    );
  });
}

/**
 * registers every owner route
 * @param app the encapsulated portal instance
 * @param context the portal context
 */
export function registerOwnerRoutes(
  app: FastifyInstance,
  context: PortalContext,
): void {
  registerDashboard(app, context);
  registerConfirm(app, context);
}
