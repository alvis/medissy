/**
 * the D9 result parts; a release carries, in order:
 *
 * 1. a text part: a short human summary of the released evidence, the source
 *    files in scope and a portal link (no record body beyond the released
 *    evidence text, every value Markdown-inert);
 * 2. a data part: the validated `DisclosureResult`, including the FHIR R4
 *    collection Bundle;
 * 3. a `text/html` raw part: the escaped, self-contained evidence card
 *
 * a denial carries a text part and the `disclosureDenialSchema` data part
 * only; a share result carries a text part, a data part, the share card
 * (with the QR as inline SVG) and the QR as an `image/png` raw part for
 * chat clients that show images but not SVG or HTML; every part is
 * validated against its contract before it leaves this module
 */
import { z } from 'zod';

import {
  artifactPartSchema,
  DISCLOSURE_MEDIA_TYPE,
  disclosureDenialSchema,
  disclosureResultSchema,
  textPartSchema,
  htmlRawPartSchema,
} from '../contracts';

import { evidenceCardHtml, shareCardHtml, SYNTHETIC_LABEL } from './cards';
import { describeConflicts } from './conflicts';
import { renderQrPng, renderQrSvg } from './qr';
import { inertLine } from './text';

import type {
  ArtifactPart,
  DisclosureDenial,
  DisclosureResult,
  HtmlRawPart,
  TextPart,
} from '../contracts';

/** longest invitation URL a share part may carry */
const INVITATION_URL_MAX = 512;

/** media type of the share invitation data part */
export const SHARE_MEDIA_TYPE = 'application/vnd.medissy.share+json';

/** filename of the evidence card part */
export const EVIDENCE_CARD_FILENAME = 'medissy-evidence.html';

/** filename of the share card part */
export const SHARE_CARD_FILENAME = 'medissy-share.html';

/** filename of the share QR image part */
export const SHARE_QR_FILENAME = 'medissy-share-qr.png';

/** upper bound on the base64 length of the QR image part (~48 KB decoded) */
const MAX_QR_PNG_BASE64_LENGTH = 65_536;

/** where the summary points people and calling agents */
export interface PartLinks {
  /** the clinician portal (authenticated fallback); carries no data */
  portalUrl: string;
  /**
   * the download route template. `{taskId}` is left for the calling agent
   * to fill: the task id is a bearer capability (D10) and is never written
   * into a part; absent when no file reader is configured: then no download
   * is advertised
   */
  downloadTemplate?: string;
}

/** what a release is rendered from */
export interface EvidenceParts {
  result: DisclosureResult;
  /** Box file ids whose every record is in the released scope */
  sourceFileIds: readonly string[];
  links: PartLinks;
}

/** a share invitation as the share-code skill returns it */
export const shareInvitationSchema = z.strictObject({
  kind: z.literal('share-invitation'),
  url: z.url().max(INVITATION_URL_MAX),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type ShareInvitation = z.infer<typeof shareInvitationSchema>;

/** the data part that carries a share invitation */
export const shareDataPartSchema = z.strictObject({
  data: shareInvitationSchema,
  mediaType: z.literal(SHARE_MEDIA_TYPE),
});
export type ShareDataPart = z.infer<typeof shareDataPartSchema>;

/** the A2A 1.0 raw part that carries the share QR as a PNG */
export const shareQrPartSchema = z.strictObject({
  raw: z.base64().max(MAX_QR_PNG_BASE64_LENGTH),
  mediaType: z.literal('image/png'),
  filename: z.literal(SHARE_QR_FILENAME),
});
export type ShareQrPart = z.infer<typeof shareQrPartSchema>;

/**
 * encodes an HTML document as a raw part
 * @param document the complete document
 * @param filename the filename the part declares
 * @returns the validated raw part
 */
function htmlPart(document: string, filename: string): HtmlRawPart {
  return htmlRawPartSchema.parse({
    raw: Buffer.from(document, 'utf8').toString('base64'),
    mediaType: 'text/html',
    filename,
  });
}

/**
 * builds a validated text part
 * @param lines the lines, joined with newlines
 * @returns a part a client can show to a person
 */
function textPart(lines: readonly string[]): TextPart {
  return textPartSchema.parse({ text: lines.join('\n') });
}

/**
 * builds the human summary of a release
 * @param params the result, files in scope and links
 * @returns the summary lines
 */
function evidenceSummary(params: EvidenceParts): string[] {
  const { result, sourceFileIds, links } = params;
  const { scope } = result;
  const evidence = result.evidence.map((item) => {
    const value =
      item.factualValue === undefined
        ? ''
        : `: ${inertLine(item.factualValue)}`;
    const authored = item.authoredAt ? `, authored ${item.authoredAt}` : '';

    return `- ${inertLine(item.label)}${value} (${inertLine(item.source)}${authored})`;
  });

  return [
    `${SYNTHETIC_LABEL}: Medissy selective evidence`,
    inertLine(result.notice),
    `Encounter ${scope.encounterId}, purpose ${scope.purpose}, access until ${scope.expiresAt}.`,
    `Evidence (${result.evidence.length}):`,
    ...evidence,
    ...(result.conflicts.length > 0
      ? [
          `Conflicts flagged (${result.conflicts.length}):`,
          ...describeConflicts(result).map((line) => `- ${inertLine(line)}`),
        ]
      : []),
    'Limitations:',
    ...result.coverage.limitations.map((line) => `- ${inertLine(line)}`),
    `Receipt ${result.receiptId}.`,
    ...(sourceFileIds.length > 0 && links.downloadTemplate
      ? [
          `Source files in scope: ${sourceFileIds.join(', ')}. Download with GET ${links.downloadTemplate} using this task's id.`,
        ]
      : []),
    `Portal (sign-in required): ${links.portalUrl}`,
  ];
}

/**
 * renders a release as its three D9 parts
 * @param params the result, the files in scope and the links
 * @returns the text, data and HTML parts, each validated
 */
export function renderEvidenceParts(params: EvidenceParts): ArtifactPart[] {
  const result = disclosureResultSchema.parse(params.result);

  return [
    textPart(evidenceSummary({ ...params, result })),
    { data: result, mediaType: DISCLOSURE_MEDIA_TYPE },
    htmlPart(
      evidenceCardHtml(result, params.sourceFileIds),
      EVIDENCE_CARD_FILENAME,
    ),
  ].map((part) => artifactPartSchema.parse(part));
}

/**
 * renders a denial: text plus the denial data part only
 * @param denial the safe denial
 * @param links the portal link
 * @returns the text and data parts, each validated
 */
export function renderDenialParts(
  denial: DisclosureDenial,
  links: Pick<PartLinks, 'portalUrl'>,
): ArtifactPart[] {
  const valid = disclosureDenialSchema.parse(denial);

  return [
    textPart([
      `${SYNTHETIC_LABEL}: ${valid.message}`,
      ...(valid.nextStep ? [valid.nextStep] : []),
      `Portal (sign-in required): ${links.portalUrl}`,
    ]),
    { data: valid, mediaType: DISCLOSURE_MEDIA_TYPE },
  ].map((part) => artifactPartSchema.parse(part));
}

/** a share result part: text, share data, the share card or the QR image */
export type SharePart = TextPart | ShareDataPart | HtmlRawPart | ShareQrPart;

/**
 * renders a share invitation: a text summary, the invitation data, the share
 * card (QR as inline SVG) and the QR as a PNG image part
 * @param invitation the invitation URL and expiry
 * @returns the text, data, HTML and image parts, each validated
 */
export function renderShareParts(invitation: ShareInvitation): SharePart[] {
  const valid = shareInvitationSchema.parse(invitation);
  const svg = renderQrSvg(valid.url);

  return [
    textPart([
      `${SYNTHETIC_LABEL}: share code for this Medissy`,
      `Scan the QR code (attached as the image ${SHARE_QR_FILENAME}) or open ${valid.url} to request a connection; the patient confirms every connection. Expires ${valid.expiresAt}.`,
    ]),
    shareDataPartSchema.parse({ data: valid, mediaType: SHARE_MEDIA_TYPE }),
    htmlPart(
      shareCardHtml({ svg, expiresAt: valid.expiresAt }),
      SHARE_CARD_FILENAME,
    ),
    shareQrPartSchema.parse({
      raw: renderQrPng(valid.url).toString('base64'),
      mediaType: 'image/png',
      filename: SHARE_QR_FILENAME,
    }),
  ];
}
