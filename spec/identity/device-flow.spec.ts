import { afterEach, describe, expect, it } from 'vitest';

import {
  encounterAdmitsCaller,
  granteeMatches,
  grantSchema,
  isRecordReleasable,
} from '../../src/contracts';
import {
  DEMO_CARDIOLOGIST,
  DEMO_UNKNOWN_CLINICIAN,
} from '../../src/demo-idp/users';

import {
  createDeviceFlow,
  DeviceFlowError,
} from '../../src/identity/device-flow';

import {
  Browser,
  createHarness,
  insertTask,
  PUBLIC_URL,
  startSignIn,
  testClock,
  TEST_CONTEXT,
  vaultWithPatient,
} from './support';

import type { VerifyResult } from '../../src/identity/verifier';

import type { Harness } from './support';

const ISSUER = `${PUBLIC_URL}/institution-idp`;

describe('fn:createDeviceFlow', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.app.close();
    harness = undefined;
  });

  it('starts a sign-in that exposes no device code and no prefilled link', async () => {
    harness = await createHarness();

    const { taskId, started } = await startSignIn(harness);

    expect(Object.keys(started).sort()).toEqual([
      'expiresAt',
      'intervalSeconds',
      'taskDigest',
      'userCode',
      'verificationUri',
    ]);
    expect(started.verificationUri).toBe(`${ISSUER}/device`);
    expect(started.taskDigest).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(started.expiresAt.getTime()).toBeGreaterThan(Date.now());
    // the sign-in lives in pending_signins; the task's metadata stays empty
    expect(
      harness.db
        .prepare('SELECT status FROM pending_signins WHERE task_id = ?')
        .all(taskId),
    ).toEqual([{ status: 'pending' }]);
    expect(
      harness.db
        .prepare('SELECT metadata FROM a2a_tasks WHERE id = ?')
        .get(taskId),
    ).toEqual({ metadata: null });
  });

  it('reports pending until the clinician types and approves the code, then a verified principal (A02 happy path)', async () => {
    harness = await createHarness();
    const flow = harness.demo.deviceFlow;
    const { taskId, started } = await startSignIn(harness);

    expect(await flow.poll(taskId)).toEqual({ status: 'pending' });

    const done = await new Browser(harness.app).approveDevice(
      started.userCode,
      'cardiologist',
    );

    expect(done.statusCode).toBe(200);
    expect(done.body).toContain('Sign-in complete');
    expect(done.body).toContain('SYNTHETIC Northgate Health');

    harness.clock.advance(6);
    const result = await flow.poll(taskId);

    expect(result).toEqual({
      status: 'verified',
      principal: {
        issuer: ISSUER,
        subject: DEMO_CARDIOLOGIST.subject,
        audience: [PUBLIC_URL],
        scopes: ['medissy:request'],
        organizationId: 'org-northgate-health',
        roles: ['cardiologist'],
        clientId: 'medissy-agent',
      },
      clinician: expect.objectContaining({
        subject: DEMO_CARDIOLOGIST.subject,
        status: 'active',
      }),
    });
    // no token, device code or JWT-shaped value reaches the caller
    expect(JSON.stringify(result)).not.toMatch(/eyJ|device_code|access_token/);
    // the verified result is delivered once; the next poll asks for a new sign-in
    expect(await flow.poll(taskId)).toEqual({ status: 'expired' });
  });

  it('keeps a sign-in pending when someone approves without the persona passphrase', async () => {
    harness = await createHarness();
    const { taskId, started } = await startSignIn(harness);
    const browser = new Browser(harness.app);
    const login = await browser.openDeviceLogin(started.userCode);
    const refused = await browser.chooseAccount(
      login,
      'cardiologist',
      'a-guessed-passphrase',
    );

    expect(refused.statusCode).toBe(401);
    expect(refused.body).toContain('do not match');

    harness.clock.advance(6);
    expect(await harness.demo.deviceFlow.poll(taskId)).toEqual({
      status: 'pending',
    });
  });

  it('survives a restart: a new process polls the same sign-in to completion', async () => {
    const db = vaultWithPatient();
    const clock = testClock();

    harness = await createHarness({ db, clock });
    const { taskId, started } = await startSignIn(harness);

    await harness.app.close();
    harness = await createHarness({ db, clock });

    await new Browser(harness.app).approveDevice(
      started.userCode,
      'cardiologist',
    );
    clock.advance(6);

    expect(await harness.demo.deviceFlow.poll(taskId)).toMatchObject({
      status: 'verified',
      principal: { subject: DEMO_CARDIOLOGIST.subject },
    });
  });

  it('supersedes the pending sign-in when a new one starts for the task', async () => {
    harness = await createHarness();
    const taskId = insertTask(harness.db);
    const first = await harness.demo.deviceFlow.start({
      taskId,
      ...TEST_CONTEXT,
    });
    const second = await harness.demo.deviceFlow.start({
      taskId,
      ...TEST_CONTEXT,
    });

    expect(second.userCode).not.toBe(first.userCode);
    expect(
      harness.db
        .prepare(
          'SELECT status FROM pending_signins WHERE task_id = ? ORDER BY created_at, status',
        )
        .all(taskId)
        .map((row) => row.status)
        .sort(),
    ).toEqual(['pending', 'superseded']);
  });

  it('refuses a task that does not exist and a context the issuer page cannot show safely', async () => {
    harness = await createHarness();
    const flow = harness.demo.deviceFlow;

    await expect(
      flow.start({ taskId: 'A'.repeat(22), ...TEST_CONTEXT }),
    ).rejects.toThrow(DeviceFlowError);
    await expect(
      flow.start({
        taskId: insertTask(harness.db),
        encounterLabel: 'Cardiology\u202Ereview',
        question: TEST_CONTEXT.question,
      }),
    ).rejects.toThrow('the sign-in context is invalid');
  });

  it('answers early polls locally instead of hammering the issuer', async () => {
    harness = await createHarness();
    const { taskId } = await startSignIn(harness);

    await harness.demo.deviceFlow.poll(taskId);
    const calls = harness.issuerCalls.count;

    expect(await harness.demo.deviceFlow.poll(taskId)).toEqual({
      status: 'pending',
    });
    expect(harness.issuerCalls.count).toBe(calls);
  });

  it('reports denied when the person cancels on the account page', async () => {
    harness = await createHarness();
    const { taskId, started } = await startSignIn(harness);
    const browser = new Browser(harness.app);
    const login = await browser.openDeviceLogin(started.userCode);
    const csrf = /name="_csrf" value="([^"]+)"/.exec(login.body)?.[1] ?? '';
    const abortAction = [...login.body.matchAll(/action="([^"]+)"/g)][1]?.[1];

    await browser.follow(
      await browser.request('POST', abortAction ?? '', { _csrf: csrf }),
    );

    harness.clock.advance(6);
    expect(await harness.demo.deviceFlow.poll(taskId)).toEqual({
      status: 'denied',
    });
  });

  it('reports expired for a task with no sign-in or a lapsed one', async () => {
    harness = await createHarness();

    expect(await harness.demo.deviceFlow.poll(insertTask(harness.db))).toEqual({
      status: 'expired',
    });

    const { taskId } = await startSignIn(harness);

    harness.clock.advance(601);
    expect(await harness.demo.deviceFlow.poll(taskId)).toEqual({
      status: 'expired',
    });
    expect(
      harness.db
        .prepare('SELECT status FROM pending_signins WHERE task_id = ?')
        .get(taskId),
    ).toEqual({ status: 'expired' });
  });

  it('refuses the patient owner at the institution: a clinician sign-in never comes from the patient issuer', async () => {
    harness = await createHarness();
    const { taskId, started } = await startSignIn(harness);

    expect(started.verificationUri).toBe(`${ISSUER}/device`);

    const refused = await new Browser(harness.app).approveDevice(
      started.userCode,
      'owner',
      '/institution-idp',
    );

    expect(refused.statusCode).toBe(401);
    harness.clock.advance(6);
    expect(await harness.demo.deviceFlow.poll(taskId)).toEqual({
      status: 'pending',
    });
  });

  it('gives a verified but unregistered clinician a principal that releases nothing (A02)', async () => {
    harness = await createHarness();
    const { taskId, started } = await startSignIn(harness);

    await new Browser(harness.app).approveDevice(
      started.userCode,
      'unknown-clinician',
    );
    harness.clock.advance(6);
    const result = await harness.demo.deviceFlow.poll(taskId);

    if (result.status !== 'verified') {
      throw new Error(`expected verified, got ${result.status}`);
    }

    expect(result.clinician).toBeNull();
    expect(result.principal).toEqual({
      issuer: ISSUER,
      subject: DEMO_UNKNOWN_CLINICIAN.subject,
      audience: [PUBLIC_URL],
      scopes: ['medissy:request'],
      roles: [],
      clientId: 'medissy-agent',
    });

    const now = new Date();
    const grant = grantSchema.parse({
      id: 'grant-cardiology',
      version: 1,
      patientId: 'patient',
      effect: 'allow',
      grantee: {
        issuer: ISSUER,
        organizationId: 'org-northgate-health',
        roles: ['cardiologist'],
      },
      encounterId: 'enc-1',
      purpose: 'direct-treatment',
      categories: ['cardiac'],
      maxSensitivity: 'routine',
      allowBaseline: true,
      validFrom: new Date(now.getTime() - 60_000).toISOString(),
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    });
    const registered = {
      issuer: ISSUER,
      subject: DEMO_CARDIOLOGIST.subject,
      organizationId: 'org-northgate-health',
      roles: ['cardiologist'],
    };

    // control: the same grant does name the registered cardiologist
    expect(granteeMatches(grant.grantee, registered)).toBe(true);
    expect(granteeMatches(grant.grantee, result.principal)).toBe(false);
    expect(
      encounterAdmitsCaller(
        {
          status: 'active',
          startsAt: grant.validFrom,
          endsAt: grant.expiresAt,
          organizationId: 'org-northgate-health',
        },
        result.principal,
        now,
      ),
    ).toBe(false);
    expect(
      isRecordReleasable({
        grants: [grant],
        caller: result.principal,
        encounter: { id: 'enc-1', purpose: 'direct-treatment' },
        now,
        record: {
          id: 'rec-obs-001',
          category: 'cardiac',
          sensitivity: 'routine',
        },
      }),
    ).toBe(false);
  });
});

describe('fn:createDeviceFlow with a failing issuer', () => {
  const connection = {
    issuer: 'https://idp.test',
    authorizationEndpoint: 'https://idp.test/auth',
    tokenEndpoint: 'https://idp.test/token',
    deviceAuthorizationEndpoint: 'https://idp.test/device/auth',
    portalClientId: 'portal',
    agentClientId: 'agent',
  };
  const verifySignIn = async (): Promise<VerifyResult> => ({
    ok: false,
    reason: 'malformed',
  });

  /**
   * builds a device flow over a vault with one task and the given fetch
   * @param fetch the issuer HTTP client
   * @returns the flow and the task id
   */
  const flowWith = (
    fetch: (
      url: string | URL | Request,
      init?: RequestInit,
    ) => Promise<Response>,
  ): {
    flow: ReturnType<typeof createDeviceFlow>;
    taskId: string;
    clock: ReturnType<typeof testClock>;
  } => {
    const db = vaultWithPatient();
    const clock = testClock();

    return {
      flow: createDeviceFlow({
        db,
        connection,
        audience: 'https://medissy.test',
        verifySignIn,
        fetch,
        now: clock.now,
        timeoutMs: 20,
      }),
      taskId: insertTask(db),
      clock,
    };
  };

  it('wraps a network failure in DeviceFlowError', async () => {
    const { flow, taskId } = flowWith(async () => {
      throw new TypeError('fetch failed');
    });

    await expect(flow.start({ taskId, ...TEST_CONTEXT })).rejects.toThrow(
      DeviceFlowError,
    );
  });

  it('gives up on an issuer that does not answer within the timeout', async () => {
    const { flow, taskId } = flowWith(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason as Error);
          });
        }),
    );

    await expect(flow.start({ taskId, ...TEST_CONTEXT })).rejects.toThrow(
      'the issuer could not be reached',
    );
  });

  it('keeps the sign-in pending when a poll cannot reach the issuer, and slows down on 429', async () => {
    let mode: 'down' | 'limited' = 'down';
    let tokenCalls = 0;
    const { flow, taskId, clock } = flowWith(async (url) => {
      if (
        (url instanceof Request ? url.url : url.toString()).endsWith(
          '/device/auth',
        )
      ) {
        return Response.json({
          device_code: 'dc-1',
          user_code: 'BCDF-GHJK',
          verification_uri: 'https://idp.test/device',
          expires_in: 600,
          interval: 1,
        });
      }

      tokenCalls += 1;

      if (mode === 'down') {
        throw new TypeError('fetch failed');
      }

      return Response.json({ error: 'rate_limited' }, { status: 429 });
    });

    await flow.start({ taskId, ...TEST_CONTEXT });
    await expect(flow.poll(taskId)).rejects.toThrow(DeviceFlowError);

    clock.advance(1);
    mode = 'limited';
    expect(await flow.poll(taskId)).toEqual({ status: 'pending' });
    expect(tokenCalls).toBe(2);

    // slowed down from 1 s to 6 s: a poll 2 s later is answered locally
    clock.advance(2);
    expect(await flow.poll(taskId)).toEqual({ status: 'pending' });
    expect(tokenCalls).toBe(2);

    clock.advance(5);
    expect(await flow.poll(taskId)).toEqual({ status: 'pending' });
    expect(tokenCalls).toBe(3);
  });
});
