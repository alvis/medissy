/**
 * the clinician portal: a generic landing, the clinician's own connection,
 * evidence re-checked through `redisclose` on every view, their scope
 * requests, and invitation redemption; a clinician sees only what current
 * policy still releases to them; never the owner ledger or other requesters
 */
import { randomUUID } from 'node:crypto';

import { GRANTABLE_CATEGORIES } from '../contracts';
import { redisclose } from '../disclosure';
import {
  encountersAdmitting,
  hasConfirmedConnection,
  listScopeRequests,
  readVaultOwner,
  redeemInvitation,
  requestExpansion,
} from '../sharing';

import { personOf, sessionOf } from './context';
import { choice, field, fields } from './forms';
import { html, messagePage, page, postForm, sendPage } from './layout';
import { refusalPage } from './outcomes';

import type { FastifyInstance } from 'fastify';

import type { EvidenceItem, GrantableCategory, PersonRef } from '../contracts';
import type { PipelineOutcome } from '../disclosure';
import type { PortalSession } from '../identity';

import type { PortalContext } from './context';
import type { SafeHtml } from './layout';

const MS_PER_DAY = 86_400_000;
const ONE_WEEK_DAYS = 7;
const ONE_MONTH_DAYS = 30;
const RECENT_REQUESTS = 10;
/** desired-expiry choices for a scope request, in days */
export const SCOPE_DAYS = [1, ONE_WEEK_DAYS, ONE_MONTH_DAYS] as const;
const HTTP_SEE_OTHER = 303;
const STATED_MAX = 120;

const CLINICIAN_NAV = html`<nav><a href="/clinician">Clinician portal</a> · <a href="/connect">Redeem a share code</a></nav>`;

/**
 * the fixed script that copies the invitation token from the URL fragment into
 * the form, then removes it from the address bar and history; fixed text,
 * allowed by hash
 */
export const CONNECT_SCRIPT =
  "(function(){var t=location.hash.slice(1);var i=document.querySelector('input[name=token]');if(t&&i){i.value=t;history.replaceState(null,'',location.pathname);}})();";

/** one of the clinician's own requests, re-checked now */
interface CheckedRequest {
  requestId: string;
  issuedAt: string;
  outcome: PipelineOutcome;
}

/**
 * lists the clinician's own most recent requests, each re-checked by policy
 * @param context the portal context
 * @param caller the verified clinician
 * @returns newest first
 */
function checkedRequests(
  context: PortalContext,
  caller: PersonRef,
): CheckedRequest[] {
  const { db } = context.sharing;
  const patientId = readVaultOwner(db)?.patientId ?? '';

  return db
    .prepare(
      `SELECT request_id, issued_at FROM receipts
       WHERE requester_issuer = ? AND requester_subject = ? AND decision = 'released'
       ORDER BY issued_at DESC, id LIMIT ?`,
    )
    .all(caller.issuer, caller.subject, RECENT_REQUESTS)
    .map((row) => ({
      requestId: String(row.request_id),
      issuedAt: String(row.issued_at),
      outcome: redisclose(context.disclosure, {
        caller,
        patientId,
        requestId: String(row.request_id),
      }),
    }));
}

/**
 * reports the status of the clinician's connection with this patient
 * @param context the portal context
 * @param caller the verified clinician
 * @returns the latest connection state, or 'none'
 */
function connectionStatus(context: PortalContext, caller: PersonRef): string {
  const row = context.sharing.db
    .prepare(
      `SELECT status FROM connections WHERE requester_issuer = ? AND requester_subject = ?
       ORDER BY created_at DESC, id LIMIT 1`,
    )
    .get(caller.issuer, caller.subject);

  return row ? String(row.status) : 'none';
}

/**
 * renders one evidence item
 * @param item the evidence item to render
 * @returns the markup
 */
function evidenceItem(item: EvidenceItem): SafeHtml {
  return html`<li><strong>${item.label}</strong>${
    item.factualValue === undefined ? '' : html`: ${item.factualValue}`
  }<div class="meta">${item.source}${
    item.authoredAt ? html` · authored ${item.authoredAt}` : ''
  } · imported ${item.importedAt} · ${item.verification}</div></li>`;
}

/**
 * renders one re-checked request
 * @param checked the request and its outcome now
 * @returns the markup
 */
function checkedCard(checked: CheckedRequest): SafeHtml {
  const { outcome } = checked;

  if (outcome.kind === 'denied') {
    return html`<div class="card"><p><strong>Request ${checked.requestId}</strong> (${checked.issuedAt})</p>
<p class="warn">No longer available: ${outcome.denial.message}</p></div>`;
  }

  const { result } = outcome;

  return html`<div class="card"><p><strong>Request ${checked.requestId}</strong> (${checked.issuedAt}) · encounter ${result.scope.encounterId} · ${result.scope.categories.join(', ') || 'baseline'} · access until ${result.scope.expiresAt}</p>
<p class="notice">${result.notice}</p><ol>${result.evidence.map(evidenceItem)}</ol>
<p class="meta">Receipt ${result.receiptId}</p></div>`;
}

/**
 * builds the expanded-scope form, when the clinician is connected
 * @param context the portal context
 * @param caller the verified clinician
 * @param csrf the session's CSRF token
 * @returns the markup
 */
function scopeForm(
  context: PortalContext,
  caller: PersonRef,
  csrf: string,
): SafeHtml {
  const { db } = context.sharing;
  const encounters = encountersAdmitting(db, caller, context.now());

  if (!hasConfirmedConnection(db, caller) || encounters.length === 0) {
    return html`<p class="meta">You can ask for more once the patient confirms your connection and an encounter admits you.</p>`;
  }

  return postForm({
    action: '/clinician/scope-requests',
    csrf,
    label: 'Ask the patient',
    fields: { requestId: randomUUID() },
    body: html`<label>Encounter <select name="encounterId">${encounters.map(
      (encounter) =>
        html`<option value="${encounter.id}">${encounter.id} (until ${encounter.endsAt})</option>`,
    )}</select></label>
<fieldset><legend>Categories</legend>${GRANTABLE_CATEGORIES.map(
      (category) =>
        html`<label><input type="checkbox" name="categories" value="${category}"> ${category}</label>`,
    )}</fieldset>
<label>Reason for the patient <textarea name="reason" maxlength="500" rows="3" required></textarea></label>
<label>Needed for <select name="desiredDays">${SCOPE_DAYS.map(
      (days) =>
        html`<option value="${days}">${days} day${days === 1 ? '' : 's'}</option>`,
    )}</select></label>`,
  });
}

/**
 * builds the clinician portal page
 * @param context the portal context
 * @param session the verified clinician's session
 * @param csrf the session's CSRF token
 * @returns the markup
 */
function clinicianBody(
  context: PortalContext,
  session: PortalSession,
  csrf: string,
): SafeHtml {
  const caller = personOf(session);
  const registry = session.clinician;
  const requests = checkedRequests(context, caller);
  const scopeRequests = listScopeRequests(context.sharing.db, {
    statuses: ['pending', 'approved', 'declined', 'expired', 'cancelled'],
    requester: caller,
  });

  return html`<h1>Clinician portal</h1>
<dl><dt>Signed in as</dt><dd>${caller.subject} at ${caller.issuer}</dd>
<dt>Verified by your institution</dt><dd>${
    registry
      ? html`${registry.displayName} · ${registry.organizationName ?? registry.organizationId ?? 'no organization'} · ${registry.roles.join(', ')} · ${registry.status}`
      : html`<span class="warn">Your institution did not sign you in with a clinical role Medissy accepts; nothing can be released to you.</span>`
  }</dd>
<dt>Connection with this patient</dt><dd>${connectionStatus(context, caller)}</dd></dl>
<section><h2>Evidence released to you</h2>
<p class="meta">Re-checked against the patient's current grants every time you open this page. Ask your agent to send a request to Medissy over A2A for new evidence.</p>
${requests.length === 0 ? html`<p class="meta">No evidence yet.</p>` : requests.map(checkedCard)}</section>
<section><h2>Your expanded-scope requests</h2>
${
  scopeRequests.length === 0
    ? html`<p class="meta">None.</p>`
    : scopeRequests.map(
        (request) =>
          html`<div class="card">${request.requestedCategories.join(', ')} in ${request.encounterId} until ${request.desiredExpiresAt}: <strong>${request.status}</strong></div>`,
      )
}
${scopeForm(context, caller, csrf)}</section>`;
}

/**
 * registers the generic landing; names no patient and needs no sign-in
 * @param app the encapsulated portal instance
 */
function registerLanding(app: FastifyInstance): void {
  app.get('/', async (_request, reply) =>
    sendPage(
      reply,
      page({
        title: 'Medissy',
        body: html`<h1>Medissy</h1>
<p>A patient's own AI agent for sharing selected health records with clinicians, under the patient's control.</p>
<ul><li><a href="/auth/owner/sign-in">Patient sign-in</a></li><li><a href="/auth/clinician/sign-in">Clinician sign-in</a></li></ul>
<p class="meta">Clinician agents connect over A2A; see the Agent Card at <a href="/.well-known/agent-card.json">/.well-known/agent-card.json</a>.</p>`,
      }),
    ),
  );
}

/**
 * registers the clinician page and scope requests
 * @param app the encapsulated portal instance
 * @param context the portal dependencies
 */
function registerClinicianPortal(
  app: FastifyInstance,
  context: PortalContext,
): void {
  const guard = { preHandler: context.identity.requireClinician };

  app.get('/clinician', guard, async (request, reply) => {
    const session = sessionOf(request);
    const csrf = context.identity.csrfToken(reply, session);

    return sendPage(
      reply,
      page({
        title: 'Clinician portal',
        nav: CLINICIAN_NAV,
        body: clinicianBody(context, session, csrf),
      }),
    );
  });

  app.post('/clinician/scope-requests', guard, async (request, reply) => {
    const days = choice(request, 'desiredDays', SCOPE_DAYS);
    const outcome =
      days === undefined
        ? ({ ok: false, code: 'invalid-input' } as const)
        : requestExpansion(context.sharing, {
            requester: personOf(sessionOf(request)),
            encounterId: field(request, 'encounterId'),
            categories: fields(request, 'categories').filter(
              (value): value is GrantableCategory =>
                (GRANTABLE_CATEGORIES as readonly string[]).includes(value),
            ),
            reason: field(request, 'reason'),
            desiredExpiresAt: new Date(
              context.now().getTime() + days * MS_PER_DAY,
            ).toISOString(),
            requestId: field(request, 'requestId'),
          });

    return outcome.ok
      ? reply.redirect('/clinician', HTTP_SEE_OTHER)
      : sendPage(reply, refusalPage(outcome.code, '/clinician'));
  });
}

/**
 * registers invitation redemption; the token arrives in the URL fragment, which
 * the browser never sends; the page's fixed script moves it into the form
 * @param app the encapsulated portal instance
 * @param context the portal context
 */
function registerConnect(app: FastifyInstance, context: PortalContext): void {
  const guard = { preHandler: context.identity.requireClinician };

  app.get('/connect', guard, async (request, reply) => {
    const csrf = context.identity.csrfToken(reply, sessionOf(request));

    return sendPage(
      reply,
      page({
        title: 'Redeem a share code',
        nav: CLINICIAN_NAV,
        script: CONNECT_SCRIPT,
        body: html`<h1>Redeem a share code</h1>
<p>Redeeming asks the patient to confirm you. Nothing is shared until they do.</p>
${postForm({
  action: '/connect',
  csrf,
  label: 'Ask the patient to connect',
  body: html`<label>Share code <input type="text" name="token" autocomplete="off" spellcheck="false" required></label>
<p class="meta">What you tell the patient about yourself (shown to them as unverified):</p>
<label>Name <input type="text" name="statedName" maxlength="${STATED_MAX}"></label>
<label>Organization <input type="text" name="statedOrganization" maxlength="${STATED_MAX}"></label>
<label>Role <input type="text" name="statedRole" maxlength="${STATED_MAX}"></label>`,
})}`,
      }),
    );
  });

  app.post('/connect', guard, async (request, reply) => {
    const stated = {
      name: field(request, 'statedName'),
      organization: field(request, 'statedOrganization'),
      role: field(request, 'statedRole'),
    };
    const redeemed = redeemInvitation(context.sharing, {
      token: field(request, 'token').trim(),
      requester: personOf(sessionOf(request)),
      stated: Object.fromEntries(
        Object.entries(stated).filter(([, value]) => value.trim() !== ''),
      ),
    });

    return redeemed.ok
      ? sendPage(
          reply,
          messagePage({
            status: 200,
            title: 'Pending patient confirmation',
            message:
              'The patient has been asked to confirm you. Nothing is shared until they do.',
            next: { href: '/clinician', label: 'Clinician portal' },
          }),
        )
      : sendPage(reply, refusalPage(redeemed.code, '/clinician'));
  });
}

/**
 * registers the landing and every clinician route
 * @param app the encapsulated portal instance
 * @param context the portal context
 */
export function registerClinicianRoutes(
  app: FastifyInstance,
  context: PortalContext,
): void {
  registerLanding(app);
  registerClinicianPortal(app, context);
  registerConnect(app, context);
}
