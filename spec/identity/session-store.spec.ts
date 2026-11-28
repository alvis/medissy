import { describe, expect, it } from 'vitest';

import { SessionStore } from '../../src/identity/sessions';

import type { Principal } from '../../src/contracts';

const PRINCIPAL: Principal = {
  issuer: 'http://medissy.test/demo-idp',
  subject: 'synthetic-owner',
  audience: ['http://medissy.test'],
  scopes: ['medissy:owner'],
  roles: [],
};

/**
 * builds a store whose clock the test moves
 * @param max the session cap
 * @returns the store and a way to move time
 */
function storeWithClock(max?: number) {
  let at = Date.parse('2026-11-25T12:00:00.000Z');

  return {
    store: new SessionStore(() => new Date(at), max),
    advance: (seconds: number) => {
      at += seconds * 1000;
    },
  };
}

describe('cl:SessionStore', () => {
  it('ends a session at its TTL when that comes before the ceiling', () => {
    const { store, advance } = storeWithClock();
    const session = store.create({
      kind: 'owner',
      principal: PRINCIPAL,
      clinician: null,
      ttlSeconds: 60,
      notAfter: new Date('2026-11-25T13:00:00.000Z'),
    });

    advance(59);
    expect(store.find('owner', session.id)).toBe(session);

    advance(1);
    expect(store.find('owner', session.id)).toBeNull();
  });

  it('finds a session only under its own kind', () => {
    const { store } = storeWithClock();
    const session = store.create({
      kind: 'clinician',
      principal: PRINCIPAL,
      clinician: null,
      ttlSeconds: 60,
      notAfter: new Date('2026-11-25T13:00:00.000Z'),
    });

    expect(store.find('owner', session.id)).toBeNull();
    expect(store.find('clinician', session.id)).toBe(session);
  });

  it('mints unguessable ids and drops the oldest beyond the cap', () => {
    const { store } = storeWithClock(2);
    const input = {
      kind: 'owner' as const,
      principal: PRINCIPAL,
      clinician: null,
      ttlSeconds: 60,
      notAfter: new Date('2026-11-25T13:00:00.000Z'),
    };
    const first = store.create(input);
    const second = store.create(input);
    const third = store.create(input);

    expect(first.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.find('owner', first.id)).toBeNull();
    expect(store.find('owner', second.id)).toBe(second);
    expect(store.find('owner', third.id)).toBe(third);
  });
});
