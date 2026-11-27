/**
 * the owner's dashboard page, and the choices and labels the confirm pages
 * (`owner-confirm-pages.ts`) share with it; stated labels and reasons are
 * marked untrusted and always rendered as escaped text
 */
import { qrMarkup } from '../widgets/qr';

import { html, page, postForm } from './layout';

import type { Connection, Grant, ScopeRequest } from '../contracts';
import type { SubmissionReceipt } from '../inbound';

import type { Page, SafeHtml } from './layout';
import type {
  LedgerEvent,
  LedgerReceipt,
  SourceSummary,
  SyncStatus,
  UnsignedRequests,
} from './owner-data';

const ONE_DAY_HOURS = 24;
const ONE_WEEK_HOURS = 168;
const THIRTY_DAYS_HOURS = 720;
const NINETY_DAYS_HOURS = 2160;
const ONE_WEEK_DAYS = 7;
const ONE_MONTH_DAYS = 30;
const ONE_QUARTER_DAYS = 90;

/** grant validity choices, in hours */
export const VALIDITY_HOURS = [
  1,
  ONE_DAY_HOURS,
  ONE_WEEK_HOURS,
  THIRTY_DAYS_HOURS,
  NINETY_DAYS_HOURS,
] as const;
/** new-encounter length choices, in days */
export const ENCOUNTER_DAYS = [
  1,
  ONE_WEEK_DAYS,
  ONE_MONTH_DAYS,
  ONE_QUARTER_DAYS,
] as const;
/** how fresh the owner's sign-in must be for the confirm POST */
export const STEP_UP_MINUTES = 5;

export const OWNER_NAV = html`<nav><a href="/owner">Dashboard</a></nav>`;

/** a freshly minted share code */
export interface ShareView {
  url: string;
  expiresAt: string;
  svg: string;
}

/** everything the dashboard shows */
export interface DashboardView {
  origin: string;
  csrf: string;
  now: Date;
  share?: ShareView;
  syncConfigured: boolean;
  syncMessage?: string;
  sources: SourceSummary[];
  latestSync?: SyncStatus;
  lastSyncAt?: string;
  connections: Array<Connection & { lapsed: boolean }>;
  scopeRequests: ScopeRequest[];
  grants: Grant[];
  receipts: LedgerReceipt[];
  /** requests that stopped at sign-in, as content-free day counts */
  unsigned: UnsignedRequests;
  /** records the care team handed back (ADR-10), newest first */
  inbound: SubmissionReceipt[];
  ledger: LedgerEvent[];
}

/**
 * builds a human label for a duration in hours
 * @param hours the duration
 * @returns the duration in days or hours
 */
export function hoursLabel(hours: number): string {
  const day = 24;

  if (hours < day) {
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }

  return `${hours / day} days`;
}

/**
 * returns a grant's state at `now`
 * @param grant the effective grant version
 * @param now the server clock
 * @returns active, not yet valid, expired or revoked
 */
function grantState(grant: Grant, now: Date): string {
  if (grant.revokedAt) {
    return `revoked ${grant.revokedAt}`;
  }

  if (Date.parse(grant.expiresAt) <= now.getTime()) {
    return 'expired';
  }

  return Date.parse(grant.validFrom) > now.getTime()
    ? 'not yet valid'
    : 'active';
}

/**
 * builds the stated, untrusted labels of a connection
 * @param connection the pending connection
 * @returns the markup
 */
export function statedLabels(connection: Connection): SafeHtml {
  return html`<div class="untrusted"><strong>Stated by the requester (unverified):</strong>
name ${connection.statedName ?? '—'} · organization ${connection.statedOrganization ?? '—'} · role ${connection.statedRole ?? '—'}</div>`;
}

/**
 * builds the share section: the health address and, after minting, the QR
 * @param view the dashboard view
 * @returns the markup
 */
function shareSection(view: DashboardView): SafeHtml {
  return html`<section><h2>Health address</h2>
<p><strong>${view.origin}</strong></p>
<p class="meta">The address is a locator, never a credential. A share code adds a single-use invitation; you confirm every connection here.</p>
${
  view.share
    ? html`<div class="card"><div class="qr">${qrMarkup(view.share.svg)}</div>
<p>Share link (shown once): <code>${view.share.url}</code></p>
<p class="meta">Expires ${view.share.expiresAt}. Single use.</p></div>`
    : ''
}
${postForm({ action: '/owner/invitations', csrf: view.csrf, label: 'Create a share code' })}</section>`;
}

/**
 * builds the sources section with the owner-triggered sync
 * @param view the dashboard view
 * @returns the markup
 */
function sourcesSection(view: DashboardView): SafeHtml {
  const sync = view.latestSync;

  return html`<section><h2>Sources</h2>
<p>Last successful sync: ${view.lastSyncAt ?? 'never'}${
    sync
      ? html` · latest run ${sync.status} (${sync.adapter}) started ${sync.startedAt}`
      : ''
  }</p>
${
  view.sources.length > 0
    ? html`<div class="scroll"><table><thead><tr><th>Provider</th><th>Files</th><th>Records</th><th>Last import</th></tr></thead><tbody>${view.sources.map(
        (source) =>
          html`<tr><td>${source.provider}</td><td>${source.files}</td><td>${source.records}</td><td>${source.lastImportedAt}</td></tr>`,
      )}</tbody></table></div>`
    : html`<p class="meta">No records imported yet.</p>`
}
${view.syncMessage ? html`<p class="notice">${view.syncMessage}</p>` : ''}
${
  view.syncConfigured
    ? postForm({
        action: '/owner/sync',
        csrf: view.csrf,
        label: 'Sync from Box now',
      })
    : html`<p class="warn">Box sync: NOT CONFIGURED in this deployment.</p>${postForm({ action: '/owner/sync', csrf: view.csrf, label: 'Sync from Box now', secondary: true })}`
}</section>`;
}

/**
 * builds the pending section: connections and scope requests awaiting the owner
 * @param view the dashboard view
 * @returns the markup
 */
function pendingSection(view: DashboardView): SafeHtml {
  const empty =
    view.connections.length === 0 && view.scopeRequests.length === 0;

  return html`<section><h2>Waiting for you</h2>
${empty ? html`<p class="meta">Nothing is waiting.</p>` : ''}
${view.connections.map(
  (
    connection,
  ) => html`<div class="card"><p><strong>Connection request</strong> from ${connection.requester.subject} <span class="meta">(${connection.requester.issuer})</span>, received ${connection.createdAt}${
    connection.lapsed
      ? html` · <strong>lapsed</strong> (can only be declined)`
      : ''
  }</p>${statedLabels(connection)}
<p><a href="/owner/confirm/${connection.id}">Review the proposed grant</a></p></div>`,
)}
${view.scopeRequests.map(
  (
    request,
  ) => html`<div class="card"><p><strong>Expanded-scope request</strong> from ${request.requester.subject} for ${request.requestedCategories.join(', ')} in encounter ${request.encounterId}, until ${request.desiredExpiresAt}</p>
<div class="untrusted"><strong>Stated reason (unverified):</strong> ${request.reason}</div>
<p><a href="/owner/confirm/${request.id}">Review the proposed grant</a></p></div>`,
)}</section>`;
}

/**
 * returns who a grant names: the subject, or the organization and roles
 * @param grant the grant being shown
 * @returns the grantee as text
 */
function granteeLabel(grant: Grant): string {
  const { grantee } = grant;
  const roles = (grantee.roles ?? []).join(', ');

  return grantee.subject ?? `${grantee.organizationId ?? ''} (${roles})`;
}

/**
 * builds the grants section with revoke buttons
 * @param view the dashboard view
 * @returns the markup
 */
function grantsSection(view: DashboardView): SafeHtml {
  return html`<section><h2>Grants</h2>
${
  view.grants.length === 0
    ? html`<p class="meta">No grants.</p>`
    : view.grants.map(
        (
          grant,
        ) => html`<div class="card"><p><strong>${grant.effect}</strong> ${granteeLabel(grant)} · encounter ${grant.encounterId} · version ${grant.version}</p>
<p>Categories: ${grant.categories.join(', ') || 'none'}${grant.allowBaseline ? ' + baseline' : ''} · max sensitivity ${grant.maxSensitivity} · ${grant.validFrom} to ${grant.expiresAt} · <strong>${grantState(grant, view.now)}</strong></p>
${
  grant.revokedAt
    ? ''
    : postForm({
        action: `/owner/grants/${grant.id}/revoke`,
        csrf: view.csrf,
        label: 'Revoke now',
        secondary: true,
      })
}</div>`,
      )
}
<p class="meta">Revoking stops every later request, poll and download. It cannot retract what a clinician already received.</p></section>`;
}

/**
 * builds one record the care team handed back, with a Remove while it is current
 * @param receipt the receipt to show
 * @param csrf the session's CSRF token
 * @returns the card markup
 */
function inboundCard(receipt: SubmissionReceipt, csrf: string): SafeHtml {
  const current = receipt.status === 'current';
  const organization = receipt.organizationName
    ? html` <span class="meta">(${receipt.organizationName})</span>`
    : '';
  const removedAt = receipt.removedAt ? html` on ${receipt.removedAt}` : '';
  const remove = current
    ? postForm({
        action: `/owner/inbound/${receipt.id}/remove`,
        csrf,
        label: 'Remove',
        secondary: true,
      })
    : '';

  return html`<div class="card"><p><strong>${receipt.resourceType}</strong> from ${receipt.submitterName}${organization}, received ${receipt.submittedAt}</p>
<p>Filed as ${receipt.filedName} · Box file ${receipt.boxFileId} · ${receipt.category} · <strong>${current ? 'shareable' : 'removed'}</strong>${removedAt}</p>
${remove}</div>`;
}

/**
 * builds the records the care team handed back (ADR-10)
 * @param view the dashboard view
 * @returns the markup
 */
function inboundSection(view: DashboardView): SafeHtml {
  return html`<section><h2>Records received from your care team</h2>
${
  view.inbound.length === 0
    ? html`<p class="meta">No records received.</p>`
    : view.inbound.map((receipt) => inboundCard(receipt, view.csrf))
}
<p class="meta">A received record is shareable under your grants at once. Remove marks it entered-in-error: Medissy never shares it again. It cannot retract what a clinician already received, and the file stays in your Box folder.</p></section>`;
}

/** what each skill's request is called on the dashboard */
const SKILL_LABELS: Readonly<Record<string, string>> = {
  'clinical-evidence-request': 'Request for records',
  'submit-record': 'Record hand-back',
  'redeem-invitation': 'Invitation redemption',
  'share-code': 'Share code (your own)',
};

/**
 * builds the requests that never signed in: day counts only, since nothing about
 * those callers is kept
 * @param unsigned the day counts and the number still waiting
 * @returns the markup
 */
function unsignedPart(unsigned: UnsignedRequests): SafeHtml {
  return html`<h3>Requests that never signed in</h3>
<p class="meta">Each was asked to sign in first and got nothing. Medissy keeps only a count per day, nothing about the caller. Waiting for a sign-in now: ${String(unsigned.waiting)}.</p>
${
  unsigned.days.length === 0
    ? html`<p class="meta">None so far.</p>`
    : html`<div class="scroll"><table><thead><tr><th>Day (UTC)</th><th>Request</th><th>Stopped at sign-in</th></tr></thead><tbody>${unsigned.days.map(
        (day) =>
          html`<tr><td>${day.day}</td><td>${SKILL_LABELS[day.skill] ?? day.skill}</td><td>${String(day.stopped)}</td></tr>`,
      )}</tbody></table></div>`
}`;
}

/**
 * builds the receipts and the full audit ledger
 * @param view the dashboard view
 * @returns the markup
 */
function ledgerSection(view: DashboardView): SafeHtml {
  return html`<section><h2>Disclosure receipts</h2>
${
  view.receipts.length === 0
    ? html`<p class="meta">No disclosures yet.</p>`
    : html`<div class="scroll"><table><thead><tr><th>Time</th><th>Requester</th><th>Encounter</th><th>Decision</th><th>Records released</th></tr></thead><tbody>${view.receipts.map(
        (receipt) =>
          html`<tr><td>${receipt.issuedAt}</td><td>${receipt.requester}</td><td>${receipt.encounterId}</td><td>${receipt.decision} (${receipt.rationaleCode})</td><td>${receipt.recordIds.join(', ') || '—'}</td></tr>`,
      )}</tbody></table></div>`
}${unsignedPart(view.unsigned)}</section>
<section><h2>Full ledger</h2>
${
  view.ledger.length === 0
    ? html`<p class="meta">No events yet.</p>`
    : html`<div class="scroll"><table><thead><tr><th>Time</th><th>Event</th><th>Outcome</th><th>Actor</th><th>Target</th></tr></thead><tbody>${view.ledger.map(
        (event) =>
          html`<tr><td>${event.occurredAt}</td><td>${event.type}</td><td>${event.outcome}</td><td>${event.actor}</td><td>${event.target ?? '—'}</td></tr>`,
      )}</tbody></table></div>`
}</section>`;
}

/**
 * builds the owner dashboard
 * @param view what to show
 * @returns the owner's home page with its forms
 */
export function dashboardPage(view: DashboardView): Page {
  return page({
    title: 'Your Medissy',
    nav: OWNER_NAV,
    body: html`<h1>Your Medissy</h1>
${shareSection(view)}${pendingSection(view)}${grantsSection(view)}${inboundSection(view)}${sourcesSection(view)}${ledgerSection(view)}`,
  });
}
