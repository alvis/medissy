import { describe, expect, it } from 'vitest';

import { createLockout } from '../../src/demo-idp/lockout';
import { testClock } from '../identity/support';

describe('fn:createLockout', () => {
  it('locks after the fifth failure for the rest of the 15-minute window', () => {
    const clock = testClock();
    const lockout = createLockout({ now: clock.now });

    for (let failure = 0; failure < 4; failure += 1) {
      lockout.fail('owner');
    }

    expect(lockout.lockedFor('owner')).toBe(0);
    lockout.fail('owner');
    expect(lockout.lockedFor('owner')).toBe(900);
    expect(lockout.lockedFor('dentist')).toBe(0);

    clock.advance(899);
    expect(lockout.lockedFor('owner')).toBe(1);
    clock.advance(1);
    expect(lockout.lockedFor('owner')).toBe(0);
  });

  it('forgets failures after a success and holds a bounded number of counters', () => {
    const lockout = createLockout({ maxKeys: 2 });

    lockout.fail('owner');
    lockout.reset('owner');
    expect(lockout.size).toBe(0);

    for (const persona of ['a', 'b', 'c', 'd']) {
      lockout.fail(persona);
    }

    expect(lockout.size).toBe(2);
  });
});
