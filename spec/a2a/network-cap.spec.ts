import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_PENDING_PER_NETWORK,
  networkOf,
} from '../../src/a2a/engine';
import { clientKey } from '../../src/identity/rate-limit';
import { ENC_CARDIO } from '../policy/support';

import { engineRig } from './support';

import type { TaskJson } from '../../src/a2a/view';

import type { EngineRig } from './support';

/**
 * creates a cardiology task from a client
 * @param rig the engine rig the task is created on
 * @param messageId the creating message id
 * @param ip the calling client's IP
 * @returns the task view
 */
async function create(
  rig: EngineRig,
  messageId: string,
  ip: string,
): Promise<TaskJson> {
  return rig.engine.create({
    messageId,
    client: clientKey(ip),
    request: {
      requestId: 'caller-chosen',
      encounterId: ENC_CARDIO,
      purpose: 'direct-treatment',
      question: 'Summarise the rhythm history (SYNTHETIC).',
    },
  });
}

describe('fn:networkOf', () => {
  it('should group IPv6 /64 client keys by /48 and keep IPv4 clients apart', () => {
    expect(networkOf(clientKey('2001:db8:1:2::9'))).toBe('2001:db8:1::/48');
    expect(networkOf(clientKey('2001:db8:1:ff::1'))).toBe('2001:db8:1::/48');
    expect(networkOf(clientKey('2001:db8:2:2::9'))).toBe('2001:db8:2::/48');
    expect(networkOf('192.0.2.1')).toBe('192.0.2.1');
  });
});

describe('fn:createTaskEngine (per-/48 sign-in cap)', () => {
  it('should cap unbound sign-ins per IPv6 /48 across its /64s, leaving other networks unaffected', async () => {
    const rig = engineRig();
    const perClient = 5;
    const subnets = DEFAULT_MAX_PENDING_PER_NETWORK / perClient;

    // fill the /48 from several /64s, each under its own per-client cap
    for (let subnet = 0; subnet < subnets; subnet += 1) {
      for (let n = 0; n < perClient; n += 1) {
        await create(
          rig,
          `msg-${subnet}-${n}`,
          `2001:db8:1:${subnet}::${n + 1}`,
        );
      }
    }

    // a fresh /64 in the same /48 is refused
    await expect(
      create(rig, 'msg-new-64', '2001:db8:1:ff::1'),
    ).rejects.toMatchObject({
      code: 'busy',
    });
    expect(rig.flow.start).toHaveBeenCalledTimes(
      DEFAULT_MAX_PENDING_PER_NETWORK,
    );

    // another /48 is unaffected
    await create(rig, 'msg-other-48', '2001:db8:2:0::1');

    // and the /48 frees once its sign-ins lapse
    rig.setNow('2026-11-25T10:10:01.000Z');
    await create(rig, 'msg-after', '2001:db8:1:ff::1');
  });
});
