/**
 * the page shell every portal page uses: a complete server-rendered document
 * labelled SYNTHETIC DEMO, built only through the escaping `html` template,
 * served with a CSP that forbids every fetch, framing and foreign form target;
 * a page may carry one fixed inline script, allowed by its hash only
 */
import { createHash } from 'node:crypto';

import { SYNTHETIC_LABEL } from '../widgets/cards';
import { html, SafeHtml } from '../widgets/html';

import type { FastifyReply } from 'fastify';

import type { HtmlValue } from '../widgets/html';

export { html, SafeHtml };
export type { HtmlValue };

/** a complete page and the hash of its one inline script, if any */
export interface Page {
  status: number;
  document: string;
  scriptHash?: string;
}

const HTTP_OK = 200;

const STYLES = `
:root { color-scheme: light; --paper: #faf8f4; --teal: #0f5257; --slate: #2f3b45; --muted: #55626d; --coral: #e8755a; --line: #d9dedf; }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--paper); color: var(--slate); }
main { max-width: 860px; margin: 0 auto; padding: 16px; }
header.top { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 4px; background: var(--coral); color: #1d1d1d; font-weight: 700; letter-spacing: .04em; font-size: 13px; }
h1 { color: var(--teal); font-size: 24px; margin: 12px 0 4px; }
h2 { color: var(--teal); font-size: 19px; margin: 24px 0 8px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
section { margin-bottom: 8px; }
.card { background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin: 8px 0; }
.untrusted { border-left: 4px solid var(--coral); padding: 4px 10px; background: #fdf1ed; overflow-wrap: anywhere; }
.notice { border-left: 4px solid var(--teal); padding: 8px 10px; background: #eef4f3; }
.warn { border-left: 4px solid #8a5a00; padding: 8px 10px; background: #fff6e0; }
.meta { color: var(--muted); font-size: 14px; }
.qr svg { width: 240px; height: 240px; max-width: 100%; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
.scroll { overflow-x: auto; }
fieldset { border: 1px solid var(--line); border-radius: 6px; margin: 8px 0; }
label { display: block; margin: 4px 0; }
button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 2px solid var(--teal); background: var(--teal); color: #fff; cursor: pointer; }
button.secondary { background: #fff; color: var(--teal); }
button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 3px solid var(--coral); outline-offset: 2px; }
a { color: var(--teal); }
.inline { display: inline; }
textarea, input[type=text], select { font: inherit; max-width: 100%; }
`;

/**
 * builds the CSP for a page
 * @param scriptHash the base64 SHA-256 of the page's one inline script
 * @returns the policy
 */
export function pageCsp(scriptHash?: string): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    ...(scriptHash ? [`script-src 'sha256-${scriptHash}'`] : []),
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ');
}

/**
 * computes the CSP hash of a fixed inline script
 * @param source the script text
 * @returns its base64 SHA-256
 */
export function scriptHashOf(source: string): string {
  return createHash('sha256').update(source).digest('base64');
}

/**
 * builds a complete page
 * @param params the title, body, status and an optional fixed script
 * @param params.title the document title
 * @param params.body the markup placed inside the page
 * @param params.status the HTTP status (200 by default)
 * @param params.script a fixed inline script (never built from input)
 * @param params.nav links shown in the header
 * @returns the page, with the hash of its script if any
 */
export function page(params: {
  title: string;
  body: SafeHtml;
  status?: number;
  script?: string;
  nav?: SafeHtml;
}): Page {
  const script = params.script;
  const scriptTag = script
    ? html`<script>${SafeHtml.fromTemplate(script)}</script>`
    : '';

  return {
    status: params.status ?? HTTP_OK,
    scriptHash: script ? scriptHashOf(script) : undefined,
    document: html`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${params.title} · Medissy (${SYNTHETIC_LABEL})</title>
<style>${SafeHtml.fromTemplate(STYLES)}</style></head>
<body><main>
<header class="top"><span class="badge">${SYNTHETIC_LABEL}</span>${params.nav ?? ''}</header>
<p class="meta">Synthetic demonstration data only. This prototype does not handle legally compliant patient consent.</p>
${params.body}
</main>${scriptTag}</body></html>`.toString(),
  };
}

/**
 * sends a page with its security headers
 * @param reply the reply to send on
 * @param built the page to send
 * @returns the reply
 */
export function sendPage(reply: FastifyReply, built: Page): FastifyReply {
  return pageHeaders(reply.code(built.status), built.scriptHash).send(
    built.document,
  );
}

/**
 * sets the HTML type and security headers every page carries
 * @param reply the reply to add headers to
 * @param scriptHash the hash of the page's one inline script, if any
 * @returns the reply
 */
export function pageHeaders(
  reply: FastifyReply,
  scriptHash?: string,
): FastifyReply {
  return reply
    .type('text/html; charset=utf-8')
    .header('content-security-policy', pageCsp(scriptHash))
    .header('cache-control', 'no-store')
    .header('x-content-type-options', 'nosniff')
    .header('referrer-policy', 'no-referrer');
}

/**
 * builds a POST form with the session's CSRF token
 * @param params the action, token, contents and submit label
 * @param params.action the same-origin path
 * @param params.csrf the session-bound CSRF token
 * @param params.label the submit button text
 * @param params.fields extra hidden fields
 * @param params.body the visible form controls
 * @param params.secondary render the button as secondary
 * @returns the form markup
 */
export function postForm(params: {
  action: string;
  csrf: string;
  label: string;
  fields?: Readonly<Record<string, string>>;
  body?: SafeHtml;
  secondary?: boolean;
}): SafeHtml {
  const hidden = Object.entries({ _csrf: params.csrf, ...params.fields }).map(
    ([name, value]) =>
      html`<input type="hidden" name="${name}" value="${value}">`,
  );

  return html`<form method="post" action="${params.action}">${hidden}${
    params.body ?? ''
  }<button type="submit"${
    params.secondary ? html` class="secondary"` : ''
  }>${params.label}</button></form>`;
}

/**
 * builds a simple message page
 * @param params the status, title and message
 * @param params.status the HTTP status
 * @param params.title the heading
 * @param params.message the explanation
 * @param params.next an optional next-step link
 * @param params.next.href the link target (a fixed path)
 * @param params.next.label the link text
 * @returns the page showing that status and message
 */
export function messagePage(params: {
  status: number;
  title: string;
  message: string;
  next?: { href: string; label: string };
}): Page {
  return page({
    status: params.status,
    title: params.title,
    body: html`<h1>${params.title}</h1><p class="notice">${params.message}</p>${
      params.next
        ? html`<p><a href="${params.next.href}">${params.next.label}</a></p>`
        : ''
    }`,
  });
}
