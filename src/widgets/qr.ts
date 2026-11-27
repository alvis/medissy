/**
 * QR codes for share invitations, generated locally by `uqr` from a URL
 * Medissy minted; the SVG (for the HTML card) is checked against the exact
 * shape `uqr` emits (one white rect and one black path of move/line
 * commands), so no element, attribute or script can ride along into a part;
 * the PNG (for chat clients that show images but not SVG) is written here
 * byte by byte from the module matrix, so it carries pixels only
 */
import { crc32, deflateSync } from 'node:zlib';

import { encode, renderSVG } from 'uqr';

import { SafeHtml } from './html';

/** the longest URL a share QR may carry */
const MAX_QR_URL_LENGTH = 512;

/** quiet-zone width in modules, as the QR standard asks */
const PNG_QUIET_ZONE = 4;
/** pixels per module: readable on screen and by phone cameras */
const PNG_MODULE_PIXELS = 8;
/** PNG file signature */
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
/** IHDR: 8-bit greyscale, deflate, no filter method, no interlace */
const PNG_BIT_DEPTH = 8;
const PNG_IHDR_LENGTH = 13;
const PNG_IHDR_DEPTH_OFFSET = 8;
const PNG_IHDR_HEIGHT_OFFSET = 4;
/** greyscale sample values */
const PNG_WHITE = 0xff;
const PNG_BLACK = 0x00;
/** bytes in a PNG chunk length or CRC field */
const PNG_UINT32_BYTES = 4;

/** exactly what `uqr` 0.1.3 `renderSVG` produces with default options */
const QR_SVG_SHAPE =
  /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 \d+ \d+"><rect fill="white" width="\d+" height="\d+"\/><path fill="black" d="[MhvzZ0-9,.\s-]*"\/><\/svg>$/;

/** raised when a URL cannot be encoded or the SVG has an unexpected shape */
export class QrRenderError extends Error {
  /** @param message what failed, without the URL */
  constructor(message: string) {
    super(message);
    this.name = 'QrRenderError';
  }
}

/**
 * renders a share URL as an SVG QR code
 * @param url an absolute http(s) URL Medissy minted
 * @returns the SVG markup, validated against the `uqr` shape
 * @throws {QrRenderError} for a non-http(s) or oversized URL
 */
export function renderQrSvg(url: string): string {
  assertShareUrl(url);

  const svg = renderSVG(url);

  if (!QR_SVG_SHAPE.test(svg)) {
    throw new QrRenderError('the QR renderer produced an unexpected shape');
  }

  return svg;
}

/**
 * renders a share URL as a black-on-white greyscale PNG QR code
 * @param url an absolute http(s) URL Medissy minted
 * @returns the PNG file bytes
 * @throws {QrRenderError} for a non-http(s) or oversized URL
 */
export function renderQrPng(url: string): Buffer {
  assertShareUrl(url);

  const { data } = encode(url, { border: PNG_QUIET_ZONE });
  const side = data.length * PNG_MODULE_PIXELS;
  // one filter byte (0, none) then one greyscale byte per pixel, per row
  const rows = Buffer.alloc((side + 1) * side, PNG_WHITE);

  for (let y = 0; y < side; y++) {
    const row = data[Math.floor(y / PNG_MODULE_PIXELS)] ?? [];

    rows[y * (side + 1)] = 0;

    for (let x = 0; x < side; x++) {
      if (row[Math.floor(x / PNG_MODULE_PIXELS)]) {
        rows[y * (side + 1) + 1 + x] = PNG_BLACK;
      }
    }
  }

  const header = Buffer.alloc(PNG_IHDR_LENGTH);

  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, PNG_IHDR_HEIGHT_OFFSET);
  header[PNG_IHDR_DEPTH_OFFSET] = PNG_BIT_DEPTH;

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * refuses anything but a bounded absolute http(s) URL
 * @param url the invitation link a QR will encode
 * @throws {QrRenderError} for a non-http(s) or oversized URL
 */
function assertShareUrl(url: string): void {
  const parsed = URL.parse(url);

  if (!parsed) {
    throw new QrRenderError('the share URL is not a URL');
  }

  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    url.length > MAX_QR_URL_LENGTH
  ) {
    throw new QrRenderError(
      'the share URL is not an http(s) URL of bounded length',
    );
  }
}

/**
 * builds one PNG chunk: length, type, data and the CRC of type and data
 * @param type the four-letter chunk type
 * @param body the chunk data
 * @returns the encoded chunk
 */
function pngChunk(type: string, body: Buffer): Buffer {
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const length = Buffer.alloc(PNG_UINT32_BYTES);
  const checksum = Buffer.alloc(PNG_UINT32_BYTES);

  length.writeUInt32BE(body.length);
  checksum.writeUInt32BE(crc32(typed));

  return Buffer.concat([length, typed, checksum]);
}

/**
 * returns the QR SVG as markup the HTML template may embed
 * @param svg markup returned by `renderQrSvg`
 * @returns the markup, re-checked against the `uqr` shape
 * @throws {QrRenderError} when the markup is not a `uqr` QR code
 */
export function qrMarkup(svg: string): SafeHtml {
  if (!QR_SVG_SHAPE.test(svg)) {
    throw new QrRenderError('not a QR code produced by renderQrSvg');
  }

  return SafeHtml.fromTemplate(svg);
}
