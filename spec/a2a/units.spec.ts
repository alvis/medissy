import { describe, expect, it } from 'vitest';

import { submitOpen } from '../../src/a2a/engine-open';
import { parseIntent, SKILL_CLINICAL } from '../../src/a2a/intent';
import {
  createTaskStore,
  MessageIdCollisionError,
} from '../../src/a2a/task-store';
import {
  decisionStatus,
  expiredState,
  nextStep,
  recheckOutcome,
  signInOutcome,
} from '../../src/a2a/transitions';
import { newTaskId } from '../../src/contracts';
import { PATIENT_ID, vaultWithPatient } from '../identity/support';

import type { OpenInput } from '../../src/a2a/engine-open';
import type { NewTask, TaskRow } from '../../src/a2a/task-store';
import type { DisclosureDenial } from '../../src/contracts';

const T0 = new Date('2026-11-25T10:00:00.000Z');
const LATER = '2026-11-25T11:00:00.000Z';
const WORKING = {
  state: 'TASK_STATE_WORKING' as const,
  parts: [],
  timestamp: T0.toISOString(),
};

/**
 * builds a new unbound task
 * @param messageId its origin message id
 * @returns the insert
 */
function newTask(messageId = 'msg-1'): NewTask {
  return {
    id: newTaskId(),
    contextId: 'ctx-1',
    patientId: PATIENT_ID,
    originMessageId: messageId,
    status: {
      state: 'TASK_STATE_AUTH_REQUIRED',
      parts: [],
      timestamp: T0.toISOString(),
    },
    metadata: { requestId: 'req-1' },
    createdAt: T0.toISOString(),
    expiresAt: LATER,
  };
}

/**
 * builds a task row in a given state
 * @param state the effective state
 * @param bound whether a caller is bound
 * @returns a task row with fixed test fields for that state
 */
function row(state: TaskRow['state'], bound: boolean): TaskRow {
  return {
    ...newTask(),
    caller: bound ? { issuer: 'https://idp.test', subject: 'clin-1' } : null,
    encounterId: null,
    receiptId: null,
    state,
    status: { state, timestamp: T0.toISOString() },
    updatedAt: T0.toISOString(),
  };
}

const DENIAL: DisclosureDenial = {
  requestId: 'req-1',
  kind: 'denied',
  code: 'not-permitted',
  message: 'Not permitted.',
};

describe('fn:createTaskStore', () => {
  it('inserts, binds once and refuses any messageId reuse', () => {
    const store = createTaskStore(vaultWithPatient());
    const task = store.create(newTask());

    expect(() => store.create(newTask())).toThrow(MessageIdCollisionError);
    expect(
      store.bind(
        task.id,
        { issuer: 'https://idp.test', subject: 'a' },
        { status: WORKING, at: T0 },
      ),
    ).toBe(true);
    expect(
      store.bind(
        task.id,
        { issuer: 'https://idp.test', subject: 'b' },
        { status: WORKING, at: T0 },
      ),
    ).toBe(false);
    expect(store.find(task.id)).toMatchObject({
      caller: { subject: 'a' },
      state: 'TASK_STATE_WORKING',
      status: WORKING,
    });
    expect(() => store.create(newTask())).toThrow(MessageIdCollisionError);
  });

  it('never binds an unbound task whose sign-in already ended', () => {
    const store = createTaskStore(vaultWithPatient());
    const task = store.create(newTask());
    const rejected = {
      state: 'TASK_STATE_REJECTED' as const,
      timestamp: T0.toISOString(),
    };

    expect(store.update(task.id, { status: rejected }, T0).state).toBe(
      'TASK_STATE_REJECTED',
    );
    expect(
      store.bind(
        task.id,
        { issuer: 'https://idp.test', subject: 'a' },
        { status: WORKING, at: T0 },
      ),
    ).toBe(false);
    expect(store.find(task.id)?.caller).toBeNull();
  });

  it('only ever shrinks the expiry', () => {
    const store = createTaskStore(vaultWithPatient());
    const task = store.create(newTask());

    expect(
      store.update(task.id, { expiresAt: '2026-11-26T00:00:00.000Z' }, T0)
        .expiresAt,
    ).toBe(LATER);
    expect(
      store.update(task.id, { expiresAt: '2026-11-25T10:30:00.000Z' }, T0)
        .expiresAt,
    ).toBe('2026-11-25T10:30:00.000Z');
  });

  it('clamps an expiry at or before creation to just after it instead of ignoring it', () => {
    const store = createTaskStore(vaultWithPatient());
    const task = store.create(newTask());

    expect(
      store.update(task.id, { expiresAt: '2026-11-25T09:00:00.000Z' }, T0)
        .expiresAt,
    ).toBe('2026-11-25T10:00:00.001Z');
  });

  it('purges unbound tasks past their expiry with their sign-ins and IdP device codes, keeping the rest', () => {
    const db = vaultWithPatient();
    const store = createTaskStore(db);
    const abandoned = store.create(newTask('msg-old'));
    const waiting = store.create({
      ...newTask('msg-new'),
      expiresAt: '2026-11-25T13:00:00.000Z',
    });
    const bound = store.create(newTask('msg-bound'));

    store.bind(
      bound.id,
      { issuer: 'https://idp.test', subject: 'a' },
      { status: WORKING, at: T0 },
    );
    db.prepare(
      `INSERT INTO pending_signins (id, task_id, device_code, status, interval_seconds, next_poll_at, expires_at, created_at, updated_at)
       VALUES (?, ?, 'dc-old', 'pending', 5, ?, ?, ?, ?)`,
    ).run(
      newTaskId(),
      abandoned.id,
      T0.toISOString(),
      LATER,
      T0.toISOString(),
      T0.toISOString(),
    );
    db.prepare(
      `INSERT INTO idp_store (model, id, payload, expires_at) VALUES ('DeviceCode', 'dc-old', '{}', ?), ('DeviceCode', 'dc-other', '{}', ?)`,
    ).run(LATER, LATER);

    expect(store.purgeAbandoned(new Date('2026-11-25T12:00:00.000Z'))).toBe(1);
    expect(store.find(abandoned.id)).toBeUndefined();
    expect(store.find(waiting.id)).toBeDefined();
    expect(store.find(bound.id)).toBeDefined();
    expect(db.prepare('SELECT id FROM idp_store').all()).toEqual([
      { id: 'dc-other' },
    ]);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM pending_signins').get(),
    ).toEqual({ n: 0 });
  });

  it('counts each purged unbound task for the patient by day and skill, keeping nothing about the caller', () => {
    const db = vaultWithPatient();
    const store = createTaskStore(db);

    store.create(newTask('msg-a'));
    store.create(newTask('msg-b'));
    store.create({
      ...newTask('msg-c'),
      metadata: { requestId: 'req-c', skill: 'submit-record' },
    });
    store.bind(
      store.create(newTask('msg-bound')).id,
      { issuer: 'https://idp.test', subject: 'a' },
      { status: WORKING, at: T0 },
    );

    expect(store.purgeAbandoned(new Date('2026-11-25T12:00:00.000Z'))).toBe(3);

    store.create({
      ...newTask('msg-d'),
      createdAt: '2026-11-25T23:00:00.000Z',
      expiresAt: '2026-11-25T23:30:00.000Z',
    });

    expect(store.purgeAbandoned(new Date('2026-11-26T00:00:00.000Z'))).toBe(1);
    expect(
      db.prepare('SELECT * FROM unsigned_requests ORDER BY day, skill').all(),
    ).toEqual([
      {
        patient_id: PATIENT_ID,
        day: '2026-11-25',
        skill: 'clinical-evidence-request',
        stopped: 3,
      },
      {
        patient_id: PATIENT_ID,
        day: '2026-11-25',
        skill: 'submit-record',
        stopped: 1,
      },
    ]);
  });
});

describe('fn:nextStep', () => {
  it.each([
    ['TASK_STATE_AUTH_REQUIRED', false, 'await-sign-in'],
    ['TASK_STATE_WORKING', true, 'resume'],
    ['TASK_STATE_COMPLETED', true, 'recheck'],
    ['TASK_STATE_REJECTED', false, 'final'],
    ['TASK_STATE_FAILED', true, 'final'],
  ] as const)('maps %s (bound %s) to %s', (state, bound, kind) => {
    expect(nextStep(row(state, bound), T0).kind).toBe(kind);
  });

  it('expires every task at expires_at', () => {
    expect(
      nextStep(row('TASK_STATE_COMPLETED', true), new Date(LATER)).kind,
    ).toBe('expired');
    expect(expiredState('TASK_STATE_AUTH_REQUIRED')).toBe('TASK_STATE_FAILED');
    expect(expiredState('TASK_STATE_COMPLETED')).toBe('TASK_STATE_COMPLETED');
  });
});

describe('fn:signInOutcome / decisionStatus / recheckOutcome', () => {
  it('maps sign-in, decision and re-check outcomes', () => {
    expect(signInOutcome({ status: 'pending' }, T0)).toBeUndefined();
    expect(signInOutcome({ status: 'denied' }, T0)?.state).toBe(
      'TASK_STATE_REJECTED',
    );
    expect(
      signInOutcome({ status: 'failed', reason: 'idp-error' }, T0)?.state,
    ).toBe('TASK_STATE_FAILED');
    expect(decisionStatus({ kind: 'denied', denial: DENIAL }, T0).state).toBe(
      'TASK_STATE_REJECTED',
    );
    expect(
      decisionStatus(
        {
          kind: 'denied',
          denial: { ...DENIAL, code: 'temporarily-unavailable' },
        },
        T0,
      ).state,
    ).toBe('TASK_STATE_FAILED');
    expect(recheckOutcome({ kind: 'denied', denial: DENIAL }).kind).toBe(
      'ended',
    );
    expect(
      recheckOutcome({
        kind: 'denied',
        denial: { ...DENIAL, code: 'temporarily-unavailable' },
      }).kind,
    ).toBe('unavailable');
  });
});

describe('fn:parseIntent', () => {
  it('reads a data part, JSON-in-text, and refuses malformed input with fixed codes', () => {
    const data = {
      skill: SKILL_CLINICAL,
      encounterId: 'enc-1',
      question: 'Allergies?',
    };

    expect(parseIntent({ messageId: 'm1', parts: [{ data }] })).toMatchObject({
      kind: 'clinical',
      request: {
        encounterId: 'enc-1',
        question: 'Allergies?',
        purpose: 'direct-treatment',
      },
    });
    expect(
      parseIntent({ messageId: 'm1', parts: [{ text: JSON.stringify(data) }] })
        .kind,
    ).toBe('clinical');
    expect(
      parseIntent({
        messageId: 'm1',
        parts: [{ data: { skill: 'share-code' } }],
      }).kind,
    ).toBe('share-code');
    expect(
      parseIntent({ messageId: 'm1', parts: [{ text: 'hello' }] }),
    ).toEqual({
      kind: 'invalid',
      reason: 'missing-fields',
    });
    expect(
      parseIntent({
        messageId: 'm1',
        parts: [{ data: { ...data, role: 'admin' } }],
      }),
    ).toEqual({
      kind: 'invalid',
      reason: 'invalid-fields',
    });
    expect(parseIntent({ messageId: '', parts: [{ data }] }).kind).toBe(
      'invalid',
    );
  });
});

describe('fn:submitOpen', () => {
  const opened: OpenInput = { messageId: 'msg-1', contextId: 'ctx-1' };

  it('should preview the kind and the caller-sent title of a record on the sign-in page', () => {
    const request = submitOpen(
      {
        skill: 'submit-record',
        record: {
          resourceType: 'Observation',
          status: 'final',
          code: { text: 'SYNTHETIC resting heart rate‮' },
        },
      },
      opened,
    );

    expect(request.signIn.question).toContain(
      'File one Observation "SYNTHETIC resting heart rate" into the patient\'s records under your name',
    );
  });

  it('should preview a document by its title and say when a record has none', () => {
    const document = submitOpen(
      {
        skill: 'submit-record',
        document: { title: 'Cardiology follow-up note', text: 'SYNTHETIC' },
      },
      opened,
    );
    const untitled = submitOpen(
      {
        skill: 'submit-record',
        record: { resourceType: 'Condition' },
      },
      opened,
    );

    expect(document.signIn.question).toContain(
      'File one document "Cardiology follow-up note"',
    );
    expect(untitled.signIn.question).toContain(
      'File one Condition with no title',
    );
  });
});
