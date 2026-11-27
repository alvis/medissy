/**
 * CLI01: the generic A2A client skill (`skills/a2a-client/a2a.mjs`) against
 * an in-process Medissy over real localhost HTTP, the real /institution-idp device
 * sign-in and the real disclosure pipeline (deterministic fake selector),
 * plus stub servers for the refusals
 */
import { execFile } from 'node:child_process';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { main } from '../../skills/a2a-client/a2a.mjs';
import { disclosureResultSchema } from '../../src/contracts';
import { Browser } from '../identity/support';

import {
  captured,
  ENCOUNTER,
  jsonFetch,
  ORIGIN,
  runScript,
  SCRIPT,
  startMedissy,
  stubServer,
  testIo,
} from './support';

import type { MedissyRig, StubServer, TestIo } from './support';

const CLINICAL = JSON.stringify({
  skill: 'clinical-evidence-request',
  encounterId: ENCOUNTER,
  question: 'Summarise the rhythm history and anticoagulation.',
});

const execFileAsync = promisify(execFile);

let rig: MedissyRig | undefined;
let stub: StubServer | undefined;

afterEach(async () => {
  await rig?.harness.app.close();
  await stub?.close();
  rig = undefined;
  stub = undefined;
});

/**
 * runs the client in process
 * @param args the command line
 * @param io the captured console and clock the client runs against
 * @returns the captured output
 */
async function run(args: string[], io: ReturnType<typeof testIo>) {
  return captured(io, await main(args, io));
}

/**
 * lists the JSON-RPC bodies POSTed through a recording fetch
 * @param calls the recorded calls
 * @returns the parsed bodies
 */
function bodiesOf(
  calls: Array<{ init?: RequestInit }>,
): Array<Record<string, any>> {
  return calls
    .filter((call) => call.init?.method === 'POST')
    .map(
      (call) => JSON.parse(call.init?.body as string) as Record<string, any>,
    );
}

/**
 * builds a fetch that serves a card for `origin` and answers JSON-RPC with `reply`
 * @param origin the origin the served card advertises
 * @param reply the JSON-RPC result or error for each POST
 * @returns the fetch and the calls it saw
 */
function agentFetch(
  origin: string,
  reply: (body: Record<string, any>) => Record<string, unknown>,
): { fetch: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const card = {
    name: 'Stub agent',
    description: 'A stub agent',
    supportedInterfaces: [
      {
        url: `${origin}/rpc`,
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0',
      },
    ],
    skills: [
      {
        id: 'echo',
        name: 'Echo',
        description: 'Echoes',
        examples: ['{"skill":"echo"}'],
      },
    ],
  };

  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = input instanceof Request ? input.url : input.toString();

    calls.push({ url, init });

    if (init?.method === 'POST') {
      const body = JSON.parse(init.body as string) as Record<string, any>;

      return json({ jsonrpc: '2.0', id: body.id, ...reply(body) });
    }

    return json(card);
  }) as typeof fetch;

  return { fetch: fetchImpl, calls };
}

describe('a2a-client: Medissy journey (CLI01, SC-5)', () => {
  it('lists the skills of an allowlisted agent card', async () => {
    rig = await startMedissy();
    const io = testIo(rig.fetch);

    const out = await run(['card', ORIGIN], io);
    const agent = out.envelope.agent as {
      endpoint: string;
      skills: Array<{ id: string; examples: string[] }>;
    };

    expect(out.code).toBe(0);
    expect(out.envelope.state).toBe('card');
    expect(agent.endpoint).toBe(`${ORIGIN}/a2a/v1`);
    // Medissy's skill list grows (SHR adds skills); the client relays whatever the card lists
    expect(agent.skills.map((skill) => skill.id)).toEqual(
      expect.arrayContaining([
        'clinical-evidence-request',
        'redeem-invitation',
        'share-code',
      ]),
    );
    expect(agent.skills[0]?.examples[0]).toContain('clinical-evidence-request');
    expect(out.envelope.text).toContain('clinical-evidence-request');
    expect(rig.fetched).toEqual([`${ORIGIN}/.well-known/agent-card.json`]);
    expect(out.stderr).toBe('');
  });

  it('sends a data request and returns an AUTH_REQUIRED envelope with the sign-in and no device code or token', async () => {
    rig = await startMedissy();
    const io = testIo(rig.fetch);

    const out = await run(['send', ORIGIN, '--data', CLINICAL], io);
    const signin = out.envelope.signin as Record<string, string>;

    expect(out.code).toBe(0);
    expect(out.envelope).toMatchObject({
      state: 'auth-required',
      terminal: false,
    });
    expect(out.envelope.taskId).toEqual(expect.any(String));
    expect(Object.keys(signin).sort()).toEqual([
      'expiresAt',
      'userCode',
      'verificationUri',
    ]);
    expect(signin.verificationUri).toBe(
      'https://medissy.test/institution-idp/device',
    );
    expect(signin.userCode).toMatch(/\S/);
    expect(out.envelope.text).toContain(signin.userCode);
    expect(out.stdout).not.toMatch(
      /device_?code|access_?token|refresh_?token|id_?token|bearer/i,
    );
    expect(out.stderr).toBe('');
  });

  it('waits through the /institution-idp approval to a completed envelope with the unchanged HTML card and the structured result', async () => {
    rig = await startMedissy();
    const io = testIo(rig.fetch, { clock: rig.clock });

    const sent = await run(['send', ORIGIN, '--data', CLINICAL], io);
    const taskId = sent.envelope.taskId as string;
    const { userCode } = sent.envelope.signin as { userCode: string };

    await new Browser(rig.harness.app).approveDevice(userCode, 'cardiologist');

    const waitIo = testIo(rig.fetch, { clock: rig.clock });
    const done = await run(['wait', ORIGIN, taskId], waitIo);
    const data = done.envelope.data as Array<{
      mediaType: string;
      data: unknown;
    }>;
    const result = disclosureResultSchema.parse(data[0]?.data);
    const html = done.envelope.html as string;

    expect(done.code).toBe(0);
    expect(done.envelope).toMatchObject({
      state: 'completed',
      terminal: true,
      taskId,
    });
    expect(done.envelope.signin).toBeUndefined();
    expect(result.scope.encounterId).toBe(ENCOUNTER);
    expect(JSON.stringify(result)).toContain('"resourceType":"Bundle"');
    expect(html).toMatch(/^\s*</);
    expect(html).toContain('SYNTHETIC');
    expect(done.envelope.text).toContain('SYNTHETIC DEMO');
    expect(done.envelope.text).not.toContain('<');
    // task ids and user codes stay in stdout (the session), never on stderr
    for (const output of [sent.stderr, done.stderr]) {
      expect(output).not.toContain(taskId);
      expect(output).not.toContain(userCode);
    }
  });

  it('returns the HTML part byte for byte as Medissy encoded it', async () => {
    rig = await startMedissy();
    const io = testIo(rig.fetch, { clock: rig.clock });
    const sent = await run(['send', ORIGIN, '--data', CLINICAL], io);
    const taskId = sent.envelope.taskId as string;

    await new Browser(rig.harness.app).approveDevice(
      (sent.envelope.signin as { userCode: string }).userCode,
      'cardiologist',
    );
    rig.clock.advance(6);

    const got = await run(['get', ORIGIN, taskId], testIo(rig.fetch));
    const raw = await rig.fetch(`${ORIGIN}/a2a/v1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'GetTask',
        params: { id: taskId },
      }),
    });
    const task = (
      (await raw.json()) as {
        result: {
          artifacts: Array<{
            parts: Array<{ raw?: string; mediaType?: string }>;
          }>;
        };
      }
    ).result;
    const part = task.artifacts[0]?.parts.find(
      (item) => item.mediaType === 'text/html',
    );

    expect(got.envelope.state).toBe('completed');
    expect(got.envelope.html).toBe(
      Buffer.from(part?.raw ?? '', 'base64').toString('utf8'),
    );
  });

  it('stops waiting at the timeout while sign-in is pending, polling at the default 5 s interval', async () => {
    rig = await startMedissy();
    const sent = await run(
      ['send', ORIGIN, '--data', CLINICAL],
      testIo(rig.fetch),
    );
    const before = rig.fetched.length;
    const io = testIo(rig.fetch, { clock: rig.clock });

    const out = await run(
      ['wait', ORIGIN, sent.envelope.taskId as string, '--timeout', '20'],
      io,
    );
    const posts = rig.fetched
      .slice(before)
      .filter((url) => url.endsWith('/a2a/v1'));

    expect(out.code).toBe(0);
    expect(out.envelope).toMatchObject({
      state: 'auth-required',
      terminal: false,
      timedOut: true,
    });
    expect(out.envelope.signin).toBeDefined();
    expect(posts).toHaveLength(5);
  });

  it('gives each send a fresh messageId, so a repeated request never collides (-32602)', async () => {
    rig = await startMedissy();

    const first = await run(
      ['send', ORIGIN, '--data', CLINICAL],
      testIo(rig.fetch),
    );
    const second = await run(
      ['send', ORIGIN, '--data', CLINICAL],
      testIo(rig.fetch),
    );

    expect(first.envelope.state).toBe('auth-required');
    expect(second.envelope.state).toBe('auth-required');
    expect(second.envelope.taskId).not.toBe(first.envelope.taskId);
  });

  it('reports a JSON-RPC error from the agent, such as an unknown task, as an error envelope', async () => {
    rig = await startMedissy();

    const out = await run(['get', ORIGIN, 'A'.repeat(22)], testIo(rig.fetch));

    expect(out.code).toBe(1);
    expect(out.envelope).toMatchObject({
      state: 'error',
      error: { code: 'rpc-error', rpcCode: -32001 },
    });
    expect(out.stderr).toBe('');
  });

  it('reports a request the agent refuses, such as a skill its card does not list, without inventing a result', async () => {
    rig = await startMedissy();

    const out = await run(
      ['send', ORIGIN, '--data', '{"skill":"not-a-listed-skill"}'],
      testIo(rig.fetch),
    );

    expect(out.code).toBe(1);
    expect(out.envelope).toMatchObject({
      state: 'error',
      error: { code: 'rpc-error', rpcCode: -32602 },
    });
    expect(out.envelope.text).toMatch(/\S/);
    expect(out.envelope.taskId).toBeUndefined();
    expect(out.envelope.html).toBeUndefined();
  });
});

describe('a2a-client: protocol (CLI01)', () => {
  it('posts PascalCase JSON-RPC 2.0 with the A2A-Version 1.0 header to the endpoint the card names', async () => {
    const origin = 'https://agent.example';
    const { fetch, calls } = agentFetch(origin, () => ({
      result: {
        task: {
          id: 't-1',
          contextId: 'c-1',
          status: { state: 'TASK_STATE_WORKING' },
        },
      },
    }));

    await run(
      ['send', origin, '--text', 'hello'],
      testIo(fetch, { allowed: origin }),
    );
    await run(['get', origin, 't-1'], testIo(fetch, { allowed: origin }));

    const posts = calls.filter((call) => call.init?.method === 'POST');
    const [send, get] = bodiesOf(calls);

    expect(posts.map((call) => call.url)).toEqual([
      `${origin}/rpc`,
      `${origin}/rpc`,
    ]);
    for (const call of posts) {
      expect(new Headers(call.init?.headers).get('a2a-version')).toBe('1.0');
      expect(call.init?.redirect).toBe('manual');
    }
    expect(send).toMatchObject({
      jsonrpc: '2.0',
      method: 'SendMessage',
      params: { message: { role: 'ROLE_USER', parts: [{ text: 'hello' }] } },
    });
    expect(send?.params.message.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(get).toMatchObject({
      jsonrpc: '2.0',
      method: 'GetTask',
      params: { id: 't-1' },
    });
  });

  it('sends --data as a JSON data part and refuses data that is not a JSON object', async () => {
    const origin = 'https://agent.example';
    const { fetch, calls } = agentFetch(origin, () => ({
      result: {
        task: {
          id: 't-1',
          contextId: 'c-1',
          status: { state: 'TASK_STATE_WORKING' },
        },
      },
    }));

    await run(
      ['send', origin, '--data', '{"skill":"echo"}'],
      testIo(fetch, { allowed: origin }),
    );
    const bad = await run(
      ['send', origin, '--data', '[1,2]'],
      testIo(fetch, { allowed: origin }),
    );

    expect(bodiesOf(calls)[0]?.params.message.parts).toEqual([
      { data: { skill: 'echo' }, mediaType: 'application/json' },
    ]);
    expect(bad.code).toBe(2);
    expect(bad.envelope).toMatchObject({
      state: 'error',
      error: { code: 'usage' },
    });
    expect(bodiesOf(calls)).toHaveLength(1);
  });

  it('returns a direct message reply as a message envelope', async () => {
    const origin = 'https://agent.example';
    const { fetch } = agentFetch(origin, () => ({
      result: {
        message: {
          messageId: 'm-2',
          role: 'ROLE_AGENT',
          parts: [{ text: 'hi there' }],
        },
      },
    }));

    const out = await run(
      ['send', origin, '--text', 'hello'],
      testIo(fetch, { allowed: origin }),
    );

    expect(out.envelope).toEqual({
      state: 'message',
      terminal: true,
      text: 'hi there',
    });
  });

  it('strips control and bidi characters from text, keeps HTML unchanged and keeps only the sign-in fields a human needs', async () => {
    const origin = 'https://agent.example';
    const html = '<div>\u001b[31m<script>sendPrompt("x")</script>‮</div>';
    const { fetch } = agentFetch(origin, () => ({
      result: {
        id: 't-1',
        contextId: 'c-1',
        status: {
          state: 'TASK_STATE_COMPLETED',
          message: {
            parts: [
              { text: '<p>status html</p>', mediaType: 'text/html' },
              {
                text: 'Open\u001b]8;;evil\u0007 the page\r\n‮edoc\u0000 now\tplease',
              },
              {
                data: {
                  verificationUri: 'https://idp.example/device',
                  userCode: 'ABCD-EFGH\u001b[2J',
                  expiresAt: '2026-11-25T12:00:00.000Z',
                  taskDigest: 'ref-1',
                  device_code: 'secret-device-code',
                  verificationUriComplete:
                    'https://idp.example/device?user_code=ABCD-EFGH',
                },
                mediaType: 'application/vnd.example.signin+json',
              },
            ],
          },
        },
        artifacts: [
          {
            artifactId: 'a-1',
            parts: [
              {
                raw: Buffer.from(html, 'utf8').toString('base64'),
                mediaType: 'text/html',
                filename: 'card.html',
              },
            ],
          },
        ],
      },
    }));

    const out = await run(
      ['get', origin, 't-1'],
      testIo(fetch, { allowed: origin }),
    );

    expect(out.envelope.text).toBe('Open]8;;evil the page\nedoc now\tplease');
    expect(out.envelope.signin).toEqual({
      verificationUri: 'https://idp.example/device',
      userCode: 'ABCD-EFGH[2J',
      expiresAt: '2026-11-25T12:00:00.000Z',
    });
    expect(out.envelope.data).toBeUndefined();
    expect(out.envelope.html).toBe(html);
    expect(out.stdout).not.toContain('secret-device-code');
    expect(out.stdout).not.toContain('user_code=');
  });

  it('drops a sign-in whose verification URI is not an http(s) URL', async () => {
    const origin = 'https://agent.example';
    const { fetch } = agentFetch(origin, () => ({
      result: {
        id: 't-1',
        status: {
          state: 'TASK_STATE_AUTH_REQUIRED',
          message: {
            parts: [
              {
                data: { verificationUri: 'javascript:alert(1)', userCode: 'X' },
              },
            ],
          },
        },
      },
    }));

    const out = await run(
      ['get', origin, 't-1'],
      testIo(fetch, { allowed: origin }),
    );

    expect(out.envelope.signin).toBeUndefined();
    expect(out.stdout).not.toContain('javascript:');
  });

  it('polls at the interval a task part asks for', async () => {
    const origin = 'https://agent.example';
    const { fetch, calls } = agentFetch(origin, () => ({
      result: {
        id: 't-1',
        status: {
          state: 'TASK_STATE_WORKING',
          message: { parts: [{ data: { pollIntervalSeconds: 2 } }] },
        },
      },
    }));
    const io = testIo(fetch, { allowed: origin });

    const out = await run(['wait', origin, 't-1', '--timeout', '10'], io);

    expect(out.envelope).toMatchObject({ state: 'working', timedOut: true });
    expect(bodiesOf(calls)).toHaveLength(6);
  });

  it('stops waiting at input-required, which needs the human', async () => {
    const origin = 'https://agent.example';
    const { fetch, calls } = agentFetch(origin, () => ({
      result: {
        id: 't-1',
        status: {
          state: 'TASK_STATE_INPUT_REQUIRED',
          message: { parts: [{ text: 'Which one?' }] },
        },
      },
    }));

    const out = await run(
      ['wait', origin, 't-1'],
      testIo(fetch, { allowed: origin }),
    );

    expect(out.envelope).toMatchObject({
      state: 'input-required',
      terminal: false,
      text: 'Which one?',
    });
    expect(out.envelope.timedOut).toBeUndefined();
    expect(bodiesOf(calls)).toHaveLength(1);
  });
});

describe('a2a-client: refusals (CLI01)', () => {
  it('refuses an origin outside A2A_ALLOWED_ORIGINS without fetching', async () => {
    const { fetch, calls } = agentFetch('https://other.example', () => ({}));

    const out = await run(
      ['card', 'https://other.example'],
      testIo(fetch, { allowed: 'https://agent.example' }),
    );

    expect(out.code).toBe(1);
    expect(out.envelope).toMatchObject({
      state: 'error',
      error: { code: 'origin-not-allowed' },
    });
    expect(calls).toEqual([]);
  });

  it('refuses everything when A2A_ALLOWED_ORIGINS is unset', async () => {
    const { fetch, calls } = agentFetch('https://agent.example', () => ({}));
    const io = testIo(fetch);

    io.env = {};

    const out = await run(['card', 'https://agent.example'], io);

    expect(out.envelope).toMatchObject({
      state: 'error',
      error: { code: 'origin-not-allowed' },
    });
    expect(calls).toEqual([]);
  });

  it('refuses an http origin that is not localhost, even when allowlisted', async () => {
    const { fetch, calls } = agentFetch('http://agent.example', () => ({}));

    const out = await run(
      ['card', 'http://agent.example'],
      testIo(fetch, { allowed: 'http://agent.example' }),
    );

    expect(out.code).toBe(1);
    expect(out.envelope).toMatchObject({
      state: 'error',
      error: { code: 'insecure-origin' },
    });
    expect(calls).toEqual([]);
  });

  it('refuses an origin carrying credentials, a path or a query', async () => {
    const allowed = 'https://agent.example';
    const { fetch, calls } = agentFetch(allowed, () => ({}));

    for (const origin of [
      'https://user:pw@agent.example',
      'https://agent.example/x',
      'https://agent.example?q=1',
    ]) {
      const out = await run(['card', origin], testIo(fetch, { allowed }));

      expect(out.envelope).toMatchObject({
        state: 'error',
        error: { code: 'invalid-origin' },
      });
    }
    expect(calls).toEqual([]);
  });

  it('refuses a card whose JSON-RPC endpoint is on another origin, and never posts to it', async () => {
    const origin = 'https://agent.example';
    const card = {
      name: 'Hijack',
      supportedInterfaces: [
        {
          url: 'https://evil.example/rpc',
          protocolBinding: 'JSONRPC',
          protocolVersion: '1.0',
        },
      ],
      skills: [],
    };
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      calls.push(String(input));

      return new Response(JSON.stringify(card), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const out = await run(
      ['send', origin, '--text', 'hi'],
      testIo(fetchImpl, { allowed: origin }),
    );

    expect(out.envelope).toMatchObject({
      state: 'error',
      error: { code: 'invalid-card' },
    });
    expect(calls).toEqual([`${origin}/.well-known/agent-card.json`]);
  });

  it('refuses a card with no A2A 1.0 JSON-RPC interface', async () => {
    const origin = 'https://agent.example';
    const fetchImpl = jsonFetch({
      name: 'Old',
      supportedInterfaces: [
        {
          url: `${origin}/rpc`,
          protocolBinding: 'JSONRPC',
          protocolVersion: '0.3',
        },
      ],
      skills: [],
    });

    const out = await run(
      ['card', origin],
      testIo(fetchImpl, { allowed: origin }),
    );

    expect(out.envelope).toMatchObject({
      state: 'error',
      error: { code: 'invalid-card' },
    });
  });

  it('refuses a redirect and does not follow it', async () => {
    let targetHits = 0;

    stub = await stubServer((req, res) => {
      if (req.url === '/elsewhere') {
        targetHits += 1;
        res.end('{}');

        return;
      }

      res.writeHead(302, { location: '/elsewhere' });
      res.end();
    });

    const out = await run(
      ['card', stub.origin],
      testIo(fetch, { allowed: stub.origin }),
    );

    expect(out.code).toBe(1);
    expect(out.envelope).toMatchObject({
      state: 'error',
      error: { code: 'redirect-refused' },
    });
    expect(targetHits).toBe(0);
  });

  it('refuses an oversized response, declared or streamed', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 'a');

    stub = await stubServer((req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        ...(req.url?.includes('declared')
          ? {}
          : { 'transfer-encoding': 'chunked' }),
      });
      res.end(big);
    });

    const out = await run(
      ['card', stub.origin],
      testIo(fetch, { allowed: stub.origin }),
    );

    expect(out.code).toBe(1);
    expect(out.envelope).toMatchObject({
      state: 'error',
      error: { code: 'response-too-large' },
    });

    const declared = jsonFetch(
      {},
      { status: 200, headers: { 'content-length': String(big.length) } },
    );
    const viaHeader = await run(
      ['card', 'https://agent.example'],
      testIo(declared, { allowed: 'https://agent.example' }),
    );

    expect(viaHeader.envelope).toMatchObject({
      state: 'error',
      error: { code: 'response-too-large' },
    });
  });

  it('gives up on a response slower than A2A_REQUEST_TIMEOUT_MS', async () => {
    stub = await stubServer(() => {
      // never answers
    });
    const io = testIo(fetch, { allowed: stub.origin });

    io.env.A2A_REQUEST_TIMEOUT_MS = '100';

    const out = await run(['card', stub.origin], io);

    expect(out.envelope).toMatchObject({
      state: 'error',
      error: { code: 'timeout' },
    });
  });

  it('refuses a non-JSON or non-2xx response', async () => {
    const origin = 'https://agent.example';
    const html = (async () =>
      new Response('<html></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof fetch;
    const failed = jsonFetch(
      { error: 'nope' },
      { status: 500, headers: { 'content-type': 'application/json' } },
    );

    const notJson = await run(
      ['card', origin],
      testIo(html, { allowed: origin }),
    );
    const notOk = await run(
      ['card', origin],
      testIo(failed, { allowed: origin }),
    );

    expect(notJson.envelope).toMatchObject({
      state: 'error',
      error: { code: 'invalid-response' },
    });
    expect(notOk.envelope).toMatchObject({
      state: 'error',
      error: { code: 'http-error', status: 500 },
    });
  });

  it('refuses unknown commands, missing arguments and a malformed task id', async () => {
    const io = () =>
      testIo(jsonFetch({}), { allowed: 'https://agent.example' });

    const unknown = await run(['approve', 'https://agent.example'], io());
    const missing = await run(['send', 'https://agent.example'], io());
    const badId = await run(['get', 'https://agent.example', 'a b\nc'], io());

    for (const out of [unknown, missing, badId]) {
      expect(out.code).toBe(2);
      expect(out.envelope).toMatchObject({
        state: 'error',
        error: { code: 'usage' },
      });
    }
  });
});

/**
 * builds a task reply from a hostile or careless agent
 * @param task the task fields
 * @returns the JSON-RPC result
 */
function taskReply(task: Record<string, unknown>) {
  return () => ({ result: { id: 't-1', contextId: 'c-1', ...task } });
}

const INJECTION = [
  "t1'; touch /tmp/medissy-pwned; echo '",
  't1$(id)',
  't1`id`',
  't1 && id',
  't1\nid',
  't1"; id; "',
  'x'.repeat(129),
];

describe('a2a-client: review hardening (CLI01)', () => {
  it('refuses a task id with shell metacharacters from the agent, and never prints it', async () => {
    const origin = 'https://agent.example';

    for (const id of INJECTION) {
      for (const field of ['id', 'contextId'] as const) {
        const { fetch } = agentFetch(origin, () => ({
          result: {
            task: {
              id: 't-1',
              contextId: 'c-1',
              [field]: id,
              status: { state: 'TASK_STATE_WORKING' },
            },
          },
        }));

        const out = await run(
          ['send', origin, '--text', 'hi'],
          testIo(fetch, { allowed: origin }),
        );

        expect(out.code).toBe(1);
        expect(out.envelope).toMatchObject({
          state: 'error',
          error: { code: 'unsafe-id' },
        });
        expect(out.stdout).not.toContain(id.slice(2, 12));
      }
    }
  });

  it('refuses a task id argument with shell metacharacters before any request', async () => {
    const { fetch, calls } = agentFetch('https://agent.example', () => ({}));

    for (const id of INJECTION) {
      const out = await run(
        ['get', 'https://agent.example', id],
        testIo(fetch, { allowed: 'https://agent.example' }),
      );

      expect(out.code).toBe(2);
      expect(out.envelope).toMatchObject({
        state: 'error',
        error: { code: 'usage' },
      });
    }
    expect(calls).toEqual([]);
  });

  it('accepts base64url --data-b64 and quoted --data for a question with an apostrophe', async () => {
    const origin = 'https://agent.example';
    const data = {
      skill: 'echo',
      question: 'What\'s the patient\'s INR? <ok> & "fine"',
    };
    const { fetch, calls } = agentFetch(
      origin,
      taskReply({ status: { state: 'TASK_STATE_WORKING' } }),
    );

    await run(
      [
        'send',
        origin,
        '--data-b64',
        Buffer.from(JSON.stringify(data)).toString('base64url'),
      ],
      testIo(fetch, { allowed: origin }),
    );
    await run(
      ['send', origin, '--data', JSON.stringify(data)],
      testIo(fetch, { allowed: origin }),
    );

    for (const body of bodiesOf(calls)) {
      expect(body.params.message.parts).toEqual([
        { data, mediaType: 'application/json' },
      ]);
    }
    expect(bodiesOf(calls)).toHaveLength(2);
  });

  it('passes an apostrophe question intact through a real shell, both as --data-b64 and as --data quoted with the rule', async () => {
    const bodies: Array<Record<string, any>> = [];
    let origin = '';

    stub = await stubServer((req, res) => {
      const chunks: Buffer[] = [];

      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });

        if (req.method === 'POST') {
          const body = JSON.parse(
            Buffer.concat(chunks).toString('utf8'),
          ) as Record<string, any>;

          bodies.push(body);
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: {
                task: { id: 't-1', status: { state: 'TASK_STATE_WORKING' } },
              },
            }),
          );

          return;
        }

        res.end(
          JSON.stringify({
            name: 'Stub',
            supportedInterfaces: [
              {
                url: `${origin}/rpc`,
                protocolBinding: 'JSONRPC',
                protocolVersion: '1.0',
              },
            ],
          }),
        );
      });
    });
    origin = stub.origin;

    const data = { skill: 'echo', question: "What's Morgan's INR?" };
    const json = JSON.stringify(data);
    const b64 = Buffer.from(json).toString('base64url');
    // the SKILL.md rule: inside single quotes, write ' as '\''
    const quoted = `'${json.replaceAll("'", "'\\''")}'`;
    const env = { ...process.env, A2A_ALLOWED_ORIGINS: origin };

    for (const args of [`--data-b64 ${b64}`, `--data ${quoted}`]) {
      const { stdout } = await execFileAsync(
        '/bin/sh',
        ['-c', `"${process.execPath}" "${SCRIPT}" send ${origin} ${args}`],
        { env },
      );

      expect(JSON.parse(stdout)).toMatchObject({
        state: 'working',
        taskId: 't-1',
      });
    }
    expect(bodies.map((body) => body.params.message.parts[0].data)).toEqual([
      data,
      data,
    ]);
  });

  it('refuses --data-b64 that is not base64 of a JSON object', async () => {
    const { fetch, calls } = agentFetch('https://agent.example', () => ({}));

    for (const value of [
      'not base64!',
      Buffer.from('[1]').toString('base64url'),
      Buffer.from('nope').toString('base64url'),
    ]) {
      const out = await run(
        ['send', 'https://agent.example', '--data-b64', value],
        testIo(fetch, { allowed: 'https://agent.example' }),
      );

      expect(out.envelope).toMatchObject({
        state: 'error',
        error: { code: 'usage' },
      });
    }
    expect(calls).toEqual([]);
  });

  it('strips zero-width, directional, separator and BOM characters from text', async () => {
    const origin = 'https://agent.example';
    const sneaky = [
      0x200b, 0x200e, 0x200f, 0x061c, 0xfeff, 0x2028, 0x2029, 0x202e, 0x2066,
    ]
      .map((point) => `x${String.fromCodePoint(point)}`)
      .join('');
    const { fetch } = agentFetch(
      origin,
      taskReply({
        status: {
          state: 'TASK_STATE_COMPLETED',
          message: { parts: [{ text: sneaky }] },
        },
      }),
    );

    const out = await run(
      ['get', origin, 't-1'],
      testIo(fetch, { allowed: origin }),
    );

    expect(out.envelope.text).toBe('xxxxxxxxx');
  });

  it('cleans strings in data parts and drops device codes, prefilled links and token keys anywhere in them', async () => {
    const origin = 'https://agent.example';
    const rlo = String.fromCodePoint(0x202e);
    const { fetch } = agentFetch(
      origin,
      taskReply({
        status: {
          state: 'TASK_STATE_COMPLETED',
          message: {
            parts: [
              {
                data: {
                  note: `${rlo}gnp.exe\u0007`,
                  [`${rlo}key`]: 1,
                  device_code: 'DC-1',
                  nested: [
                    {
                      verification_uri_complete: 'https://x/?c=1',
                      access_token: 'AT-1',
                      idToken: 'IT-1',
                      keep: `a\u001bb`,
                    },
                  ],
                },
                mediaType: 'application/json',
              },
            ],
          },
        },
      }),
    );

    const out = await run(
      ['get', origin, 't-1'],
      testIo(fetch, { allowed: origin }),
    );

    expect(out.envelope.data).toEqual([
      {
        mediaType: 'application/json',
        data: { note: 'gnp.exe', key: 1, nested: [{ keep: 'ab' }] },
      },
    ]);
    expect(out.stdout).not.toMatch(/DC-1|AT-1|IT-1|c=1/);
  });

  it('refuses data nested deeper than it relays', async () => {
    const origin = 'https://agent.example';
    let deep: unknown = 'leaf';

    for (let level = 0; level < 100; level += 1) {
      deep = [deep];
    }

    const { fetch } = agentFetch(
      origin,
      taskReply({
        status: {
          state: 'TASK_STATE_COMPLETED',
          message: { parts: [{ data: { deep } }] },
        },
      }),
    );

    const out = await run(
      ['get', origin, 't-1'],
      testIo(fetch, { allowed: origin }),
    );

    expect(out.envelope).toMatchObject({
      state: 'error',
      error: { code: 'invalid-response' },
    });
  });

  it('takes html only from a completed task artifact, never from a status message or an unfinished task', async () => {
    const origin = 'https://agent.example';
    const raw = (html: string) => ({
      raw: Buffer.from(html).toString('base64'),
      mediaType: 'text/html',
    });
    const cases = [
      {
        state: 'TASK_STATE_COMPLETED',
        status: [raw('<p>status</p>')],
        artifact: [],
      },
      {
        state: 'TASK_STATE_AUTH_REQUIRED',
        status: [],
        artifact: [raw('<p>early</p>')],
      },
      {
        state: 'TASK_STATE_REJECTED',
        status: [],
        artifact: [raw('<p>rejected</p>')],
      },
    ];

    for (const item of cases) {
      const { fetch } = agentFetch(
        origin,
        taskReply({
          status: {
            state: item.state,
            message: { parts: [{ text: 'hello' }, ...item.status] },
          },
          artifacts: [{ artifactId: 'a', parts: item.artifact }],
        }),
      );

      const out = await run(
        ['get', origin, 't-1'],
        testIo(fetch, { allowed: origin }),
      );

      expect(out.envelope.html).toBeUndefined();
      expect(out.stdout).not.toContain('<p>');
    }
  });

  describe('image parts', () => {
    const origin = 'https://agent.example';
    const PNG = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
    ]);
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const image = (bytes: Buffer, mediaType = 'image/png') => ({
      raw: bytes.toString('base64'),
      mediaType,
      filename: 'qr.png',
    });
    const getWith = async (
      state: string,
      status: unknown[],
      artifact: unknown[],
    ) => {
      const { fetch } = agentFetch(
        origin,
        taskReply({
          status: { state, message: { parts: [{ text: 'hello' }, ...status] } },
          artifacts: [{ artifactId: 'a', parts: artifact }],
        }),
      );
      const io = testIo(fetch, { allowed: origin });

      return { io, out: await run(['get', origin, 't-1'], io) };
    };

    it('should save PNG and JPEG parts of a completed artifact and print only their paths', async () => {
      const { io, out } = await getWith(
        'TASK_STATE_COMPLETED',
        [],
        [image(PNG), image(JPEG, 'image/jpeg')],
      );

      expect(out.envelope.images).toEqual([
        { path: '/private/test/image-1.png', mediaType: 'image/png' },
        { path: '/private/test/image-2.jpg', mediaType: 'image/jpeg' },
      ]);
      expect(io.saved.map((item) => item.bytes)).toEqual([PNG, JPEG]);
      expect(out.stdout).not.toContain(PNG.toString('base64'));
    });

    it('should drop images from a status message, an unfinished task or a rejected task', async () => {
      const cases = [
        { state: 'TASK_STATE_COMPLETED', status: [image(PNG)], artifact: [] },
        {
          state: 'TASK_STATE_AUTH_REQUIRED',
          status: [],
          artifact: [image(PNG)],
        },
        { state: 'TASK_STATE_REJECTED', status: [], artifact: [image(PNG)] },
      ];

      for (const item of cases) {
        const { io, out } = await getWith(
          item.state,
          item.status,
          item.artifact,
        );

        expect(out.envelope.images).toBeUndefined();
        expect(io.saved).toEqual([]);
      }
    });

    it('should drop SVG, mislabelled, oversized and surplus image parts', async () => {
      const { io, out } = await getWith(
        'TASK_STATE_COMPLETED',
        [],
        [
          image(Buffer.from('<svg onload="x()"/>'), 'image/svg+xml'),
          image(JPEG, 'image/png'),
          image(Buffer.concat([PNG, Buffer.alloc(512 * 1024)])),
          ...Array.from({ length: 5 }, () => image(PNG)),
        ],
      );

      expect(io.saved).toHaveLength(4);
      expect(out.envelope.images as unknown[]).toHaveLength(4);
      expect(out.stdout).not.toContain('svg');
    });

    it('should save an image owner-only in a private directory by default', async () => {
      const { fetch } = agentFetch(
        origin,
        taskReply({
          status: { state: 'TASK_STATE_COMPLETED', message: { parts: [] } },
          artifacts: [{ artifactId: 'a', parts: [image(PNG)] }],
        }),
      );
      const io: Partial<TestIo> = testIo(fetch, { allowed: origin });

      delete io.saveImage;

      const out = await run(['get', origin, 't-1'], io as TestIo);
      const [saved] = out.envelope.images as Array<{ path: string }>;
      const path = saved?.path ?? '';

      try {
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
        expect(readFileSync(path)).toEqual(PNG);
      } finally {
        rmSync(dirname(path), { recursive: true, force: true });
      }
    });
  });

  it('keeps a sign-in only when its link is https or localhost http with no query or fragment', async () => {
    const origin = 'https://agent.example';
    const signinFor = async (verificationUri: string) => {
      const { fetch } = agentFetch(
        origin,
        taskReply({
          status: {
            state: 'TASK_STATE_AUTH_REQUIRED',
            message: {
              parts: [{ data: { verificationUri, userCode: 'ABCD-EFGH' } }],
            },
          },
        }),
      );

      return (
        await run(['get', origin, 't-1'], testIo(fetch, { allowed: origin }))
      ).envelope;
    };

    for (const uri of [
      'https://idp.example/device',
      'http://localhost:8080/device',
      'http://127.0.0.1/device',
    ]) {
      expect((await signinFor(uri)).signin).toMatchObject({
        verificationUri: uri,
      });
    }
    for (const uri of [
      'http://idp.example/device',
      'https://idp.example/device?user_code=ABCD-EFGH',
      'https://idp.example/device?',
      'https://idp.example/device#x',
      'https://u:p@idp.example/device',
      'ftp://idp.example/device',
    ]) {
      const envelope = await signinFor(uri);

      expect(envelope.signin).toBeUndefined();
      expect(envelope.data).toBeUndefined();
      expect(JSON.stringify(envelope)).not.toContain('ABCD-EFGH');
    }
  });

  it('reads a task id that starts with - or -- as the task id, not an option (base64url ids can)', async () => {
    const origin = 'https://agent.example';

    for (const id of ['-abc_DEF', '--abc', '-x']) {
      const { fetch, calls } = agentFetch(origin, () => ({
        result: { id, status: { state: 'TASK_STATE_WORKING' } },
      }));

      const got = await run(
        ['get', origin, id],
        testIo(fetch, { allowed: origin }),
      );
      const waited = await run(
        ['wait', origin, id, '--timeout', '1'],
        testIo(fetch, { allowed: origin }),
      );

      expect(got.envelope).toMatchObject({ state: 'working', taskId: id });
      expect(waited.envelope).toMatchObject({
        state: 'working',
        taskId: id,
        timedOut: true,
      });
      expect(bodiesOf(calls).map((body) => body.params.id)).toEqual([id, id]);
    }
  });

  it('refuses an option without a value, a repeated option and extra arguments', async () => {
    const { fetch, calls } = agentFetch('https://agent.example', () => ({}));
    const origin = 'https://agent.example';

    for (const args of [
      ['send', origin, '--text'],
      ['send', origin, '--text', 'a', '--text', 'b'],
      ['get', origin, 't-1', 'extra'],
      ['card', origin, 'extra'],
    ]) {
      const out = await run(args, testIo(fetch, { allowed: origin }));

      expect(out.envelope).toMatchObject({
        state: 'error',
        error: { code: 'usage' },
      });
    }
    expect(calls).toEqual([]);
  });

  it('exits 0 for a rejected or failed task, since the agent answered, and 1 only when the client refuses', async () => {
    const origin = 'https://agent.example';

    for (const state of ['TASK_STATE_REJECTED', 'TASK_STATE_FAILED']) {
      const { fetch } = agentFetch(
        origin,
        taskReply({
          status: {
            state,
            message: { parts: [{ text: 'Nothing was released.' }] },
          },
        }),
      );

      const out = await run(
        ['get', origin, 't-1'],
        testIo(fetch, { allowed: origin }),
      );

      expect(out.code).toBe(0);
      expect(out.envelope).toMatchObject({
        terminal: true,
        text: 'Nothing was released.',
      });
    }
  });
});

describe('a2a-client: script entry point (CLI01)', () => {
  it('runs as `node a2a.mjs` and prints one JSON envelope on stdout and nothing on stderr', async () => {
    stub = await stubServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          name: 'Stub',
          supportedInterfaces: [
            {
              url: 'http://localhost/rpc',
              protocolBinding: 'JSONRPC',
              protocolVersion: '1.0',
            },
          ],
          skills: [{ id: 'echo', name: 'Echo' }],
        }),
      );
    });

    const out = await runScript(['card', stub.origin], {
      A2A_ALLOWED_ORIGINS: stub.origin,
    });
    const refused = await runScript(['card', 'https://agent.example'], {
      A2A_ALLOWED_ORIGINS: stub.origin,
    });

    // the card names a localhost endpoint on another port: refused as cross-origin
    expect(out.envelope).toMatchObject({
      state: 'error',
      error: { code: 'invalid-card' },
    });
    expect(out.stdout.trim().split('\n')).toHaveLength(1);
    expect(out.stderr).toBe('');
    expect(refused.code).toBe(1);
    expect(refused.envelope).toMatchObject({
      state: 'error',
      error: { code: 'origin-not-allowed' },
    });
  });

  it('prints a valid card from a localhost agent as a script', async () => {
    let origin = '';

    stub = await stubServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          name: 'Stub',
          supportedInterfaces: [
            {
              url: `${origin}/rpc`,
              protocolBinding: 'JSONRPC',
              protocolVersion: '1.0',
            },
          ],
          skills: [{ id: 'echo', name: 'Echo' }],
        }),
      );
    });
    origin = stub.origin;

    const out = await runScript(['card', origin], {
      A2A_ALLOWED_ORIGINS: `https://x.example, ${origin}`,
    });

    expect(out.code).toBe(0);
    expect(out.envelope).toMatchObject({
      state: 'card',
      agent: { name: 'Stub', endpoint: `${origin}/rpc` },
    });
    expect(out.stderr).toBe('');
  });
});
