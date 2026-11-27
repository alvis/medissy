/**
 * self-contained HTML cards for the `text/html` part (decision D9); every
 * card is built through the escaping `html` template from released fields
 * only: no record body beyond the released evidence text, no question text,
 * no link, image or script, and a CSP that forbids any fetch; the stylesheet
 * is literal template text; nothing is interpolated into it
 */
import { describeConflicts } from './conflicts';
import { html } from './html';
import { qrMarkup } from './qr';

import type { DisclosureResult, EvidenceItem } from '../contracts';

import type { SafeHtml } from './html';

/** label every card carries (brief §10) */
export const SYNTHETIC_LABEL = 'SYNTHETIC DEMO';

/** forbids every fetch; only the inline stylesheet applies */
const CARD_CSP = "default-src 'none'; style-src 'unsafe-inline'";

/**
 * wraps a card body in a complete, fetch-free document
 * @param title the document title
 * @param body the card body
 * @returns the document markup
 */
function page(title: string, body: SafeHtml): string {
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CARD_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root { color-scheme: light; }
body { margin: 0; font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; background: #faf8f4; color: #2f3b45; }
.card { max-width: 640px; margin: 0 auto; padding: 16px; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 4px; background: #e8755a; color: #1d1d1d; font-weight: 700; letter-spacing: .04em; font-size: 12px; }
h1 { margin: 8px 0 4px; font-size: 20px; color: #0f5257; }
.notice { margin: 8px 0; padding: 8px 10px; border-left: 4px solid #0f5257; background: #eef4f3; }
dl.scope { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 8px 0; }
dl.scope dt { font-weight: 600; }
dl.scope dd { margin: 0; }
ol.evidence { padding-left: 20px; }
ol.evidence li { margin: 6px 0; }
.value { font-weight: 600; }
.meta { color: #55626d; font-size: 13px; }
.limits { color: #55626d; font-size: 13px; }
.conflicts { margin: 8px 0; padding: 8px 10px; border-left: 4px solid #e8755a; background: #fbefe9; }
.conflicts h2 { margin: 0 0 4px; font-size: 15px; }
.conflicts ul { margin: 0; padding-left: 20px; }
.qr svg { width: 220px; height: 220px; }
footer { margin-top: 12px; font-size: 12px; color: #55626d; }
</style></head>
<body><main class="card"><span class="badge">${SYNTHETIC_LABEL}</span>${body}</main></body></html>`.toString();
}

/**
 * renders one evidence item
 * @param item the released evidence card
 * @returns the list item
 */
function evidenceItem(item: EvidenceItem): SafeHtml {
  return html`<li><span class="label">${item.label}</span>${
    item.factualValue === undefined
      ? ''
      : html`: <span class="value">${item.factualValue}</span>`
  }<div class="meta">${item.source}${
    item.authoredAt ? html` · authored ${item.authoredAt}` : ''
  } · imported ${item.importedAt} · ${item.verification}</div></li>`;
}

/**
 * renders the flagged conflicts, when there are any
 * @param result the validated disclosure result
 * @returns the section, or nothing
 */
function conflictsSection(result: DisclosureResult): SafeHtml | '' {
  const lines = describeConflicts(result);

  const items = lines.map((line) => html`<li>${line}</li>`);

  return lines.length > 0
    ? html`<section class="conflicts"><h2>Conflicts flagged (${lines.length})</h2><ul>${items}</ul></section>`
    : '';
}

/**
 * builds the evidence card for a release
 * @param result the validated disclosure result
 * @param sourceFileIds Box file ids whose download is in scope
 * @returns the complete HTML document
 */
export function evidenceCardHtml(
  result: DisclosureResult,
  sourceFileIds: readonly string[],
): string {
  const { scope, coverage } = result;

  return page(
    'Medissy selective evidence',
    html`<h1>Selective evidence</h1>
<p class="notice">${result.notice}</p>
<dl class="scope"><dt>Purpose</dt><dd>${scope.purpose}</dd>
<dt>Encounter</dt><dd>${scope.encounterId}</dd>
<dt>Categories</dt><dd>${scope.categories.join(', ') || 'none'}</dd>
<dt>Access until</dt><dd>${scope.expiresAt}</dd>
${coverage.lastSyncAt ? html`<dt>Last sync</dt><dd>${coverage.lastSyncAt}</dd>` : ''}</dl>
<ol class="evidence">${result.evidence.map(evidenceItem)}</ol>
${conflictsSection(result)}
<ul class="limits">${coverage.limitations.map((line) => html`<li>${line}</li>`)}</ul>
${
  sourceFileIds.length > 0
    ? html`<p class="meta">Source files available to this task: ${sourceFileIds.join(', ')}</p>`
    : ''
}
<footer>Receipt ${result.receiptId} · request ${result.requestId}</footer>`,
  );
}

/**
 * builds the share card: the invitation QR code and its expiry
 * @param share the invitation URL's QR SVG and expiry
 * @param share.svg QR markup from `renderQrSvg`
 * @param share.expiresAt when the invitation stops working
 * @returns the complete HTML document
 */
export function shareCardHtml(share: {
  svg: string;
  expiresAt: string;
}): string {
  return page(
    'Medissy share code',
    html`<h1>Share code</h1>
<p class="notice">Scan to connect to this Medissy. The code is a locator, not a credential; the patient confirms every connection.</p>
<div class="qr">${qrMarkup(share.svg)}</div>
<p class="meta">Expires ${share.expiresAt}</p>`,
  );
}
