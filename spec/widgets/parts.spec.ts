import { inflateSync } from 'node:zlib';

import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';

import {
  artifactPartSchema,
  DISCLOSURE_MEDIA_TYPE,
  disclosureDenialSchema,
  disclosureResultSchema,
  SELECTIVE_NOTICE,
} from '../../src/contracts';
import {
  escapeHtml,
  html,
  inertLine,
  renderDenialParts,
  renderEvidenceParts,
  renderQrPng,
  renderQrSvg,
  renderShareParts,
  SafeHtml,
  SHARE_MEDIA_TYPE,
  SHARE_QR_FILENAME,
  shareDataPartSchema,
  shareQrPartSchema,
} from '../../src/widgets';

import type { DisclosureDenial, DisclosureResult } from '../../src/contracts';

const LINKS = {
  portalUrl: 'http://medissy.test/',
  downloadTemplate: 'http://medissy.test/a2a/v1/tasks/{taskId}/files/{fileId}',
};

/** hostile strings a record or label could carry */
const XSS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg onload=alert(1)>',
  'javascript:alert(1)',
  '</style><style>body{background:url(https://evil.example/x)}</style>',
  '"><a href="javascript:alert(1)">x</a>',
];

/**
 * builds a release whose free-text fields carry a hostile string
 * @param hostile the string placed in every text field
 * @returns a contract-valid result
 */
function resultWith(hostile = 'Atorvastatin 20 mg daily'): DisclosureResult {
  return disclosureResultSchema.parse({
    requestId: 'req-1',
    receiptId: 'rcpt-1',
    kind: 'selective-evidence',
    scope: {
      purpose: 'direct-treatment',
      encounterId: 'enc-cardio-1',
      categories: ['cardiac'],
      expiresAt: '2026-12-10T00:00:00.000Z',
    },
    notice: SELECTIVE_NOTICE,
    evidence: [
      {
        recordId: 'rec-med-001',
        label: `Medication ${hostile}`,
        factualValue: hostile,
        source: `Northgate ${hostile}`,
        authoredAt: '2026-10-14T00:00:00.000Z',
        importedAt: '2026-11-20T00:00:00.000Z',
        verification: 'synthetic-provider',
      },
    ],
    conflicts: [],
    coverage: { limitations: [`Limit ${hostile}`] },
    bundle: {
      resourceType: 'Bundle',
      type: 'collection',
      entry: [
        {
          resource: { resourceType: 'MedicationStatement', id: 'rec-med-001' },
        },
      ],
    },
  });
}

/**
 * builds a release with two records flagged as conflicting, one also with an
 * unreviewed newer source copy
 * @param hostile the string placed in the second record's label
 * @returns a contract-valid result
 */
function conflicted(hostile = 'Medication list (GP)'): DisclosureResult {
  const base = resultWith();
  const second = {
    ...base.evidence[0]!,
    recordId: 'rec-med-002',
    label: hostile,
  };

  return disclosureResultSchema.parse({
    ...base,
    evidence: [...base.evidence, second],
    conflicts: [
      {
        kind: 'linked',
        topic: 'statin-dose',
        recordIds: ['rec-med-001', 'rec-med-002'],
      },
      { kind: 'open-source-conflict', recordId: 'rec-med-002' },
    ],
    bundle: {
      ...base.bundle,
      entry: [
        ...base.bundle.entry,
        {
          resource: { resourceType: 'MedicationStatement', id: 'rec-med-002' },
        },
      ],
    },
  });
}

/**
 * decodes the HTML raw part
 * @param part a raw part
 * @returns the document
 */
function decode(part: unknown): string {
  return Buffer.from((part as { raw: string }).raw, 'base64').toString('utf8');
}

describe('fn:html', () => {
  it('escapes every interpolation unless it is SafeHtml', () => {
    const inner = html`<i>${'x'}</i>`;
    const out = html`<p>${'<b>&"\'`='}</p>${inner}`.toString();

    expect(out).toBe(`<p>${escapeHtml('<b>&"\'`=')}</p><i>x</i>`);
    expect(out).not.toContain('<b>');
    expect(html`${SafeHtml.fromTemplate('<br>')}`.toString()).toBe('<br>');
  });
});

describe('fn:inertLine', () => {
  it('flattens control and bidi characters and escapes Markdown', () => {
    expect(inertLine('a\n‮b [x](javascript:y) `c`')).toBe(
      'a b \\[x\\]\\(javascript:y\\) \\`c\\`',
    );
  });
});

describe('fn:renderEvidenceParts (D9)', () => {
  it('returns text, disclosure data and an escaped HTML card, each contract-valid', () => {
    const parts = renderEvidenceParts({
      result: resultWith(),
      sourceFileIds: ['9100000004'],
      links: LINKS,
    });

    expect(parts).toHaveLength(3);
    for (const part of parts) {
      expect(artifactPartSchema.safeParse(part).success).toBe(true);
    }

    const [text, data, card] = parts as [
      { text: string },
      { data: unknown; mediaType: string },
      { raw: string; mediaType: string; filename: string },
    ];

    expect(text.text).toContain('SYNTHETIC DEMO');
    expect(text.text).toContain('Receipt rcpt-1');
    expect(text.text).toContain(
      'Portal (sign-in required): http://medissy.test/',
    );
    expect(text.text).toContain('9100000004');
    expect(text.text).toContain('{taskId}');
    expect(data.mediaType).toBe(DISCLOSURE_MEDIA_TYPE);
    expect(disclosureResultSchema.parse(data.data).bundle.type).toBe(
      'collection',
    );
    expect(card.mediaType).toBe('text/html');
    expect(card.filename).toBe('medissy-evidence.html');
    expect(decode(card)).toContain('SYNTHETIC DEMO');
    expect(decode(card)).toContain(SELECTIVE_NOTICE);
  });

  it.each(XSS)('renders %s inert in every part', (hostile) => {
    const parts = renderEvidenceParts({
      result: resultWith(hostile),
      sourceFileIds: [],
      links: LINKS,
    });
    const text = (parts[0] as { text: string }).text;
    const doc = decode(parts[2]);

    // HTML card: no script, no event handler, no link or remote reference,
    // and exactly the one static stylesheet
    expect(doc).not.toMatch(/<script/i);
    expect(doc).not.toMatch(/<(img|svg|a|iframe|object|embed|link)\b/i);
    expect(doc).not.toMatch(/\son[a-z]+\s*=/i);
    expect(doc).not.toMatch(/\b(href|src)\s*=/i);
    expect(doc.match(/<style>/g)).toHaveLength(1);
    expect(doc.match(/<\/style>/g)).toHaveLength(1);
    expect(doc).toMatch(/default-src (&#39;|')none/);
    // text part: every markup character is backslash-escaped
    expect(text).not.toMatch(/(^|[^\\])<[a-z/]/im);
    expect(text).not.toMatch(/\]\(/);
  });
});

describe('fn:renderEvidenceParts conflicts', () => {
  it('names each flagged conflict by its released records in the text and the card', () => {
    const parts = renderEvidenceParts({
      result: conflicted(),
      sourceFileIds: [],
      links: LINKS,
    });
    const text = (parts[0] as { text: string }).text;
    const doc = decode(parts[2]);

    expect(text).toContain('Conflicts flagged (2):');
    expect(text).toContain(
      'Sources disagree on statin-dose: Medication Atorvastatin 20 mg daily vs Medication list \\(GP\\)',
    );
    expect(text).toContain(
      'The source of Medication list \\(GP\\) has a newer copy not yet reviewed by the patient',
    );
    expect(doc).toContain('Conflicts flagged (2)');
    expect(doc).toContain(
      'Sources disagree on statin-dose: Medication Atorvastatin 20 mg daily vs Medication list (GP)',
    );
  });

  it.each(XSS)('renders a conflict naming %s inert', (hostile) => {
    const parts = renderEvidenceParts({
      result: conflicted(hostile),
      sourceFileIds: [],
      links: LINKS,
    });
    const text = (parts[0] as { text: string }).text;
    const doc = decode(parts[2]);

    expect(doc).not.toMatch(/<script/i);
    expect(doc).not.toMatch(/<(img|svg|a|iframe|object|embed|link)\b/i);
    expect(doc).not.toMatch(/\son[a-z]+\s*=/i);
    expect(doc.match(/<style>/g)).toHaveLength(1);
    expect(text).not.toMatch(/(^|[^\\])<[a-z/]/im);
  });

  it('advertises no download when no download template is configured', () => {
    const parts = renderEvidenceParts({
      result: resultWith(),
      sourceFileIds: ['1234'],
      links: { portalUrl: LINKS.portalUrl },
    });

    expect((parts[0] as { text: string }).text).not.toContain('Source files');
  });
});

describe('fn:renderDenialParts (D9)', () => {
  it('returns only text and the denial data part', () => {
    const denial: DisclosureDenial = disclosureDenialSchema.parse({
      requestId: 'req-1',
      kind: 'denied',
      code: 'not-permitted',
      message: 'Not permitted for this encounter.',
    });
    const parts = renderDenialParts(denial, LINKS);

    expect(parts).toHaveLength(2);
    expect(parts[1]).toEqual({
      data: denial,
      mediaType: DISCLOSURE_MEDIA_TYPE,
    });
    expect((parts[0] as { text: string }).text).toContain('Not permitted');
  });
});

/**
 * decodes the 8-bit greyscale, unfiltered PNG `renderQrPng` writes into the
 * RGBA pixels jsQR reads
 * @param png the PNG bytes
 * @returns the side length and RGBA pixels
 */
function pngPixels(png: Buffer): { side: number; rgba: Uint8ClampedArray } {
  const side = png.readUInt32BE(16);
  const idat: Buffer[] = [];

  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);

    if (png.toString('latin1', offset + 4, offset + 8) === 'IDAT') {
      idat.push(png.subarray(offset + 8, offset + 8 + length));
    }

    offset += length + 12;
  }

  const rows = inflateSync(Buffer.concat(idat));
  const rgba = new Uint8ClampedArray(side * side * 4);

  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const grey = rows[y * (side + 1) + 1 + x] ?? 0;

      rgba.set([grey, grey, grey, 255], (y * side + x) * 4);
    }
  }

  return { side, rgba };
}

describe('fn:renderShareParts (D9)', () => {
  it('should return text, share data, card and a PNG QR that decodes to the share URL', () => {
    const url = `http://medissy.test/connect#${'token-'.repeat(7)}`;
    const parts = renderShareParts({
      kind: 'share-invitation',
      url,
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
    const text = (parts[0] as { text: string }).text;
    const image = shareQrPartSchema.parse(parts[3]);
    const { side, rgba } = pngPixels(Buffer.from(image.raw, 'base64'));

    expect(parts).toHaveLength(4);
    expect(text).toContain(SHARE_QR_FILENAME);
    expect(text).not.toContain('<svg');
    expect(shareDataPartSchema.parse(parts[1]).mediaType).toBe(
      SHARE_MEDIA_TYPE,
    );
    expect(decode(parts[2])).toContain('<svg');
    expect(decode(parts[2])).not.toMatch(/<script|\son[a-z]+=/i);
    expect(image).toMatchObject({
      mediaType: 'image/png',
      filename: SHARE_QR_FILENAME,
    });
    expect(jsQR(rgba, side, side)?.data).toBe(url);
  });

  it('should refuse a non-http URL for the QR', () => {
    expect(() => renderQrSvg('javascript:alert(1)')).toThrow();
    expect(() => renderQrPng('javascript:alert(1)')).toThrow();
  });

  it('should refuse an oversized URL for the PNG QR', () => {
    expect(() =>
      renderQrPng(`http://medissy.test/connect#${'a'.repeat(600)}`),
    ).toThrow(/bounded length/);
  });

  it('should write a valid greyscale PNG header', () => {
    const png = renderQrPng('http://medissy.test/connect#abc');

    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(png.toString('latin1', 12, 16)).toBe('IHDR');
    expect(png[24]).toBe(8);
    expect(png[25]).toBe(0);
  });
});
