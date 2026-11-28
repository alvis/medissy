import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { assertProxyTrust, conflictLinksFromEnv } from '../src/server';

describe('fn:conflictLinksFromEnv', () => {
  it('should load the curated anticoagulant conflict by default', () => {
    const expected = [
      { topic: 'anticoagulant', recordIds: ['rec-med-001', 'rec-med-002'] },
    ];

    const result = conflictLinksFromEnv({});

    expect(result).toEqual(expected);
  });

  it('should load the links from CONFLICTS_PATH when set', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'conflicts-')), 'm.json');
    writeFileSync(
      path,
      JSON.stringify({
        conflicts: [{ topic: 'statin', recordIds: ['a', 'b'], note: 'x' }],
      }),
    );
    const expected = [{ topic: 'statin', recordIds: ['a', 'b'] }];

    const result = conflictLinksFromEnv({ CONFLICTS_PATH: path });

    expect(result).toEqual(expected);
  });

  it('should refuse to boot when CONFLICTS_PATH is missing', () => {
    expect(() =>
      conflictLinksFromEnv({ CONFLICTS_PATH: '/nonexistent/conflicts.json' }),
    ).toThrow(/ENOENT/);
  });
});

describe('fn:assertProxyTrust', () => {
  it.each([
    {
      label: 'https without TRUST_PROXY',
      env: { MEDISSY_PUBLIC_URL: 'https://medissy.example' },
    },
    {
      label: 'https with TRUST_PROXY=0',
      env: { MEDISSY_PUBLIC_URL: 'https://medissy.example', TRUST_PROXY: '0' },
    },
    {
      label: 'https with TRUST_PROXY=true',
      env: {
        MEDISSY_PUBLIC_URL: 'https://medissy.example',
        TRUST_PROXY: 'true',
      },
    },
  ])('should refuse to boot with $label', ({ env }) => {
    expect(() => assertProxyTrust(env)).toThrow(
      /TRUST_PROXY=1 is required when MEDISSY_PUBLIC_URL is https/,
    );
  });

  it.each([
    {
      label: 'https behind the proxy',
      env: { MEDISSY_PUBLIC_URL: 'https://medissy.example', TRUST_PROXY: '1' },
    },
    {
      label: 'local http',
      env: { MEDISSY_PUBLIC_URL: 'http://localhost:3000', TRUST_PROXY: '0' },
    },
    { label: 'no public URL', env: {} },
  ])('should boot with $label', ({ env }) => {
    expect(() => assertProxyTrust(env)).not.toThrow();
  });
});
