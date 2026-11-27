import { describe, expect, it } from 'vitest';

import {
  hashPassphrase,
  loadPassphrases,
  passphrasesFromEnv,
  secretEnvName,
} from '../../src/demo-idp/secrets';

describe('fn:loadPassphrases', () => {
  it('accepts plaintext hashed at boot and a pre-computed scrypt hash', async () => {
    const book = await loadPassphrases({
      owner: 'synthetic-owner-only',
      dentist: await hashPassphrase('synthetic-dentist-only'),
    });

    expect(await book.check('owner', 'synthetic-owner-only')).toBe(true);
    expect(await book.check('dentist', 'synthetic-dentist-only')).toBe(true);
    expect([...book.enabled].sort()).toEqual(['dentist', 'owner']);
  });

  it('keeps each persona separate and refuses wrong, empty and unknown input', async () => {
    const book = await loadPassphrases({
      'owner': 'synthetic-owner-only',
      'cardiologist': 'synthetic-cardio-only',
      'unknown-clinician': undefined,
    });

    expect(await book.check('owner', 'synthetic-cardio-only')).toBe(false);
    expect(await book.check('owner', '')).toBe(false);
    expect(await book.check('owner', 'x'.repeat(10_000))).toBe(false);
    expect(await book.check('unknown-clinician', '')).toBe(false);
    expect(await book.check('nobody', 'synthetic-owner-only')).toBe(false);
  });

  it('rejects a short plaintext passphrase and a malformed hash', async () => {
    await expect(loadPassphrases({ owner: 'short' })).rejects.toThrow(
      /at least 20/,
    );
    // 19 characters is one short of the floor that keeps IP-rotating guessing
    // infeasible (REV03 P3-3); 20 is accepted
    await expect(loadPassphrases({ owner: 'x'.repeat(19) })).rejects.toThrow(
      /at least 20/,
    );
    await expect(
      loadPassphrases({ owner: 'x'.repeat(20) }),
    ).resolves.toBeDefined();
    await expect(
      loadPassphrases({ owner: 'scrypt$AAAA$BBBB' }),
    ).rejects.toThrow(/malformed/);
  });

  it('never keeps the plaintext in the stored hash', async () => {
    const hash = await hashPassphrase('synthetic-owner-only');

    expect(hash).toMatch(/^scrypt\$[\w-]{22}\$[\w-]{43}$/);
    expect(hash).not.toContain('synthetic-owner-only');
  });
});

describe('fn:passphrasesFromEnv', () => {
  it('reads DEMO_IDP_SECRET_<PERSONA> and skips unset personas', () => {
    expect(secretEnvName('unknown-clinician')).toBe(
      'DEMO_IDP_SECRET_UNKNOWN_CLINICIAN',
    );
    expect(
      passphrasesFromEnv(
        { DEMO_IDP_SECRET_OWNER: 'a', DEMO_IDP_SECRET_DENTIST: '' },
        ['owner', 'dentist', 'cardiologist'],
      ),
    ).toEqual({ owner: 'a' });
  });
});
