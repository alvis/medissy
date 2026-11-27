/**
 * the owner's step-up confirm pages (D3); a confirm page shows the proposed
 * grant in full; stated labels and reasons are marked untrusted and always
 * rendered as escaped text
 */
import { GRANTABLE_CATEGORIES } from '../contracts';

import { html, page, postForm } from './layout';
import {
  ENCOUNTER_DAYS,
  hoursLabel,
  OWNER_NAV,
  statedLabels,
  STEP_UP_MINUTES,
  VALIDITY_HOURS,
} from './owner-pages';

import type {
  ClinicianEntry,
  Connection,
  Encounter,
  ScopeRequest,
} from '../contracts';

import type { Page, SafeHtml } from './layout';

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;

/** what the confirm page shows about the requester */
export interface RequesterView {
  registry: ClinicianEntry | undefined;
  /** the ID token's `auth_time`; undefined when the issuer gave none */
  authenticatedAt: Date | undefined;
  now: Date;
  csrf: string;
}

/**
 * builds the requester block: verified identity and registry facts
 * @param requester the verified issuer and subject
 * @param requester.issuer the issuer that signed the requester in
 * @param requester.subject the requester's subject identifier
 * @param registry the registry entry, if any
 * @returns the markup
 */
function requesterBlock(
  requester: { issuer: string; subject: string },
  registry: ClinicianEntry | undefined,
): SafeHtml {
  return html`<dl><dt>Grantee (verified sign-in)</dt><dd>${requester.subject} at issuer ${requester.issuer}</dd>
<dt>Verified by the institution</dt><dd>${
    registry && registry.roles.length > 0
      ? html`${registry.displayName} · ${registry.organizationName ?? registry.organizationId ?? 'no organization'} · ${registry.roles.join(', ') || 'no roles'} · ${registry.status}`
      : html`<span class="warn">Not signed in by the trusted institution with a clinical role: a grant releases nothing until they are.</span>`
  }</dd></dl>`;
}

/**
 * tells the owner when they last authenticated, and offers a fresh sign-in when
 * that is too old to create a grant
 * @param view the requester view
 * @returns the markup
 */
function stepUpNotice(view: RequesterView): SafeHtml {
  const at = view.authenticatedAt;
  const fresh =
    at !== undefined &&
    view.now.getTime() - at.getTime() <= STEP_UP_MINUTES * MS_PER_MINUTE;

  return html`<p class="${fresh ? 'notice' : 'warn'}">You last authenticated at ${at?.toISOString() ?? 'an unknown time'}. Creating a grant needs a sign-in from the last ${STEP_UP_MINUTES} minutes${
    fresh ? '.' : html`; <a href="/auth/owner/sign-in">sign in again</a> first.`
  }</p>`;
}

/**
 * builds the category, sensitivity and validity controls
 * @param params the allowed and preselected categories, and validity choices
 * @param params.allowed categories the owner may pick
 * @param params.checked categories preselected
 * @param params.validity the validity choices in hours
 * @param params.extraValidity an extra "requested" choice label
 * @returns the markup
 */
function scopeControls(params: {
  allowed: readonly string[];
  checked: readonly string[];
  validity: readonly number[];
  extraValidity?: string;
}): SafeHtml {
  return html`<fieldset><legend>Categories</legend>${params.allowed.map(
    (category) =>
      html`<label><input type="checkbox" name="categories" value="${category}"${
        params.checked.includes(category) ? html` checked` : ''
      }> ${category}</label>`,
  )}</fieldset>
<fieldset><legend>Maximum sensitivity</legend>
<label><input type="radio" name="maxSensitivity" value="routine" checked> routine</label>
<label><input type="radio" name="maxSensitivity" value="restricted"> restricted (mental health, substance use)</label></fieldset>
<label>Valid for <select name="validityHours">${
    params.extraValidity
      ? html`<option value="requested" selected>${params.extraValidity}</option>`
      : ''
  }${params.validity.map(
    (hours) => html`<option value="${hours}">${hoursLabel(hours)}</option>`,
  )}</select></label>`;
}

/**
 * builds the confirm page for a pending connection
 * @param params the connection, admitting encounters and requester view
 * @param params.connection the pending connection
 * @param params.encounters existing encounters that admit the requester
 * @param params.view registry, sign-in time, clock and CSRF token
 * @returns the form page that confirms or refuses it
 */
export function confirmConnectionPage(params: {
  connection: Connection & { lapsed: boolean };
  encounters: Encounter[];
  view: RequesterView;
}): Page {
  const { connection, encounters, view } = params;
  const action = `/owner/confirm/${connection.id}`;
  const declineAction = `${action}/decline`;

  return page({
    title: 'Confirm a connection',
    nav: OWNER_NAV,
    body: html`<h1>Confirm a connection</h1>
<p>Nothing is shared until you post this page. Review the proposed grant in full.</p>
${requesterBlock(connection.requester, view.registry)}${statedLabels(connection)}
${stepUpNotice(view)}
${
  connection.lapsed
    ? html`<p class="warn">This request waited too long and can only be declined.</p>`
    : postForm({
        action,
        csrf: view.csrf,
        label: 'Create this grant',
        body: html`<fieldset><legend>Encounter</legend>${encounters.map(
          (encounter, index) =>
            html`<label><input type="radio" name="encounter" value="existing:${encounter.id}"${
              index === 0 ? html` checked` : ''
            }> Existing encounter ${encounter.id} (${encounter.startsAt} to ${encounter.endsAt})</label>`,
        )}<label><input type="radio" name="encounter" value="new"${
          encounters.length === 0 ? html` checked` : ''
        }> New encounter for this clinician</label>
<label>Reason (optional) <input type="text" name="newEncounterReason" maxlength="500"></label>
<label>Lasting <select name="newEncounterDays">${ENCOUNTER_DAYS.map(
          (days) =>
            html`<option value="${days}">${days} day${days === 1 ? '' : 's'}</option>`,
        )}</select></label></fieldset>
<label><input type="checkbox" name="baseline" value="on" checked> Include the approved baseline summary</label>
${scopeControls({ allowed: GRANTABLE_CATEGORIES, checked: [], validity: VALIDITY_HOURS })}
<p>Purpose: direct treatment.</p>`,
      })
}
${postForm({ action: declineAction, csrf: view.csrf, label: 'Decline', secondary: true })}`,
  });
}

/**
 * builds the confirm page for a pending scope request
 * @param params the request and requester view
 * @param params.request the pending scope request
 * @param params.view registry, sign-in time, clock and CSRF token
 * @returns the form page that confirms or refuses it
 */
export function confirmScopePage(params: {
  request: ScopeRequest;
  view: RequesterView;
}): Page {
  const { request, view } = params;
  const action = `/owner/confirm/${request.id}`;
  const declineAction = `${action}/decline`;
  const remaining = Date.parse(request.desiredExpiresAt) - view.now.getTime();
  const validity = VALIDITY_HOURS.filter(
    (hours) => hours * MS_PER_HOUR <= remaining,
  );

  return page({
    title: 'Approve expanded scope',
    nav: OWNER_NAV,
    body: html`<h1>Approve expanded scope</h1>
<p>Nothing new is shared until you post this page. Approval issues a new grant for only what you tick, for the time you choose.</p>
${requesterBlock(request.requester, view.registry)}
<dl><dt>Encounter</dt><dd>${request.encounterId}</dd><dt>Requested</dt><dd>${request.requestedCategories.join(', ')} until ${request.desiredExpiresAt}</dd></dl>
<div class="untrusted"><strong>Stated reason (unverified):</strong> ${request.reason}</div>
${stepUpNotice(view)}
${postForm({
  action,
  csrf: view.csrf,
  label: 'Approve this grant',
  body: scopeControls({
    allowed: request.requestedCategories,
    checked: request.requestedCategories,
    validity,
    extraValidity: `Until ${request.desiredExpiresAt} (requested)`,
  }),
})}
${postForm({ action: declineAction, csrf: view.csrf, label: 'Decline', secondary: true })}`,
  });
}
