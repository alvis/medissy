import { afterEach, describe, expect, it } from 'vitest';

import {
  formAction,
  hiddenFields,
  TEST_PASSPHRASES,
} from '../identity/support';

import { OWNER_COOKIE, ownerSession, portalHarness, signedIn } from './support';

import type { PortalHarness } from './support';

let harness: PortalHarness | undefined;

afterEach(async () => {
  await harness?.app.close();
  harness = undefined;
});

describe('owner step-up at the issuer (D3)', () => {
  it('should ask the issuer for a fresh login with prompt=login and max_age=0, and keep the verified auth_time', async () => {
    harness = await portalHarness();

    const owner = await signedIn(harness, 'owner', 'owner');
    const start = await owner.request('GET', '/auth/owner/sign-in');
    const authorize = new URL(String(start.headers.location));
    const session = ownerSession(harness, owner);

    expect(authorize.searchParams.get('prompt')).toBe('login');
    expect(authorize.searchParams.get('max_age')).toBe('0');
    expect(session?.authTime).toBeInstanceOf(Date);
    expect(
      Math.abs(
        harness.clock.now().getTime() - (session?.authTime?.getTime() ?? 0),
      ),
    ).toBeLessThan(5_000);
  });

  it('should not let an existing issuer session satisfy step-up without the passphrase', async () => {
    harness = await portalHarness();

    const owner = await signedIn(harness, 'owner', 'owner');
    const before = owner.cookies.get(OWNER_COOKIE);
    const login = await owner.follow(
      await owner.request('GET', '/auth/owner/sign-in'),
    );
    const wrong = await owner.follow(
      await owner.request('POST', formAction(login.body), {
        _csrf: hiddenFields(login.body)._csrf ?? '',
        passphrase: `not-${TEST_PASSPHRASES.owner ?? ''}`,
        account: 'owner',
      }),
    );

    expect(login.body).toContain('name="passphrase"');
    expect(wrong.body).toContain('name="passphrase"');
    expect(String(wrong.headers.location ?? '')).not.toContain(
      '/auth/callback',
    );
    expect(owner.cookies.get(OWNER_COOKIE)).toBe(before);
  });
});
