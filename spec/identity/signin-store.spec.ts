import { describe, expect, it } from 'vitest';

import { pendingSignInSchema, taskDigest } from '../../src/contracts/signin';
import { createSignInStore } from '../../src/identity/signin-store';

import { insertTask, vaultWithPatient } from './support';

const at = new Date('2026-11-25T12:00:00.000Z');
const later = new Date('2026-11-25T12:10:00.000Z');

describe('migration 0007 pending_signins', () => {
  it('refuses INSERT OR REPLACE over an existing sign-in', () => {
    const db = vaultWithPatient();
    const taskId = insertTask(db);

    createSignInStore(db).replace({
      taskId,
      deviceCode: 'dc-1',
      intervalSeconds: 5,
      expiresAt: later,
      at,
    });
    const { id } = db.prepare('SELECT id FROM pending_signins').get() as {
      id: string;
    };

    expect(() =>
      db
        .prepare(
          `INSERT OR REPLACE INTO pending_signins (id, task_id, device_code, status, interval_seconds, next_poll_at, expires_at, created_at, updated_at)
           VALUES (?, ?, 'dc-2', 'pending', 5, ?, ?, ?, ?)`,
        )
        .run(
          id,
          taskId,
          at.toISOString(),
          later.toISOString(),
          at.toISOString(),
          at.toISOString(),
        ),
    ).toThrow(/already exists/);
  });

  it('keeps a finished sign-in final and its task and device code fixed', () => {
    const db = vaultWithPatient();
    const store = createSignInStore(db);
    const taskId = insertTask(db);

    store.replace({
      taskId,
      deviceCode: 'dc-1',
      intervalSeconds: 5,
      expiresAt: later,
      at,
    });
    const row = store.findPending(taskId);

    expect(() =>
      db.prepare("UPDATE pending_signins SET device_code = 'dc-9'").run(),
    ).toThrow(/fixed/);
    expect(store.finish(row?.id ?? '', 'verified', at)).toBe(true);
    expect(store.finish(row?.id ?? '', 'failed', at)).toBe(false);
    expect(() =>
      db.prepare("UPDATE pending_signins SET status = 'pending'").run(),
    ).toThrow(/cannot change/);
  });

  it('requires an existing task and lets only one caller claim each poll', () => {
    const db = vaultWithPatient();
    const store = createSignInStore(db);
    const taskId = insertTask(db);

    expect(() =>
      store.replace({
        taskId: 'B'.repeat(22),
        deviceCode: 'dc-x',
        intervalSeconds: 5,
        expiresAt: later,
        at,
      }),
    ).toThrow(/FOREIGN KEY/);

    store.replace({
      taskId,
      deviceCode: 'dc-1',
      intervalSeconds: 5,
      expiresAt: later,
      at,
    });
    const id = store.findPending(taskId)?.id ?? '';

    expect(store.claimPoll(id, 5, at)).toBe(true);
    expect(store.claimPoll(id, 5, at)).toBe(false);
    expect(store.claimPoll(id, 5, new Date(at.getTime() + 5000))).toBe(true);
  });
});

describe('contract signin', () => {
  it('digests a task id into a short display code that is not the id', () => {
    const digest = taskDigest('A'.repeat(22));

    expect(digest).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(taskDigest('A'.repeat(22))).toBe(digest);
    expect(taskDigest('C'.repeat(22))).not.toBe(digest);
  });

  it('describes a stored row without its device code', () => {
    expect(
      pendingSignInSchema.safeParse({
        id: 'A'.repeat(22),
        taskId: 'B'.repeat(22),
        status: 'pending',
        intervalSeconds: 5,
        nextPollAt: at.toISOString(),
        expiresAt: later.toISOString(),
        createdAt: at.toISOString(),
        updatedAt: at.toISOString(),
        deviceCode: 'dc-1',
      }).success,
    ).toBe(false);
  });
});
