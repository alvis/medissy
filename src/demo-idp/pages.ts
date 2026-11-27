/**
 * server-rendered pages of both synthetic issuers; every page carries its
 * issuer's SYNTHETIC banner; every dynamic value goes through `escapeHtml`;
 * the only unescaped fragments are the forms oidc-provider builds itself (it
 * escapes their values with its own html_safe helper)
 */
import type { SignInContext } from '../contracts/signin';

import type { DemoUser } from './users';

/**
 * Content-Security-Policy for every demo IdP page; no scripts, no external
 * loads, forms only back to this origin, never framed
 */
export const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * escapes text for an HTML element body or a quoted attribute
 * @param value untrusted text
 * @returns the escaped text
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/**
 * wraps a body in the labelled synthetic layout
 * @param page the issuer's banner, the title (both escaped here) and the body
 * @param page.label the issuer's SYNTHETIC banner
 * @param page.title text for `<title>` and the heading
 * @param page.body trusted, already-escaped body HTML
 * @returns a full HTML document
 */
function layout(page: { label: string; title: string; body: string }): string {
  const { label, title, body } = page;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · ${escapeHtml(label)}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:32rem;margin:1.5rem auto;padding:0 1rem;color:#1b1b1b;background:#fff}
.banner{background:#7a1f00;color:#fff;padding:.5rem .75rem;font-weight:700;border-radius:4px}
button{display:block;width:100%;margin:.5rem 0;padding:.6rem;font-size:1rem;text-align:left;cursor:pointer}
.secondary{background:none;border:none;color:#555;text-decoration:underline;text-align:center}
code{font-size:1.5rem}
input[type=text]{font-size:1.2rem;padding:.4rem;width:100%;box-sizing:border-box;text-transform:uppercase}
input[type=password]{font-size:1rem;padding:.4rem;width:100%;box-sizing:border-box}
dl.task{border:2px solid #7a1f00;border-radius:4px;padding:.5rem .75rem}
dl.task dt{font-weight:700}dl.task dd{margin:0 0 .5rem 0;overflow-wrap:anywhere}
.warning{color:#7a1f00;font-weight:700}
</style>
</head>
<body>
<p class="banner" role="note">${escapeHtml(label)}</p>
<h1>${escapeHtml(title)}</h1>
${body}
</body>
</html>`;
}

/** what the account picker needs */
export interface LoginPageInput {
  /** the issuer's SYNTHETIC banner */
  label: string;
  action: string;
  abortAction: string;
  csrfToken: string;
  clientName: string;
  users: readonly DemoUser[];
  /** a short status shown above the form (escaped), e.g. after a failed try */
  message?: string;
}

/**
 * renders the synthetic account picker shown for a login interaction
 * @param input form targets, CSRF token, requesting client and accounts
 * @returns the HTML page
 */
export function loginPage(input: LoginPageInput): string {
  const csrf = `<input type="hidden" name="_csrf" value="${escapeHtml(input.csrfToken)}">`;
  const buttons = input.users
    .map(
      (user) =>
        `<button type="submit" name="account" value="${escapeHtml(user.key)}"><strong>${escapeHtml(user.displayName)}</strong><br><small>${escapeHtml(user.description)}</small></button>`,
    )
    .join('\n');

  return layout({
    label: input.label,
    title: 'Choose a synthetic account',
    body: `<p>${escapeHtml(input.clientName)} asks you to sign in. Enter the demo passphrase for one of the fictional accounts, then pick it.</p>
${input.message ? `<p class="warning" role="alert">${escapeHtml(input.message)}</p>` : ''}
<form method="post" action="${escapeHtml(input.action)}">
${csrf}
<label for="passphrase">Demo passphrase</label>
<input type="password" id="passphrase" name="passphrase" autocomplete="current-password" required maxlength="256">
${buttons}
</form>
<form method="post" action="${escapeHtml(input.abortAction)}">
${csrf}
<button type="submit" class="secondary">Cancel and deny</button>
</form>`,
  });
}

/** what the user-code input page shows */
export interface DeviceInputInput {
  /** the issuer's SYNTHETIC banner */
  label: string;
  /** the provider-built form (its values are escaped by the provider) */
  providerForm: string;
  /** a status message (escaped here) */
  message: string;
}

/**
 * wraps oidc-provider's user-code input form
 * @param input the banner, the provider form and a status message
 * @returns the HTML page
 */
export function deviceInputPage(input: DeviceInputInput): string {
  return layout({
    label: input.label,
    title: 'Enter the sign-in code',
    body: `<p>${escapeHtml(input.message)}</p>
${input.providerForm}
<button type="submit" form="op.deviceInputForm">Continue</button>`,
  });
}

/**
 * the device-code phishing warning; whoever showed the code gets the result
 * (a share code included), so the person must have started the request
 */
export const DEVICE_RESULT_WARNING =
  'The result goes to the agent that showed you this code. Only continue if you started this request.';

/** what the device confirmation page shows */
export interface DeviceConfirmInput {
  /** the issuer's SYNTHETIC banner */
  label: string;
  /** the provider-built form (its values are escaped by the provider) */
  providerForm: string;
  clientName: string;
  userCode: string;
  /** the requesting task, or null when none (or an invalid one) was sent */
  context: SignInContext | null;
}

/**
 * renders the task the code belongs to, or a warning when it is unknown
 * @param context the validated task context
 * @returns trusted HTML with every value escaped
 */
function taskDetails(context: SignInContext | null): string {
  if (!context) {
    return '<p class="warning" role="alert">This code carries no task details. Abort unless you started this sign-in yourself a moment ago.</p>';
  }

  return `<p class="warning">Before you continue, open your own agent and compare its task code with this one. Approve only if they match exactly.</p>
<dl class="task">
<dt>Task code</dt><dd><code>${escapeHtml(context.taskDigest)}</code></dd>
</dl>
<p>Sent by the requesting agent (unverified). Medissy has not checked these details; do not rely on them:</p>
<dl class="task">
<dt>Encounter (unverified)</dt><dd>${escapeHtml(context.encounterLabel)}</dd>
<dt>Question (unverified)</dt><dd>${escapeHtml(context.question)}</dd>
</dl>`;
}

/**
 * wraps oidc-provider's user-code confirmation form with the task context
 * @param input form, client, code and task context (escaped here)
 * @returns the HTML page
 */
export function deviceConfirmPage(input: DeviceConfirmInput): string {
  return layout({
    label: input.label,
    title: 'Confirm the sign-in code',
    body: `<p><strong>${escapeHtml(input.clientName)}</strong> is asking you to sign in with code <code>${escapeHtml(input.userCode)}</code>.</p>
<p class="warning" role="alert"><strong>${DEVICE_RESULT_WARNING}</strong></p>
${taskDetails(input.context)}
${input.providerForm}
<button type="submit" form="op.deviceConfirmForm">Continue</button>
<button type="submit" form="op.deviceConfirmForm" name="abort" value="yes" class="secondary">Abort</button>`,
  });
}

/**
 * renders the page shown after a device sign-in completes
 * @param label the issuer's SYNTHETIC banner
 * @returns the HTML page
 */
export function deviceSuccessPage(label: string): string {
  return layout({
    label,
    title: 'Signed in',
    body: '<p>Sign-in complete. Return to your agent; you can close this page.</p>',
  });
}

/** what an error page shows */
export interface ErrorPageInput {
  /** the issuer's SYNTHETIC banner */
  label: string;
  /** the headline */
  title: string;
  /** a short explanation; escaped here and never a token */
  detail: string;
}

/**
 * renders a generic error page
 * @param input the banner, headline and explanation
 * @returns the HTML page
 */
export function errorPage(input: ErrorPageInput): string {
  return layout({
    label: input.label,
    title: input.title,
    body: `<p>${escapeHtml(input.detail)}</p>`,
  });
}
