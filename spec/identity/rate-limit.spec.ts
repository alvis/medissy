import { describe, expect, it } from 'vitest';

import { clientKey, createRateLimiter } from '../../src/identity/rate-limit';

import { testClock } from './support';

const rule = { name: 'auth', prefix: '/auth/', limit: 2, windowSeconds: 60 };

describe('fn:createRateLimiter', () => {
  it('allows up to the limit per client, then answers with a retry delay until the window resets', () => {
    const clock = testClock();
    const limiter = createRateLimiter({ rules: [rule], now: clock.now });

    expect(limiter.hit(rule, '192.0.2.1').allowed).toBe(true);
    expect(limiter.hit(rule, '192.0.2.1').allowed).toBe(true);
    expect(limiter.hit(rule, '192.0.2.1')).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });
    expect(limiter.hit(rule, '192.0.2.2').allowed).toBe(true);

    clock.advance(60);
    expect(limiter.hit(rule, '192.0.2.1').allowed).toBe(true);
  });

  it('matches covered paths, including percent-encoded ones, and ignores the rest', () => {
    const limiter = createRateLimiter();

    expect(limiter.ruleFor('/demo-idp/device?user_code=X')?.name).toBe(
      'device',
    );
    expect(limiter.ruleFor('/demo-idp/device/auth')?.name).toBe('device');
    expect(limiter.ruleFor('/demo-idp/%74oken')?.name).toBe('token');
    expect(limiter.ruleFor('/auth/owner/sign-in')?.name).toBe('auth');
    expect(limiter.ruleFor('/demo-idp/jwks')).toBeUndefined();
    expect(limiter.ruleFor('/healthz')).toBeUndefined();
  });

  it('holds a bounded number of counters', () => {
    const limiter = createRateLimiter({ rules: [rule], maxKeys: 3 });

    for (let client = 0; client < 10; client += 1) {
      limiter.hit(rule, `192.0.2.${client}`);
    }

    expect(limiter.size).toBe(3);
  });
});

describe('fn:createRateLimiter rules', () => {
  it('limits passphrase POSTs on the account picker but not its GET', () => {
    const limiter = createRateLimiter();

    expect(limiter.ruleFor('/demo-idp/interaction/abc', 'POST')?.name).toBe(
      'passphrase',
    );
    expect(limiter.ruleFor('/demo-idp/interaction/abc', 'GET')).toBeUndefined();
    expect(limiter.ruleFor('/demo-idp/auth?x=1', 'GET')?.name).toBe(
      'authorize',
    );
  });

  it('limits A2A JSON-RPC POSTs per client IP so one client cannot start unbounded sign-ins', () => {
    const clock = testClock();
    const limiter = createRateLimiter({ now: clock.now });
    const a2a = limiter.ruleFor('/a2a/v1', 'POST')!;

    expect(a2a.name).toBe('a2a');
    expect(limiter.ruleFor('/a2a/v1', 'GET')).toBeUndefined();

    const verdicts = Array.from(
      { length: 121 },
      () => limiter.hit(a2a, '192.0.2.7').allowed,
    );

    expect(verdicts.filter(Boolean)).toHaveLength(120);
    expect(verdicts.at(-1)).toBe(false);
    expect(limiter.hit(a2a, '192.0.2.8').allowed).toBe(true);
  });
});

describe('fn:clientKey', () => {
  it('keys IPv4 (and IPv4-mapped IPv6) by address and IPv6 by its /64', () => {
    expect(clientKey('192.0.2.7')).toBe('192.0.2.7');
    expect(clientKey('::ffff:192.0.2.7')).toBe('192.0.2.7');
    expect(clientKey('2001:db8:0:1::7')).toBe('2001:db8:0:1::/64');
    expect(clientKey('2001:0db8:0000:0001:ffff:0:0:1')).toBe(
      '2001:db8:0:1::/64',
    );
    expect(clientKey('::1')).toBe('0:0:0:0::/64');
    expect(clientKey('2001:db8::')).toBe('2001:db8:0:0::/64');
  });

  it('puts every address of one /64 in one bucket so rotating addresses cannot dodge the cap', () => {
    const clock = testClock();
    const limiter = createRateLimiter({ now: clock.now });
    const a2a = limiter.ruleFor('/a2a/v1', 'POST')!;

    const verdicts = Array.from(
      { length: 121 },
      (_, i) =>
        limiter.hit(a2a, clientKey(`2001:db8:0:1::${(i + 1).toString(16)}`))
          .allowed,
    );

    expect(verdicts.filter(Boolean)).toHaveLength(120);
    expect(limiter.hit(a2a, clientKey('2001:db8:0:2::1')).allowed).toBe(true);
  });
});
