/**
 * A03 end to end: the official SDK client over real HTTP on an ephemeral
 * localhost port, the real /institution-idp device sign-in, the real disclosure
 * pipeline (deterministic selector, no model) and the gated download
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';

import { AgentCard, Message, Task } from '@a2a-js/sdk';
import {
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
} from '@a2a-js/sdk/client';
import { afterEach, describe, expect, it } from 'vitest';

import { agentCardJson } from '../../src/a2a/card';
import { ERRORS } from '../../src/a2a/handler';
import { createA2aSetup } from '../../src/a2a/plugin';
import { createConnectorStore } from '../../src/box/connector';
import {
  artifactPartSchema,
  disclosureResultSchema,
  SUBMISSION_MEDIA_TYPE,
} from '../../src/contracts';
import { DEMO_CARDIOLOGIST } from '../../src/demo-idp/users';
import { answer, fakeModel } from '../disclosure/support';
import {
  Browser,
  createHarness,
  HOST,
  PATIENT_ID,
  PUBLIC_URL,
  testClock,
  vaultWithPatient,
} from '../identity/support';
import { confirmConnection } from '../inbound/support';
import {
  fixtureRecords,
  grantFor,
  insertGrant,
  insertRecord,
  manifest,
} from '../policy/support';

import type { AddressInfo } from 'node:net';

import type { SendMessageRequest } from '@a2a-js/sdk';

import type { SourceFileReader } from '../../src/a2a/downloads';
import type { FetchLike } from '../../src/box/connector';
import type { SecureStore } from '../../src/box/types';
import type { Harness, TestClock } from '../identity/support';

const DEMO_ISSUER = `${PUBLIC_URL}/demo-idp`;
const CLINICIAN_ISSUER = `${PUBLIC_URL}/institution-idp`;
const ENCOUNTER = 'enc-a03-cardio';
const DOCS = join(
  import.meta.dirname,
  '..',
  '..',
  'fixtures',
  'synthetic',
  'source-docs',
);

/** fixture bytes by Box file id, as the Box adapter would return them */
const fixtureReader: SourceFileReader = {
  read: async (fileId) => {
    const doc = (
      manifest as unknown as {
        sourceDocuments: Array<{ file: string; boxFileId: string }>;
      }
    ).sourceDocuments.find((item) => item.boxFileId === fileId);

    return doc
      ? { bytes: readFileSync(join(DOCS, doc.file)), name: doc.file }
      : undefined;
  },
};

interface Rig {
  harness: Harness;
  clock: TestClock;
  port: number;
  fetch: typeof fetch;
}

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.harness.app.close();
  rig = undefined;
});

/**
 * builds a fetch over real localhost HTTP that addresses the app as medissy.test
 * @param port the listening port
 * @returns a fetch that sends every request to the local server
 */
function localFetch(port: number): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = new Headers(
      input instanceof Request ? input.headers : init?.headers,
    );
    const body =
      input instanceof Request
        ? await input.text()
        : (init?.body as string | undefined);

    headers.set('host', HOST);

    return new Promise<Response>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: `${url.pathname}${url.search}`,
          method:
            (input instanceof Request ? input.method : init?.method) ?? 'GET',
          headers: Object.fromEntries(headers),
        },
        (res) => {
          const chunks: Buffer[] = [];

          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const out = new Headers();

            for (const [name, value] of Object.entries(res.headers)) {
              for (const item of [value].flat()) {
                if (item !== undefined) {
                  out.append(name, item);
                }
              }
            }

            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode,
                headers: out,
              }),
            );
          });
        },
      );

      req.on('error', reject);
      req.end(body);
    });
  };
}

/**
 * starts the app with the demo IdP, the A2A surface, a seeded vault and a grant for
 * the demo cardiologist, listening on an ephemeral localhost port
 * @param options what to configure
 * @param options.reader whether a source file reader is configured
 * @param options.store the secure store for handed-back records, if any
 * @param options.connected whether the cardiologist's connection is confirmed
 * @returns the rig
 */
async function start(
  options: { reader?: boolean; store?: SecureStore; connected?: boolean } = {},
): Promise<Rig> {
  const db = vaultWithPatient();
  const clock = testClock();

  for (const record of fixtureRecords) {
    insertRecord(db, record);
  }

  const harness = await createHarness({
    db,
    clock,
    setup: (demo) => [
      createA2aSetup({
        publicUrl: PUBLIC_URL,
        deviceFlow: demo.deviceFlow,
        ownerDeviceFlow: demo.ownerDeviceFlow,
        // a recording fake: no live model in tests
        selectorClient: fakeModel(() =>
          answer(['rec-cond-001', 'rec-obs-001', 'rec-dr-001']),
        ).client,
        reader: options.reader === false ? undefined : fixtureReader,
        clock: clock.now,
        db,
        ...(options.store ? { secureStore: options.store } : {}),
      }),
    ],
  });
  const now = clock.now().getTime();
  const day = 86_400_000;

  db.prepare(
    `INSERT INTO encounters (id, patient_id, purpose, clinician_issuer, clinician_subject, starts_at, ends_at, status,
       created_by_issuer, created_by_subject, created_at)
     VALUES (?, ?, 'direct-treatment', ?, ?, ?, ?, 'active', ?, ?, ?)`,
  ).run(
    ENCOUNTER,
    PATIENT_ID,
    CLINICIAN_ISSUER,
    DEMO_CARDIOLOGIST.subject,
    new Date(now - day).toISOString(),
    new Date(now + 30 * day).toISOString(),
    DEMO_ISSUER,
    'synthetic-owner',
    new Date(now - day).toISOString(),
  );
  insertGrant(
    db,
    grantFor({
      id: 'grant-a03',
      patientId: PATIENT_ID,
      grantee: { issuer: CLINICIAN_ISSUER, subject: DEMO_CARDIOLOGIST.subject },
      encounterId: ENCOUNTER,
      validFrom: new Date(now - day).toISOString(),
      expiresAt: new Date(now + 7 * day).toISOString(),
    }),
  );

  if (options.connected) {
    confirmConnection(db, {
      patientId: PATIENT_ID,
      issuer: CLINICIAN_ISSUER,
      subject: DEMO_CARDIOLOGIST.subject,
    });
  }

  await harness.app.listen({ port: 0, host: '127.0.0.1' });

  const { port } = harness.app.server.address() as AddressInfo;

  return { harness, clock, port, fetch: localFetch(port) };
}

/**
 * builds a SendMessage request for the encounter
 * @param messageId the client-chosen id that makes the SendMessage idempotent
 * @returns the request
 */
function clinicalMessage(messageId: string): SendMessageRequest {
  return {
    tenant: '',
    configuration: undefined,
    metadata: undefined,
    message: Message.fromJSON({
      messageId,
      role: 'ROLE_USER',
      parts: [
        {
          data: {
            skill: 'clinical-evidence-request',
            encounterId: ENCOUNTER,
            question: 'Summarise the rhythm history and anticoagulation.',
          },
          mediaType: 'application/json',
        },
      ],
    }),
  };
}

/**
 * posts raw JSON-RPC
 * @param r the rig
 * @param body the request body
 * @param headers extra headers
 * @returns the parsed response
 */
async function rpc(
  r: Rig,
  body: unknown,
  headers: Record<string, string> = { 'a2a-version': '1.0' },
): Promise<Record<string, unknown>> {
  const res = await r.fetch(`${PUBLIC_URL}/a2a/v1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

  return (await res.json()) as Record<string, unknown>;
}

describe('A2A surface (A03)', () => {
  it('serves a generic Agent Card that round-trips the SDK schema and names no patient data', async () => {
    rig = await start();

    const res = await rig.fetch(`${PUBLIC_URL}/.well-known/agent-card.json`);
    const json = (await res.json()) as Record<string, unknown>;
    const text = JSON.stringify(json);

    expect(AgentCard.toJSON(AgentCard.fromJSON(json))).toEqual(
      AgentCard.toJSON(
        AgentCard.fromJSON(
          agentCardJson({
            publicUrl: PUBLIC_URL,
            shareCodeAvailable: true,
          }),
        ),
      ),
    );
    expect(AgentCard.fromJSON(json).supportedInterfaces[0]).toMatchObject({
      url: `${PUBLIC_URL}/a2a/v1`,
      protocolBinding: 'JSONRPC',
      protocolVersion: '1.0',
    });
    expect(AgentCard.fromJSON(json).skills.map((skill) => skill.id)).toEqual([
      'clinical-evidence-request',
      'redeem-invitation',
      'share-code',
      'submit-record',
    ]);
    // no issuer is advertised: naming the trusted institution would reveal
    // where the patient is treated (ADR-9)
    expect(text).not.toContain('/institution-idp');
    expect(text).not.toContain('Northgate');
    expect(text).not.toContain('deviceAuthorizationUrl');
    for (const secret of [
      PATIENT_ID,
      manifest.canary,
      'rec-',
      ENCOUNTER,
      'Testwell',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('runs SendMessage -> AUTH_REQUIRED -> /institution-idp approval -> GetTask -> COMPLETED with schema-valid parts, then gates downloads', async () => {
    rig = await start();
    const factory = new ClientFactory({
      transports: [new JsonRpcTransportFactory({ fetchImpl: rig.fetch })],
      cardResolver: new DefaultAgentCardResolver({ fetchImpl: rig.fetch }),
    });
    const client = await factory.createFromUrl(PUBLIC_URL);
    const sent = await client.sendMessage(clinicalMessage('a03-msg-1'));
    const created = Task.toJSON(sent as Task) as {
      id: string;
      status: {
        state: string;
        message: { parts: Array<Record<string, unknown>> };
      };
    };
    const signIn = created.status.message.parts[1]?.data as {
      userCode: string;
      verificationUri: string;
    };

    expect(created.status.state).toBe('TASK_STATE_AUTH_REQUIRED');
    expect(signIn.verificationUri).toBe(`${CLINICIAN_ISSUER}/device`);
    expect(JSON.stringify(created)).not.toMatch(
      /device_code|access_token|user_code=/,
    );

    const pending = Task.toJSON(
      await client.getTask({ tenant: '', id: created.id }),
    ) as typeof created;

    expect(pending.status.state).toBe('TASK_STATE_AUTH_REQUIRED');

    await new Browser(rig.harness.app).approveDevice(
      signIn.userCode,
      'cardiologist',
    );
    rig.clock.advance(6);

    const done = Task.toJSON(
      await client.getTask({ tenant: '', id: created.id }),
    ) as {
      status: { state: string };
      artifacts: Array<{ parts: unknown[] }>;
    };
    const parts = done.artifacts[0]?.parts ?? [];

    expect(done.status.state).toBe('TASK_STATE_COMPLETED');
    expect(parts).toHaveLength(3);
    for (const part of parts) {
      expect(artifactPartSchema.safeParse(part).success).toBe(true);
    }

    const result = disclosureResultSchema.parse(
      (parts[1] as { data: unknown }).data,
    );
    const released = new Set(result.evidence.map((item) => item.recordId));
    const sources = (
      manifest as unknown as {
        sourceDocuments: Array<{
          file: string;
          boxFileId: string;
          recordIds: string[];
        }>;
      }
    ).sourceDocuments;
    const inScope = sources.find(
      (doc) =>
        doc.recordIds.length > 0 &&
        doc.recordIds.every((id) => released.has(id)),
    );
    const outOfScope = sources.find((doc) =>
      doc.recordIds.includes('rec-doc-003'),
    );

    expect(result.scope.encounterId).toBe(ENCOUNTER);
    expect(released.has('rec-dr-001')).toBe(true);
    expect(inScope?.file).toMatch(/\.(txt|json)$/);

    // gated download: in scope, safe type, attachment, no-store, no redirect
    const file = await rig.fetch(
      `${PUBLIC_URL}/a2a/v1/tasks/${created.id}/files/${inScope?.boxFileId}`,
    );
    const bytes = Buffer.from(await file.arrayBuffer());

    expect(file.status).toBe(200);
    expect(file.headers.get('cache-control')).toBe('no-store');
    expect(file.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(file.headers.get('location')).toBeNull();
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      createHash('sha256')
        .update(readFileSync(join(DOCS, inScope?.file ?? '')))
        .digest('hex'),
    );

    const restricted = await rig.fetch(
      `${PUBLIC_URL}/a2a/v1/tasks/${created.id}/files/${outOfScope?.boxFileId}`,
    );

    expect(restricted.status).toBe(404);

    // revoke mid-task: polls and downloads stop (A08)
    insertGrant(
      rig.harness.db,
      grantFor({
        id: 'grant-a03',
        version: 2,
        patientId: PATIENT_ID,
        grantee: {
          issuer: CLINICIAN_ISSUER,
          subject: DEMO_CARDIOLOGIST.subject,
        },
        encounterId: ENCOUNTER,
        validFrom: new Date(
          rig.clock.now().getTime() - 86_400_000,
        ).toISOString(),
        expiresAt: new Date(
          rig.clock.now().getTime() + 86_400_000,
        ).toISOString(),
        revokedAt: rig.clock.now().toISOString(),
      }),
    );
    rig.clock.advance(6);

    const ended = Task.toJSON(
      await client.getTask({ tenant: '', id: created.id }),
    ) as {
      artifacts?: unknown[];
      status: { message: { parts: Array<{ text?: string }> } };
    };
    const blocked = await rig.fetch(
      `${PUBLIC_URL}/a2a/v1/tasks/${created.id}/files/${inScope?.boxFileId}`,
    );

    // ProtoJSON omits an empty artifact list
    expect(ended.artifacts ?? []).toEqual([]);
    expect(ended.status.message.parts[0]?.text).toContain('Access ended');
    expect(blocked.status).toBe(404);
  });

  it('requires the A2A-Version header (-32009), refuses legacy message/send (-32601) and a reused messageId', async () => {
    rig = await start();

    const noVersion = await rpc(
      rig,
      { jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'x' } },
      {},
    );
    const legacy = await rpc(rig, {
      jsonrpc: '2.0',
      id: 2,
      method: 'message/send',
      params: {},
    });
    const send = {
      jsonrpc: '2.0',
      id: 3,
      method: 'SendMessage',
      params: { message: Message.toJSON(clinicalMessage('a08-dup').message!) },
    };
    const first = await rpc(rig, send);
    const second = await rpc(rig, send);
    const unknown = await rpc(rig, {
      jsonrpc: '2.0',
      id: 4,
      method: 'GetTask',
      params: { id: 'A'.repeat(22) },
    });

    expect(noVersion.error).toMatchObject({ code: -32009 });
    expect(legacy.error).toMatchObject({ code: -32601 });
    expect(first.result).toMatchObject({
      task: { status: { state: 'TASK_STATE_AUTH_REQUIRED' } },
    });
    expect(second.error).toMatchObject({ code: -32602 });
    expect(JSON.stringify(second)).not.toContain(
      (first.result as { task: { id: string } }).task.id,
    );
    expect(unknown.error).toMatchObject({ code: -32001 });
  });
  it('refuses the extended agent card as not configured (-32007)', async () => {
    rig = await start();

    const extended = await rpc(rig, {
      jsonrpc: '2.0',
      id: 1,
      method: 'GetExtendedAgentCard',
      params: {},
    });

    expect(extended.error).toMatchObject({ code: -32007 });
  });

  it('lets one client IP hold at most 5 waiting sign-ins, so it cannot fill the global device slots', async () => {
    rig = await start();

    const replies: Array<Record<string, unknown>> = [];

    for (const n of [0, 1, 2, 3, 4, 5]) {
      replies.push(
        await rpc(rig, {
          jsonrpc: '2.0',
          id: n,
          method: 'SendMessage',
          params: {
            message: Message.toJSON(clinicalMessage(`flood-${n}`).message!),
          },
        }),
      );
    }

    const { db } = rig.harness;
    const signIns = db
      .prepare('SELECT device_code AS code FROM pending_signins')
      .all() as Array<{ code: string }>;

    expect(replies.slice(0, 5).every((reply) => reply.result)).toBe(true);
    // a server-defined code with a fixed message, not -32603 (internal error)
    expect(replies[5]?.error).toEqual({ code: -32000, message: ERRORS.busy });
    expect(signIns).toHaveLength(5);
    // the purge relies on the IdP keying its device code row by the device code
    for (const { code } of signIns) {
      expect(
        db
          .prepare(
            `SELECT 1 AS hit FROM idp_store WHERE model = 'DeviceCode' AND id = ?`,
          )
          .get(code),
      ).toEqual({ hit: 1 });
    }
  });

  it('advertises no download link and registers no download route without a file reader', async () => {
    rig = await start({ reader: false });

    const created = (
      await rpc(rig, {
        jsonrpc: '2.0',
        id: 1,
        method: 'SendMessage',
        params: {
          message: Message.toJSON(clinicalMessage('no-reader').message!),
        },
      })
    ).result as {
      task: {
        id: string;
        status: { message: { parts: Array<{ data?: { userCode: string } }> } };
      };
    };

    await new Browser(rig.harness.app).approveDevice(
      created.task.status.message.parts[1]?.data?.userCode ?? '',
      'cardiologist',
    );
    rig.clock.advance(6);

    const done = (
      await rpc(rig, {
        jsonrpc: '2.0',
        id: 2,
        method: 'GetTask',
        params: { id: created.task.id },
      })
    ).result as {
      status: { state: string };
      artifacts: Array<{ parts: Array<{ text?: string; raw?: string }> }>;
    };
    const parts = done.artifacts[0]?.parts ?? [];
    const card = Buffer.from(parts[2]?.raw ?? '', 'base64').toString('utf8');
    const download = await rig.fetch(
      `${PUBLIC_URL}/a2a/v1/tasks/${created.task.id}/files/1`,
    );

    expect(done.status.state).toBe('TASK_STATE_COMPLETED');
    expect(parts[0]?.text).not.toMatch(/Source files|files\/\{fileId\}/);
    expect(card).not.toContain('Source files');
    expect(download.status).toBe(404);
  });
});

/**
 * builds a SendMessage request carrying one data part
 * @param messageId the client-chosen id that makes the SendMessage idempotent
 * @param data the data part
 * @returns the request
 */
function dataMessage(
  messageId: string,
  data: Record<string, unknown>,
): SendMessageRequest {
  return {
    tenant: '',
    configuration: undefined,
    metadata: undefined,
    message: Message.fromJSON({
      messageId,
      role: 'ROLE_USER',
      parts: [{ data, mediaType: 'application/json' }],
    }),
  };
}

interface TaskView {
  id: string;
  status: { state: string; message: { parts: Array<Record<string, unknown>> } };
  artifacts?: Array<{
    artifactId: string;
    parts: Array<Record<string, unknown>>;
  }>;
}

/**
 * sends a data message over the SDK client and approves its sign-in as an account
 * @param r the rig
 * @param message the id that makes the SendMessage idempotent, and its data part
 * @param message.messageId the client-chosen message id
 * @param message.data the data part
 * @param approver who approves the device sign-in, and where
 * @param approver.account the persona key
 * @param approver.mount the issuer it approves at; the persona's own by default
 * @returns the task created, and the task after the approval
 */
async function signedInTask(
  r: Rig,
  message: { messageId: string; data: Record<string, unknown> },
  approver: { account: string; mount?: string },
): Promise<{ created: TaskView; done: TaskView }> {
  const { account, mount } = approver;
  const factory = new ClientFactory({
    transports: [new JsonRpcTransportFactory({ fetchImpl: r.fetch })],
    cardResolver: new DefaultAgentCardResolver({ fetchImpl: r.fetch }),
  });
  const client = await factory.createFromUrl(PUBLIC_URL);
  const created = Task.toJSON(
    (await client.sendMessage(
      dataMessage(message.messageId, message.data),
    )) as Task,
  ) as TaskView;
  const signIn = created.status.message.parts[1]?.data as { userCode: string };

  await new Browser(r.harness.app).approveDevice(
    signIn.userCode,
    account,
    mount,
  );
  r.clock.advance(6);

  const done = Task.toJSON(
    await client.getTask({ tenant: '', id: created.id }),
  ) as TaskView;

  return { created, done };
}

describe('A2A institution sign-in (ADR-9)', () => {
  it('keeps subject grants working across just-in-time re-sign-ins at /institution-idp, and still blocks a suspended doctor', async () => {
    rig = await start();

    const request = {
      skill: 'clinical-evidence-request',
      encounterId: ENCOUNTER,
      question: 'Summarise the rhythm history and anticoagulation.',
    };
    const first = await signedInTask(
      rig,
      { messageId: 'adr9-jit-1', data: request },
      { account: 'cardiologist' },
    );
    const second = await signedInTask(
      rig,
      { messageId: 'adr9-jit-2', data: request },
      { account: 'cardiologist' },
    );

    expect(first.done.status.state).toBe('TASK_STATE_COMPLETED');
    expect(second.done.status.state).toBe('TASK_STATE_COMPLETED');
    expect({
      ...rig.harness.db
        .prepare(
          'SELECT organization_id, roles, status FROM clinicians WHERE issuer = ? AND subject = ?',
        )
        .get(CLINICIAN_ISSUER, DEMO_CARDIOLOGIST.subject),
    }).toEqual({
      organization_id: 'org-northgate-health',
      roles: '["cardiologist"]',
      status: 'active',
    });

    rig.harness.db
      .prepare(
        "UPDATE clinicians SET status = 'suspended' WHERE issuer = ? AND subject = ?",
      )
      .run(CLINICIAN_ISSUER, DEMO_CARDIOLOGIST.subject);

    const suspended = await signedInTask(
      rig,
      { messageId: 'adr9-jit-3', data: request },
      { account: 'cardiologist' },
    );

    // the re-sign-in left the patient's suspension in place: the uniform denial
    expect(suspended.done.status.state).toBe('TASK_STATE_REJECTED');
    expect(JSON.stringify(suspended.done.status)).toContain('"kind":"denied"');
    expect(suspended.done.artifacts ?? []).toEqual([]);
    expect(
      rig.harness.db
        .prepare('SELECT status FROM clinicians WHERE subject = ?')
        .get(DEMO_CARDIOLOGIST.subject),
    ).toEqual({ status: 'suspended' });
  });
});

describe('A2A share code (SHR03)', () => {
  it('should give the signed-in patient owner a single-use QR over A2A that a clinician then redeems, pending patient confirmation', async () => {
    rig = await start();

    const { created, done } = await signedInTask(
      rig,
      { messageId: 'shr03-share-1', data: { skill: 'share-code' } },
      { account: 'owner' },
    );
    const parts = done.artifacts?.[0]?.parts ?? [];
    const text = String(parts[0]?.text);
    const share = parts[1]?.data as { url: string; expiresAt: string };
    const token = share.url.split('#')[1] ?? '';

    expect(created.status.state).toBe('TASK_STATE_AUTH_REQUIRED');
    expect(done.status.state).toBe('TASK_STATE_COMPLETED');
    expect(done.artifacts?.[0]?.artifactId).toBe('medissy-share-code');
    expect(parts).toHaveLength(4);
    expect(text).toContain('SYNTHETIC DEMO');
    expect(text).toContain('medissy-share-qr.png');
    expect(parts[3]).toMatchObject({
      mediaType: 'image/png',
      filename: 'medissy-share-qr.png',
    });
    expect(share.url).toMatch(
      new RegExp(`^${PUBLIC_URL}/connect#[A-Za-z0-9_-]{43}$`),
    );
    expect(parts[2]).toMatchObject({ mediaType: 'text/html' });

    // only the token's hash is stored, nowhere the token itself
    const db = rig.harness.db;
    const hash = createHash('sha256').update(token).digest('hex');

    expect(db.prepare('SELECT token_hash FROM invitations').all()).toEqual([
      { token_hash: hash },
    ]);
    expect(
      JSON.stringify(db.prepare('SELECT * FROM a2a_tasks').all()),
    ).not.toContain(token);

    // the invitation is shown in that response only
    const factory = new ClientFactory({
      transports: [new JsonRpcTransportFactory({ fetchImpl: rig.fetch })],
      cardResolver: new DefaultAgentCardResolver({ fetchImpl: rig.fetch }),
    });
    const client = await factory.createFromUrl(PUBLIC_URL);
    const later = Task.toJSON(
      await client.getTask({ tenant: '', id: created.id }),
    ) as TaskView;

    expect(later.status.state).toBe('TASK_STATE_COMPLETED');
    expect(later.artifacts ?? []).toEqual([]);
    expect(JSON.stringify(later)).not.toContain(token);

    // the clinician redeems that code over A2A: nothing is shared yet
    const redeemed = await signedInTask(
      rig,
      {
        messageId: 'shr03-redeem-1',
        data: { skill: 'redeem-invitation', code: share.url },
      },
      { account: 'cardiologist' },
    );

    expect(redeemed.done.status.state).toBe('TASK_STATE_COMPLETED');
    expect(JSON.stringify(redeemed.done.status)).toContain(
      'pending patient confirmation',
    );
    expect(redeemed.done.artifacts ?? []).toEqual([]);
    expect(
      db
        .prepare(`SELECT status FROM connections WHERE requester_subject = ?`)
        .all(DEMO_CARDIOLOGIST.subject),
    ).toEqual([{ status: 'pending' }]);
  });

  it('should refuse a clinician at a share-code sign-in (the patient issuer holds no Northgate staff), without binding the task or creating an invitation', async () => {
    rig = await start();

    const { created, done } = await signedInTask(
      rig,
      { messageId: 'shr03-share-2', data: { skill: 'share-code' } },
      { account: 'cardiologist', mount: '/demo-idp' },
    );
    const db = rig.harness.db;
    const signIn = created.status.message.parts[1]?.data as {
      verificationUri: string;
    };

    // the owner flow picks the patient's issuer, never the institution
    expect(signIn.verificationUri).toBe(`${DEMO_ISSUER}/device`);
    expect(done.status.state).toBe('TASK_STATE_AUTH_REQUIRED');
    expect(done.artifacts ?? []).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM invitations').get()).toEqual({
      n: 0,
    });
    expect(db.prepare('SELECT caller_issuer FROM a2a_tasks').all()).toEqual([
      { caller_issuer: null },
    ]);
  });
});

/** the folder the stub gateway files into */
const INBOUND_FOLDER = '8800000001';

/** one upload the stub gateway saw */
interface SeenUpload {
  url: string;
  init: Parameters<FetchLike>[1];
}

/**
 * builds a Box connector store over a stub Sprites gateway that records each upload
 * and answers as Box does
 * @returns the store and the uploads it saw
 */
function stubGatewayStore(): { store: SecureStore; seen: SeenUpload[] } {
  const seen: SeenUpload[] = [];
  const fetchStub: FetchLike = async (url, init) => {
    seen.push({ url, init });

    const file = init.body?.get('file');
    const size = file instanceof Blob ? file.size : 0;
    const attributes = JSON.parse(init.body?.get('attributes') as string) as {
      name: string;
    };

    return Promise.resolve(
      Response.json({
        total_count: 1,
        entries: [
          {
            type: 'file',
            id: String(1_500_000_000 + seen.length),
            name: attributes.name,
            size,
            file_version: { id: String(1_700_000_000 + seen.length) },
            parent: { id: INBOUND_FOLDER },
          },
        ],
      }),
    );
  };

  return {
    seen,
    store: createConnectorStore({
      connectionId: 'conn_box_test',
      folderId: INBOUND_FOLDER,
      fetch: fetchStub,
    }),
  };
}

/** a synthetic record a clinician's agent hands back */
const SUBMISSION = {
  skill: 'submit-record',
  category: 'cardiac',
  record: {
    resourceType: 'Observation',
    status: 'final',
    code: { text: 'SYNTHETIC post-visit resting heart rate' },
    valueQuantity: { value: 62, unit: 'beats/min' },
  },
};

describe('A2A record hand-back (ADR-10)', () => {
  it('should file a record for a signed-in clinician with an active grant through the stub gateway', async () => {
    const gateway = stubGatewayStore();

    rig = await start({ store: gateway.store, connected: true });

    const { created, done } = await signedInTask(
      rig,
      { messageId: 'adr10-submit-1', data: SUBMISSION },
      { account: 'cardiologist' },
    );
    const [text, data] = done.status.message.parts;
    const result = data?.data as Record<string, unknown>;
    const [upload] = gateway.seen;
    const body = upload?.init.body;

    expect(created.status.state).toBe('TASK_STATE_AUTH_REQUIRED');
    expect(gateway.seen).toHaveLength(1);
    expect(upload?.url).toBe(
      'https://api.sprites.dev/v1/gateway/box/conn_box_test/upload/files/content',
    );
    expect(upload?.init.method).toBe('POST');
    expect(upload?.init.redirect).toBe('manual');
    expect(
      Object.keys(upload?.init.headers ?? {}).map((name) => name.toLowerCase()),
    ).not.toContain('authorization');
    expect(body ? [...body.keys()] : []).toEqual(['attributes', 'file']);
    expect(JSON.parse(body?.get('attributes') as string)).toMatchObject({
      parent: { id: INBOUND_FOLDER },
    });
    expect(done.status.state).toBe('TASK_STATE_COMPLETED');
    expect(String(text?.text)).toContain("to the patient's secure store");
    expect(data?.mediaType).toBe(SUBMISSION_MEDIA_TYPE);
    expect(result).toMatchObject({
      status: 'filed',
      resourceType: 'Observation',
      category: 'cardiac',
    });
    expect(JSON.stringify(result)).not.toContain('1500000001');
    expect(
      rig.harness.db
        .prepare('SELECT status FROM records WHERE id = ?')
        .get(String(result.recordId)),
    ).toEqual({ status: 'current' });
  });

  it('should give a clinician without an active grant the uniform denial and file nothing', async () => {
    const gateway = stubGatewayStore();

    rig = await start({ store: gateway.store, connected: true });

    const clinical = await signedInTask(
      rig,
      {
        messageId: 'adr10-clinical-dentist',
        data: {
          skill: 'clinical-evidence-request',
          encounterId: ENCOUNTER,
          question: 'Any cardiac history?',
        },
      },
      { account: 'dentist' },
    );
    const outcomes = [
      await signedInTask(
        rig,
        { messageId: 'adr10-submit-dentist', data: SUBMISSION },
        { account: 'dentist' },
      ),
      await signedInTask(
        rig,
        { messageId: 'adr10-submit-unknown', data: SUBMISSION },
        { account: 'unknown-clinician' },
      ),
    ];
    const denialText = (view: TaskView): unknown =>
      view.status.message.parts[0]?.text;

    for (const { done } of outcomes) {
      expect(done.status.state).toBe(clinical.done.status.state);
      expect(done.status.state).toBe('TASK_STATE_REJECTED');
      expect(denialText(done)).toBe(denialText(clinical.done));
    }

    expect(gateway.seen).toHaveLength(0);
  });

  it('should deny uniformly once the grant is revoked, filing nothing', async () => {
    const gateway = stubGatewayStore();

    rig = await start({ store: gateway.store, connected: true });
    rig.harness.db
      .prepare(
        `INSERT INTO grants (id, version, patient_id, effect, grantee_issuer, grantee_subject, grantee_organization_id, grantee_roles,
           encounter_id, purpose, categories, max_sensitivity, allow_baseline, allowed_record_ids, valid_from, expires_at, revoked_at,
           source, scope_request_id, created_by_issuer, created_by_subject, created_at)
         SELECT id, version + 1, patient_id, effect, grantee_issuer, grantee_subject, grantee_organization_id, grantee_roles,
           encounter_id, purpose, categories, max_sensitivity, allow_baseline, allowed_record_ids, valid_from, expires_at, ?,
           source, scope_request_id, created_by_issuer, created_by_subject, created_at
         FROM grants WHERE id = 'grant-a03'`,
      )
      .run(rig.clock.now().toISOString());

    const { done } = await signedInTask(
      rig,
      { messageId: 'adr10-submit-revoked', data: SUBMISSION },
      { account: 'cardiologist' },
    );

    expect(done.status.state).toBe('TASK_STATE_REJECTED');
    expect(gateway.seen).toHaveLength(0);
  });

  it('should refuse a malformed submission before any task and a reused messageId after one', async () => {
    const gateway = stubGatewayStore();

    rig = await start({ store: gateway.store, connected: true });

    const contained = await rpc(rig, {
      jsonrpc: '2.0',
      id: 1,
      method: 'SendMessage',
      params: {
        message: {
          messageId: 'adr10-contained',
          role: 'ROLE_USER',
          parts: [
            {
              data: {
                ...SUBMISSION,
                record: {
                  ...SUBMISSION.record,
                  contained: [{ resourceType: 'Patient', id: 'other' }],
                },
              },
            },
          ],
        },
      },
    });

    await signedInTask(
      rig,
      { messageId: 'adr10-submit-twice', data: SUBMISSION },
      { account: 'cardiologist' },
    );

    const replay = await rpc(rig, {
      jsonrpc: '2.0',
      id: 2,
      method: 'SendMessage',
      params: {
        message: {
          messageId: 'adr10-submit-twice',
          role: 'ROLE_USER',
          parts: [{ data: SUBMISSION }],
        },
      },
    });

    expect(contained.error).toBeDefined();
    expect(replay.error).toMatchObject({ message: ERRORS.collision });
    expect(gateway.seen).toHaveLength(1);
  });
});
