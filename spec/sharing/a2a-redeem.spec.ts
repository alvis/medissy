import { describe, expect, it } from 'vitest';

import { createTaskEngine } from '../../src/a2a/engine';
import { parseIntent } from '../../src/a2a/intent';
import { createTaskStore } from '../../src/a2a/task-store';
import {
  createInvitation,
  hashInvitationToken,
  redeemInvitationHash,
} from '../../src/sharing';
import { fakeDeviceFlow, LINKS } from '../a2a/support';
import {
  CARDIOLOGIST,
  PATIENT,
  principalFor,
  seedVault,
} from '../policy/support';

import { CARDIO_REF, OWNER_REF, sharingHarness, tokenOf } from './support';

import type { TaskJson } from '../../src/a2a/view';

/**
 * builds an engine with invitation redemption over a seeded vault
 * @returns the engine, its fake sign-in, the store and the share link
 */
function rig(): {
  engine: ReturnType<typeof createTaskEngine>;
  flow: ReturnType<typeof fakeDeviceFlow>;
  store: ReturnType<typeof createTaskStore>;
  link: string;
  db: ReturnType<typeof seedVault>;
} {
  const db = seedVault();
  const s = sharingHarness(db);
  const flow = fakeDeviceFlow(s.deps.clock);
  const store = createTaskStore(db);
  const created = createInvitation(s.deps, { owner: OWNER_REF });

  if (!created.ok) {
    throw new Error('expected an invitation');
  }

  const engine = createTaskEngine({
    store,
    deviceFlow: flow,
    disclosure: {
      disclose: async () => {
        throw new Error('a redemption never discloses');
      },
      redisclose: async () => {
        throw new Error('a redemption never re-discloses');
      },
    },
    sourceFiles: () => [],
    readPatientId: () => PATIENT,
    clock: s.deps.clock,
    logger: { info: () => undefined, warn: () => undefined },
    links: LINKS,
    pollThrottleMs: 0,
    invitations: {
      redeem: ({ tokenHash, requester }) =>
        redeemInvitationHash(s.deps, { tokenHash, requester, stated: {} }),
    },
  });

  return { engine, flow, store, link: created.share.url, db };
}

/**
 * returns the status text of a task
 * @param task the task view
 * @returns the text parts joined
 */
function text(task: TaskJson): string {
  return task.status.message.parts
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('\n');
}

/**
 * computes the token hash a redeem message carries
 * @param code the share link or token
 * @returns the SHA-256 hash of the redeemed token
 */
function hashOf(code: string): string {
  const intent = parseIntent({
    messageId: 'msg-redeem',
    parts: [{ data: { skill: 'redeem-invitation', code } }],
  });

  if (intent.kind !== 'redeem-invitation') {
    throw new Error('expected a redemption');
  }

  return intent.tokenHash;
}

describe('A2A redeem-invitation', () => {
  it('should hash a share link or bare token at parse time and refuse a code without one', () => {
    const token = 'A'.repeat(43);

    expect(hashOf(`https://medissy.example.invalid/connect#${token}`)).toBe(
      hashInvitationToken(token),
    );
    expect(hashOf(token)).toBe(hashInvitationToken(token));
    expect(
      parseIntent({
        messageId: 'm',
        parts: [
          {
            data: {
              skill: 'redeem-invitation',
              code: 'https://x.invalid/connect',
            },
          },
        ],
      }),
    ).toEqual({ kind: 'invalid', reason: 'invalid-fields' });
  });

  it('should redeem only after the in-task sign-in binds the clinician, then answer pending patient confirmation with no data', async () => {
    const { engine, flow, store, link, db } = rig();
    const task = await engine.redeem({
      messageId: 'msg-redeem',
      tokenHash: hashOf(link),
    });
    const before = db.prepare('SELECT COUNT(*) AS n FROM connections').get();

    flow.answer(task.id, {
      status: 'verified',
      principal: principalFor(CARDIOLOGIST),
      clinician: null,
    });

    const done = await engine.get(task.id);
    const again = await engine.get(task.id);

    expect(task.status.state).toBe('TASK_STATE_AUTH_REQUIRED');
    expect(before).toEqual({ n: 0 });
    expect(done.status.state).toBe('TASK_STATE_COMPLETED');
    expect(text(done)).toContain('pending patient confirmation');
    expect(done.artifacts).toEqual([]);
    expect(again.status.state).toBe('TASK_STATE_COMPLETED');
    expect(
      db
        .prepare(
          'SELECT requester_issuer, requester_subject, status FROM connections',
        )
        .get(),
    ).toEqual({
      requester_issuer: CARDIO_REF.issuer,
      requester_subject: CARDIO_REF.subject,
      status: 'pending',
    });
    expect(JSON.stringify(store.find(task.id))).not.toContain(tokenOf(link));
    expect(store.find(task.id)?.metadata).toEqual({
      requestId: expect.any(String),
      skill: 'redeem-invitation',
    });
  });

  it('should reject a second redemption of the same link with a generic message', async () => {
    const { engine, flow, link } = rig();
    const tokenHash = hashOf(link);
    const first = await engine.redeem({ messageId: 'msg-1', tokenHash });
    const second = await engine.redeem({ messageId: 'msg-2', tokenHash });

    flow.answer(first.id, {
      status: 'verified',
      principal: principalFor(CARDIOLOGIST),
      clinician: null,
    });
    flow.answer(second.id, {
      status: 'verified',
      principal: principalFor('clin-dentist-1'),
      clinician: null,
    });

    await engine.get(first.id);

    const refused = await engine.get(second.id);

    expect(refused.status.state).toBe('TASK_STATE_REJECTED');
    expect(text(refused)).toContain('This invitation is not available');
  });
});
