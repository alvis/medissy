import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_POLL_THROTTLE_MS, EngineError } from '../../src/a2a/engine';
import { SIGNIN_MEDIA_TYPE } from '../../src/a2a/transitions';
import {
  disclosureDenialSchema,
  disclosureResultSchema,
  DISCLOSURE_MEDIA_TYPE,
  taskIdSchema,
} from '../../src/contracts';
import { taskDigest } from '../../src/contracts/signin';
import { rows } from '../disclosure/support';
import {
  CARDIOLOGIST,
  DENTIST,
  ENC_CARDIO,
  T_NOW,
  grantFor,
  insertGrant,
  principalFor,
} from '../policy/support';

import { engineRig } from './support';

import type { TaskJson } from '../../src/a2a/view';

import type { EngineRig } from './support';

const QUESTION = 'Summarise the rhythm history and anticoagulation.';

/**
 * creates a cardiology task
 * @param rig the engine rig the task is created on
 * @param messageId the creating message id
 * @param client the calling client's key (its IP)
 * @returns the task view
 */
async function create(
  rig: EngineRig,
  messageId = 'msg-1',
  client?: string,
): Promise<TaskJson> {
  return rig.engine.create({
    messageId,
    client,
    request: {
      requestId: 'caller-chosen',
      encounterId: ENC_CARDIO,
      purpose: 'direct-treatment',
      question: QUESTION,
    },
  });
}

/**
 * creates a task and signs the given clinician in
 * @param rig the engine rig the task is created on
 * @param subject the clinician who approves the sign-in
 * @returns the first poll after sign-in
 */
async function released(
  rig: EngineRig,
  subject = CARDIOLOGIST,
): Promise<TaskJson> {
  const task = await create(rig);

  rig.flow.answer(task.id, {
    status: 'verified',
    principal: principalFor(subject),
    clinician: null,
  });

  return rig.engine.get(task.id);
}

/**
 * returns the text of the status message
 * @param task the task view
 * @returns the joined text parts
 */
function statusText(task: TaskJson): string {
  return task.status.message.parts
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('\n');
}

describe('fn:createTaskEngine', () => {
  describe('create', () => {
    it('creates an unbound AUTH_REQUIRED task with sign-in text and data only', async () => {
      const rig = engineRig();
      const task = await create(rig);
      const [text, data] = task.status.message.parts;

      expect(taskIdSchema.safeParse(task.id).success).toBe(true);
      expect(task.status.state).toBe('TASK_STATE_AUTH_REQUIRED');
      expect(task.artifacts).toEqual([]);
      expect(text?.text).toContain('WDJB-MJHT');
      expect(data).toEqual({
        data: {
          verificationUri: 'http://medissy.test/demo-idp/device',
          userCode: 'WDJB-MJHT',
          expiresAt: expect.any(String),
          taskDigest: taskDigest(task.id),
        },
        mediaType: SIGNIN_MEDIA_TYPE,
      });
      // no device code, token or prefilled link anywhere in the task
      expect(JSON.stringify(task)).not.toMatch(
        /device_code|access_token|user_code=|\?code=/,
      );
      expect(rig.store.find(task.id)?.caller).toBeNull();
      expect(rig.flow.started[0]).toEqual({
        taskId: task.id,
        encounterLabel: `Encounter ${ENC_CARDIO}`,
        question: QUESTION,
      });
    });

    it('returns an error, never the task, on a messageId collision with an unbound task (A08)', async () => {
      const rig = engineRig();

      await create(rig, 'msg-dup');

      await expect(create(rig, 'msg-dup')).rejects.toMatchObject({
        code: 'collision',
      });
      expect(
        rig.h.db.prepare('SELECT count(*) AS n FROM a2a_tasks').get(),
      ).toEqual({ n: 1 });
    });

    it('removes the task and fails when sign-in cannot start', async () => {
      const rig = engineRig();

      rig.flow.start.mockRejectedValueOnce(new Error('issuer down'));

      await expect(create(rig)).rejects.toBeInstanceOf(EngineError);
      expect(
        rig.h.db.prepare('SELECT count(*) AS n FROM a2a_tasks').get(),
      ).toEqual({ n: 0 });
    });

    it('caps unbound sign-ins per client so one IP cannot exhaust the global device slots', async () => {
      const rig = engineRig();
      const first = await create(rig, 'msg-a0', '192.0.2.1');

      for (const n of [1, 2, 3, 4]) {
        await create(rig, `msg-a${n}`, '192.0.2.1');
      }

      await expect(create(rig, 'msg-a5', '192.0.2.1')).rejects.toMatchObject({
        code: 'busy',
      });
      expect(rig.flow.start).toHaveBeenCalledTimes(5);
      // another client is unaffected
      await create(rig, 'msg-b0', '192.0.2.2');
      // a sign-in that ends frees its slot
      rig.flow.answer(first.id, { status: 'denied' });
      await rig.engine.get(first.id);
      await create(rig, 'msg-a6', '192.0.2.1');
      await expect(create(rig, 'msg-a7', '192.0.2.1')).rejects.toMatchObject({
        code: 'busy',
      });
      // and every slot frees once its sign-in lapses
      rig.setNow('2026-11-25T10:10:01.000Z');
      await create(rig, 'msg-a8', '192.0.2.1');
    });

    it('purges abandoned unbound tasks once they expire', async () => {
      const rig = engineRig();
      const abandoned = await create(rig, 'msg-old');

      rig.setNow('2026-11-25T11:00:01.000Z');
      await create(rig, 'msg-new');

      expect(rig.store.find(abandoned.id)).toBeUndefined();
      expect(rig.logs).toContainEqual({ event: 'a2a.task.purged', count: 1 });
    });

    it('mints its own request id per task instead of the caller-chosen one', async () => {
      const rig = engineRig();
      const task = await create(rig);

      expect(rig.store.find(task.id)?.metadata.requestId).toMatch(
        /^req-[0-9a-f-]{36}$/,
      );
    });
  });

  describe('get', () => {
    it('keeps AUTH_REQUIRED while the sign-in is pending', async () => {
      const rig = engineRig();
      const task = await create(rig);
      const polled = await rig.engine.get(task.id);

      expect(polled.status.state).toBe('TASK_STATE_AUTH_REQUIRED');
      expect(polled.artifacts).toEqual([]);
    });

    it('binds the verified clinician once and completes with D9 artifacts (A03 engine path)', async () => {
      const rig = engineRig();
      const task = await released(rig);
      const row = rig.store.find(task.id);
      const parts = task.artifacts[0]?.parts ?? [];

      expect(task.status.state).toBe('TASK_STATE_COMPLETED');
      expect(row?.caller).toEqual({
        issuer: principalFor(CARDIOLOGIST).issuer,
        subject: CARDIOLOGIST,
      });
      expect(row?.receiptId).toEqual(expect.any(String));
      expect(row?.encounterId).toBe(ENC_CARDIO);
      expect(parts).toHaveLength(3);
      expect(parts[1]?.mediaType).toBe(DISCLOSURE_MEDIA_TYPE);
      expect(disclosureResultSchema.safeParse(parts[1]?.data).success).toBe(
        true,
      );
      expect(parts[2]?.mediaType).toBe('text/html');
      // the binding is locked
      expect(() =>
        rig.h.db
          .prepare('UPDATE a2a_tasks SET caller_subject = ? WHERE id = ?')
          .run(DENTIST, task.id),
      ).toThrow(/locked/);
    });

    it('re-checks the grant on every poll (A08)', async () => {
      const rig = engineRig({
        port: (real) => ({ ...real, redisclose: vi.fn(real.redisclose) }),
      });
      const task = await released(rig);

      await rig.engine.get(task.id);
      await rig.engine.get(task.id);

      expect(rig.port.redisclose).toHaveBeenCalledTimes(2);
    });

    it('stays COMPLETED (A2A terminal states are immutable) with no artifacts and an access-ended message once the grant is revoked mid-task (A08)', async () => {
      const rig = engineRig();
      const task = await released(rig);

      expect(task.artifacts).toHaveLength(1);
      insertGrant(rig.h.db, grantFor({ version: 2, revokedAt: T_NOW }));

      const revoked = await rig.engine.get(task.id);
      const later = await rig.engine.get(task.id);

      expect(revoked.status.state).toBe('TASK_STATE_COMPLETED');
      expect(rig.store.find(task.id)?.state).toBe('TASK_STATE_COMPLETED');
      expect(revoked.artifacts).toEqual([]);
      expect(statusText(revoked)).toContain('Access ended');
      expect(
        disclosureDenialSchema.safeParse(revoked.status.message.parts[1]?.data)
          .success,
      ).toBe(true);
      expect(later.artifacts).toEqual([]);
      expect(statusText(later)).toContain('Access ended');
      expect(await rig.engine.released(task.id)).toBeUndefined();
    });

    it('serves no artifacts after the task expires (A08)', async () => {
      const rig = engineRig();
      const task = await released(rig);

      rig.setNow('2026-11-25T11:00:00.000Z');

      const expired = await rig.engine.get(task.id);

      expect(expired.status.state).toBe('TASK_STATE_COMPLETED');
      expect(expired.artifacts).toEqual([]);
      expect(statusText(expired)).toContain('Access ended');
      expect(await rig.engine.released(task.id)).toBeUndefined();
    });

    it('creates no second receipt for a duplicate messageId (A08)', async () => {
      const rig = engineRig();

      await released(rig);

      await expect(create(rig)).rejects.toMatchObject({ code: 'collision' });
      expect(rows(rig.h.db, 'receipts')).toHaveLength(1);
    });

    it('moves a declined sign-in to REJECTED and a lapsed one to FAILED, with a fresh-start hint', async () => {
      const rig = engineRig();
      const declined = await create(rig, 'msg-a');
      const lapsed = await create(rig, 'msg-b');

      rig.flow.answer(declined.id, { status: 'denied' });
      rig.flow.answer(lapsed.id, { status: 'expired' });

      const a = await rig.engine.get(declined.id);
      const b = await rig.engine.get(lapsed.id);

      expect(a.status.state).toBe('TASK_STATE_REJECTED');
      expect(b.status.state).toBe('TASK_STATE_FAILED');
      expect(statusText(a)).toContain('new request');
      expect(statusText(b)).toContain('new request');
      // final: no further sign-in polls
      await rig.engine.get(declined.id);
      expect(rig.flow.poll).toHaveBeenCalledTimes(2);
    });

    it('decides for the clinician who signs in, never for the requester named in text', async () => {
      const rig = engineRig();
      const task = await released(rig, DENTIST);

      expect(task.status.state).toBe('TASK_STATE_REJECTED');
      expect(task.artifacts).toEqual([]);
      expect(rig.store.find(task.id)?.caller?.subject).toBe(DENTIST);
    });

    it("D10 limit (A08 partial/FAIL): any holder of the task id can poll the bound clinician's release", async () => {
      // Polls carry no caller identity (D10): the task id is the only check.
      // A second clinician who learns the id sees the same artifacts. This
      // test records the accepted limit; it must change if D10 does.
      const rig = engineRig();
      const task = await released(rig);
      const byOther = await rig.engine.get(task.id);

      expect(byOther.artifacts).toHaveLength(1);
    });

    it('fails closed when the pipeline throws', async () => {
      const rig = engineRig({
        port: (real) => ({
          ...real,
          disclose: async (input) =>
            (await import('../../src/a2a/disclosure-port')).failClosed(
              input.request.requestId,
              async () => {
                throw new Error('boom with record text');
              },
            ),
        }),
      });
      const task = await released(rig);

      expect(task.status.state).toBe('TASK_STATE_FAILED');
      expect(task.artifacts).toEqual([]);
      expect(JSON.stringify(task)).not.toContain('boom');
    });

    it('shows a revoke on the very next poll with the production 5000 ms throttle (A08)', async () => {
      const rig = engineRig({ pollThrottleMs: DEFAULT_POLL_THROTTLE_MS });
      const task = await released(rig);
      const again = await rig.engine.get(task.id);

      expect(again.artifacts).toHaveLength(1);
      insertGrant(rig.h.db, grantFor({ version: 2, revokedAt: T_NOW }));

      const revoked = await rig.engine.get(task.id);

      expect(revoked.artifacts).toEqual([]);
      expect(statusText(revoked)).toContain('Access ended');
      expect(await rig.engine.released(task.id)).toBeUndefined();
    });

    it('throttles pending polls to a cached answer but re-checks every evidence poll at the 5000 ms default', async () => {
      const rig = engineRig({
        pollThrottleMs: DEFAULT_POLL_THROTTLE_MS,
        port: (real) => ({ ...real, redisclose: vi.fn(real.redisclose) }),
      });
      const pending = await create(rig, 'msg-pending');

      await rig.engine.get(pending.id);
      await rig.engine.get(pending.id);
      expect(rig.flow.poll).toHaveBeenCalledTimes(1);

      const task = await released(rig);

      await rig.engine.get(task.id);
      await rig.engine.get(task.id);
      expect(rig.port.redisclose).toHaveBeenCalledTimes(2);

      rig.setNow('2026-11-25T10:00:06.000Z');
      await rig.engine.get(pending.id);
      expect(rig.flow.poll).toHaveBeenCalledTimes(3);
    });

    it('ends a bound task interrupted before its decision as FAILED, releasing nothing', async () => {
      const rig = engineRig();
      const task = await create(rig);

      rig.store.bind(
        task.id,
        { issuer: principalFor(CARDIOLOGIST).issuer, subject: CARDIOLOGIST },
        {
          status: { state: 'TASK_STATE_WORKING', timestamp: T_NOW },
          at: new Date(T_NOW),
        },
      );

      const resumed = await rig.engine.get(task.id);

      expect(resumed.status.state).toBe('TASK_STATE_FAILED');
      expect(resumed.artifacts).toEqual([]);
      expect(statusText(resumed)).toContain('interrupted');
      expect(rows(rig.h.db, 'receipts')).toHaveLength(0);
    });

    it('answers not-found for unknown and malformed ids alike', async () => {
      const rig = engineRig();

      await expect(rig.engine.get('x')).rejects.toMatchObject({
        code: 'not-found',
      });
      await expect(rig.engine.get('A'.repeat(22))).rejects.toMatchObject({
        code: 'not-found',
      });
    });

    it('logs task digests and fixed codes only', async () => {
      const rig = engineRig();
      const task = await released(rig);

      insertGrant(rig.h.db, grantFor({ version: 2, revokedAt: T_NOW }));
      await rig.engine.get(task.id);

      const text = JSON.stringify(rig.logs);

      expect(rig.logs.length).toBeGreaterThan(2);
      expect(text).not.toContain(task.id);
      expect(text).not.toContain('WDJB-MJHT');
      expect(text).not.toContain(QUESTION);
      for (const entry of rig.logs) {
        if (entry.task) {
          expect(entry.task).toBe(taskDigest(task.id));
        }
      }
    });
  });
});
