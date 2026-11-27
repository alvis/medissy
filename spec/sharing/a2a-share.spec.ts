import { describe, expect, it } from 'vitest';

import { createTaskEngine, EngineError } from '../../src/a2a/engine';
import { createTaskStore } from '../../src/a2a/task-store';
import { createInvitation } from '../../src/sharing';
import { isOwner, readVaultOwner } from '../../src/sharing/store';
import { fakeDeviceFlow, LINKS } from '../a2a/support';
import {
  CARDIOLOGIST,
  PATIENT,
  principalFor,
  seedVault,
} from '../policy/support';

import { OWNER_REF, sharingHarness } from './support';

import type { EngineDeps } from '../../src/a2a/engine';

/**
 * builds an engine with share codes over a seeded vault: the owner sign-in is a
 * separate fake from the clinician one
 * @param options what to leave out
 * @param options.shares false to configure no share port
 * @returns the engine, both fake sign-ins, the store and the vault
 */
function rig(options: { shares?: boolean } = {}) {
  const db = seedVault();
  const s = sharingHarness(db);
  const flow = fakeDeviceFlow(s.deps.clock);
  const ownerFlow = fakeDeviceFlow(s.deps.clock);
  const store = createTaskStore(db);
  const shares: EngineDeps['shares'] = {
    isOwner: (person) => isOwner(readVaultOwner(db), person),
    create: ({ owner }) => {
      const created = createInvitation(s.deps, { owner });

      return created.ok ? created.share : undefined;
    },
  };
  const engine = createTaskEngine({
    store,
    deviceFlow: flow,
    ownerDeviceFlow: ownerFlow,
    ...(options.shares === false ? {} : { shares }),
    disclosure: {
      disclose: async () => {
        throw new Error('a share code never discloses');
      },
      redisclose: async () => {
        throw new Error('a share code never re-discloses');
      },
    },
    sourceFiles: () => [],
    readPatientId: () => PATIENT,
    clock: s.deps.clock,
    logger: { info: () => undefined, warn: () => undefined },
    links: LINKS,
    pollThrottleMs: 0,
  });

  return { engine, flow, ownerFlow, store, db };
}

/**
 * counts the invitations in the vault
 * @param db the vault
 * @returns the count
 */
function invitations(db: ReturnType<typeof seedVault>): number {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM invitations').get()?.n);
}

describe('fn:createTaskEngine (share code)', () => {
  it('should sign the patient in through the owner-scoped flow, not the clinician one', async () => {
    const r = rig();

    await r.engine.share({ messageId: 'msg-share-1' });

    expect(r.ownerFlow.started).toHaveLength(1);
    expect(r.flow.started).toHaveLength(0);
  });

  it('should refuse a verified non-owner holding an owner token: REJECTED, never bound, no invitation', async () => {
    const r = rig();
    const task = await r.engine.share({ messageId: 'msg-share-2' });

    r.ownerFlow.answer(task.id, {
      status: 'verified',
      principal: principalFor(CARDIOLOGIST, { scopes: ['medissy:owner'] }),
      clinician: null,
    });

    const done = await r.engine.get(task.id);

    expect(done.status.state).toBe('TASK_STATE_REJECTED');
    expect(done.artifacts).toEqual([]);
    expect(r.store.find(task.id)?.caller).toBeNull();
    expect(invitations(r.db)).toBe(0);
  });

  it('should refuse a sign-in whose token lacks medissy:owner as REJECTED, not FAILED', async () => {
    const r = rig();
    const task = await r.engine.share({ messageId: 'msg-share-3' });

    r.ownerFlow.answer(task.id, { status: 'failed', reason: 'missing-scope' });

    const done = await r.engine.get(task.id);

    expect(done.status.state).toBe('TASK_STATE_REJECTED');
    expect(invitations(r.db)).toBe(0);
  });

  it('should bind the owner of record and return the invitation once, storing no token', async () => {
    const r = rig();
    const task = await r.engine.share({ messageId: 'msg-share-4' });

    r.ownerFlow.answer(task.id, {
      status: 'verified',
      principal: principalFor(OWNER_REF.subject, {
        issuer: OWNER_REF.issuer,
        scopes: ['medissy:owner'],
      }),
      clinician: null,
    });

    const done = await r.engine.get(task.id);
    const url = String(
      (done.artifacts[0]?.parts[1]?.data as { url: string }).url,
    );
    const again = await r.engine.get(task.id);

    expect(done.status.state).toBe('TASK_STATE_COMPLETED');
    expect(r.store.find(task.id)?.caller).toEqual(OWNER_REF);
    expect(invitations(r.db)).toBe(1);
    expect(again.status.state).toBe('TASK_STATE_COMPLETED');
    expect(again.artifacts).toEqual([]);
    expect(
      JSON.stringify(r.db.prepare('SELECT * FROM a2a_tasks').all()),
    ).not.toContain(url.split('#')[1]);
  });

  it('should be unavailable without a share port', async () => {
    const r = rig({ shares: false });

    await expect(
      r.engine.share({ messageId: 'msg-share-5' }),
    ).rejects.toBeInstanceOf(EngineError);
  });
});
