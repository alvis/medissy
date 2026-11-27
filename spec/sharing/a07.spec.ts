import { describe, expect, it } from 'vitest';

import {
  approveScopeRequest,
  confirmConnection,
  createInvitation,
  declineScopeRequest,
  redeemInvitation,
  requestExpansion,
  revokeGrant,
} from '../../src/sharing';
import {
  answer,
  evidenceIds,
  fakeModel,
  harness,
  poll,
  run,
} from '../disclosure/support';
import { ENC_CARDIO, manifest } from '../policy/support';

import {
  CARDIO_REF,
  OWNER_REF,
  at,
  choiceFor,
  sharingHarness,
  tokenOf,
} from './support';

import type { Harness } from '../disclosure/support';

import type { SharingHarness } from './support';

const MUSCULOSKELETAL = ['rec-cond-005', 'rec-dr-003'];
const DERMATOLOGY = ['rec-cond-006'];
const UNRELATED = manifest.groups.unrelated;

/** a model that selects every candidate it is shown */
const everything = fakeModel((request) =>
  answer(
    [
      ...(request.messages[0]?.content ?? '').matchAll(/"recordId":"([^"]+)"/g),
    ].map((match) => match[1] ?? ''),
  ),
);

/** the disclosure pipeline and the sharing service over one vault and clock */
interface Scenario {
  h: Harness;
  s: SharingHarness;
  scopeRequestId: string;
}

/**
 * sets up a confirmed cardiologist with a pending request for musculoskeletal and
 * dermatology records in the cardiology encounter
 * @returns the pipeline harness, the sharing harness and the request id
 */
function scenario(): Scenario {
  const h = harness(everything.client);
  const s = sharingHarness(h.db, h.deps.clock);
  const created = createInvitation(s.deps, { owner: OWNER_REF });

  if (!created.ok) {
    throw new Error('expected an invitation');
  }

  const redeemed = redeemInvitation(s.deps, {
    token: tokenOf(created.share.url),
    requester: CARDIO_REF,
    stated: {},
  });

  if (!redeemed.ok) {
    throw new Error('expected a connection');
  }

  confirmConnection(s.deps, {
    owner: OWNER_REF,
    connectionId: redeemed.connectionId,
    choice: choiceFor(),
  });

  const requested = requestExpansion(s.deps, {
    requester: CARDIO_REF,
    encounterId: ENC_CARDIO,
    categories: ['musculoskeletal', 'dermatology'],
    reason: 'SYNTHETIC: knee pain before the stress test',
    desiredExpiresAt: at(72),
    requestId: 'expand-1',
  });

  if (!requested.ok) {
    throw new Error('expected a scope request');
  }

  return { h, s, scopeRequestId: requested.id };
}

/**
 * approves musculoskeletal only, for two hours
 * @param sc the scenario
 * @returns the issued grant id
 */
function approveMusculoskeletal(sc: Scenario): string {
  const approved = approveScopeRequest(sc.s.deps, {
    owner: OWNER_REF,
    scopeRequestId: sc.scopeRequestId,
    approval: {
      categories: ['musculoskeletal'],
      maxSensitivity: 'routine',
      expiresAt: at(2),
    },
  });

  if (!approved.ok) {
    throw new Error('expected approval');
  }

  return approved.grantId;
}

describe('A07 patient approval and expanded scope', () => {
  it('should release no new evidence while a scope request is pending', async () => {
    const sc = scenario();

    const ids = evidenceIds(await run(sc.h, { requestId: 'while-pending' }));

    expect(ids.filter((id) => UNRELATED.includes(id))).toEqual([]);
  });

  it('should release only the approved categories, and only inside the approved window', async () => {
    const sc = scenario();

    approveMusculoskeletal(sc);

    const within = evidenceIds(
      await run(sc.h, { requestId: 'after-approval' }),
    );

    sc.h.setNow(at(3));

    const after = evidenceIds(await run(sc.h, { requestId: 'after-window' }));

    expect(within.filter((id) => UNRELATED.includes(id))).toEqual(
      MUSCULOSKELETAL,
    );
    expect(within).not.toEqual(expect.arrayContaining(DERMATOLOGY));
    expect(after.filter((id) => UNRELATED.includes(id))).toEqual([]);
    expect(poll(sc.h, 'after-approval')).toEqual({
      kind: 'denied',
      denial: expect.objectContaining({ code: 'not-permitted' }),
    });
  });

  it('should fail closed after the owner declines', async () => {
    const sc = scenario();

    declineScopeRequest(sc.s.deps, {
      owner: OWNER_REF,
      scopeRequestId: sc.scopeRequestId,
    });

    const ids = evidenceIds(await run(sc.h, { requestId: 'after-decline' }));

    expect(ids.filter((id) => UNRELATED.includes(id))).toEqual([]);
    expect(
      approveScopeRequest(sc.s.deps, {
        owner: OWNER_REF,
        scopeRequestId: sc.scopeRequestId,
        approval: {
          categories: ['musculoskeletal'],
          maxSensitivity: 'routine',
          expiresAt: at(2),
        },
      }),
    ).toEqual({ ok: false, code: 'not-pending' });
  });

  it('should fail closed once the pending request expires', async () => {
    const sc = scenario();

    sc.h.setNow(at(73));

    expect(
      approveScopeRequest(sc.s.deps, {
        owner: OWNER_REF,
        scopeRequestId: sc.scopeRequestId,
        approval: {
          categories: ['musculoskeletal'],
          maxSensitivity: 'routine',
          expiresAt: at(74),
        },
      }),
    ).toEqual({ ok: false, code: 'expired' });
  });

  it('should block the next poll of an in-flight request once its grant is revoked', async () => {
    const sc = scenario();
    const grantId = approveMusculoskeletal(sc);

    const released = evidenceIds(await run(sc.h, { requestId: 'in-flight' }));
    const before = poll(sc.h, 'in-flight');

    revokeGrant(sc.s.deps, { owner: OWNER_REF, grantId });

    expect(released).toEqual(expect.arrayContaining(MUSCULOSKELETAL));
    expect(before.kind).toBe('released');
    expect(poll(sc.h, 'in-flight')).toEqual({
      kind: 'denied',
      denial: expect.objectContaining({ code: 'not-permitted' }),
    });
  });
});
