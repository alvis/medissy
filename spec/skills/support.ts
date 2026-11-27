/**
 * rig for the generic A2A client skill: an in-process Medissy (demo IdP,
 * A2A surface, seeded synthetic vault, a grant for the demo cardiologist)
 * listening on an ephemeral localhost port, plus the io the client runs
 * with; Medissy and its demo issuer are configured as `https://medissy.test`
 * (as deployed behind TLS), so the card endpoint and the sign-in link are
 * https; the test fetch carries each request over plain localhost HTTP with
 * that host
 */
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { join } from 'node:path';

import { createA2aSetup } from '../../src/a2a/plugin';
import { createDemoIdentity } from '../../src/demo-idp/compose';
import { DEMO_CARDIOLOGIST } from '../../src/demo-idp/users';
import { createApp } from '../../src/server';
import { answer, fakeModel } from '../disclosure/support';
import {
  HOST,
  PATIENT_ID,
  TEST_KEK,
  TEST_PASSPHRASES,
  testClock,
  vaultWithPatient,
} from '../identity/support';
import {
  fixtureRecords,
  grantFor,
  insertGrant,
  insertRecord,
} from '../policy/support';

import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { FastifyInstance } from 'fastify';

import type { ClientIo } from '../../skills/a2a-client/a2a.mjs';
import type { TestClock } from '../identity/support';

/** the origin the client is given for the in-process Medissy */
export const ORIGIN = `https://${HOST}`;
/** the encounter the demo cardiologist is granted */
export const ENCOUNTER = 'enc-skill-cardio';
/** path of the client script */
export const SCRIPT = join(
  import.meta.dirname,
  '..',
  '..',
  'skills',
  'a2a-client',
  'a2a.mjs',
);

const DEMO_ISSUER = `${ORIGIN}/demo-idp`;
const CLINICIAN_ISSUER = `${ORIGIN}/institution-idp`;
const DAY_MS = 86_400_000;

/** a running Medissy */
export interface MedissyRig {
  harness: { app: FastifyInstance };
  clock: TestClock;
  port: number;
  /** every URL the client fetched */
  fetched: string[];
  fetch: typeof fetch;
}

/**
 * builds a fetch over real localhost HTTP that addresses the app by its host and
 * never follows redirects
 * @param port the listening port
 * @param fetched collects every requested URL
 * @returns a fetch that talks to the local server without following redirects
 */
function localFetch(port: number, fetched: string[]): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);

    fetched.push(url.href);
    headers.set('host', HOST);

    return new Promise<Response>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: `${url.pathname}${url.search}`,
          method: init?.method ?? 'GET',
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
      req.end(init?.body as string | undefined);
    });
  };
}

/**
 * starts Medissy with a grant for the demo cardiologist on ENCOUNTER
 * @returns the rig
 */
export async function startMedissy(): Promise<MedissyRig> {
  const db = vaultWithPatient();
  const clock = testClock();

  for (const record of fixtureRecords) {
    insertRecord(db, record);
  }

  const served: { app?: FastifyInstance } = {};
  // issuer calls from Medissy to its own demo IdP stay in process
  const issuerFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const res = await served.app!.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST',
      url: `${url.pathname}${url.search}`,
      headers: {
        ...(init?.headers as Record<string, string> | undefined),
        host: url.host,
      },
      payload: typeof init?.body === 'string' ? init.body : undefined,
    });

    return new Response(res.statusCode === 204 ? null : res.rawPayload, {
      status: res.statusCode,
      headers: res.headers as Record<string, string>,
    });
  };
  const demo = await createDemoIdentity({
    db,
    publicUrl: ORIGIN,
    passphrases: TEST_PASSPHRASES,
    cookieKeys: ['test-only-cookie-key'],
    keyEncryptionKey: TEST_KEK,
    // the test browser talks plain HTTP to the listener
    secureCookies: false,
    fetch: issuerFetch,
    now: clock.now,
  });

  const app = await createApp({
    allowedHosts: [HOST],
    setup: [
      ...demo.setup,
      createA2aSetup({
        publicUrl: ORIGIN,
        deviceFlow: demo.deviceFlow,
        // a recording fake: no live model in tests
        selectorClient: fakeModel(() =>
          answer(['rec-cond-001', 'rec-obs-001', 'rec-dr-001']),
        ).client,
        clock: clock.now,
        db,
      }),
    ],
  });

  served.app = app;

  const harness = { app };
  const now = clock.now().getTime();

  db.prepare(
    `INSERT INTO encounters (id, patient_id, purpose, clinician_issuer, clinician_subject, starts_at, ends_at, status,
       created_by_issuer, created_by_subject, created_at)
     VALUES (?, ?, 'direct-treatment', ?, ?, ?, ?, 'active', ?, ?, ?)`,
  ).run(
    ENCOUNTER,
    PATIENT_ID,
    CLINICIAN_ISSUER,
    DEMO_CARDIOLOGIST.subject,
    new Date(now - DAY_MS).toISOString(),
    new Date(now + 30 * DAY_MS).toISOString(),
    DEMO_ISSUER,
    'synthetic-owner',
    new Date(now - DAY_MS).toISOString(),
  );
  insertGrant(
    db,
    grantFor({
      id: 'grant-skill',
      patientId: PATIENT_ID,
      grantee: { issuer: CLINICIAN_ISSUER, subject: DEMO_CARDIOLOGIST.subject },
      encounterId: ENCOUNTER,
      validFrom: new Date(now - DAY_MS).toISOString(),
      expiresAt: new Date(now + 7 * DAY_MS).toISOString(),
    }),
  );

  await harness.app.listen({ port: 0, host: '127.0.0.1' });

  const { port } = harness.app.server.address() as AddressInfo;
  const fetched: string[] = [];

  return { harness, clock, port, fetched, fetch: localFetch(port, fetched) };
}

/** what a client run printed */
export interface Captured {
  code: number;
  stdout: string;
  stderr: string;
  /** the parsed stdout envelope */
  envelope: Record<string, unknown>;
}

/** client io with captured streams */
export interface TestIo extends ClientIo {
  out: string[];
  err: string[];
  /** images the client saved, in order */
  saved: Array<{ bytes: Buffer; ext: string }>;
}

/**
 * builds client io over a fetch; sleeping moves the test clock instead of waiting
 * @param fetchImpl the transport
 * @param options the allowlist and the clock to advance
 * @param options.allowed the A2A_ALLOWED_ORIGINS value
 * @param options.clock the clock sleeping advances
 * @returns client io with captured output and a manual clock
 */
export function testIo(
  fetchImpl: typeof fetch,
  options: { allowed?: string; clock?: TestClock } = {},
): TestIo {
  const out: string[] = [];
  const err: string[] = [];
  const saved: Array<{ bytes: Buffer; ext: string }> = [];
  const start = Date.now();
  let elapsed = 0;

  return {
    out,
    err,
    saved,
    saveImage: (bytes, ext) => {
      saved.push({ bytes, ext });

      return `/private/test/image-${saved.length}.${ext}`;
    },
    fetch: fetchImpl,
    env: { A2A_ALLOWED_ORIGINS: options.allowed ?? ORIGIN },
    stdout: (text) => {
      out.push(text);
    },
    stderr: (text) => {
      err.push(text);
    },
    sleep: async (ms) => {
      elapsed += ms;
      options.clock?.advance(ms / 1000);
    },
    now: () => start + elapsed,
  };
}

/**
 * returns the captured output of an io
 * @param io the test io whose buffers are read
 * @param code the exit code
 * @returns the captured output
 */
export function captured(io: TestIo, code: number): Captured {
  const stdout = io.out.join('');

  return {
    code,
    stdout,
    stderr: io.err.join(''),
    envelope: JSON.parse(stdout || '{}') as Record<string, unknown>,
  };
}

/**
 * runs the client script as a child process
 * @param args the command line
 * @param env extra environment
 * @returns the captured output
 */
export async function runScript(
  args: string[],
  env: Record<string, string>,
): Promise<Captured> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { PATH: process.env.PATH ?? '', ...env },
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code: code ?? -1,
        stdout,
        stderr,
        envelope: JSON.parse(stdout || '{}') as Record<string, unknown>,
      });
    });
  });
}

/** a plain HTTP server answering every request with one handler */
export interface StubServer {
  origin: string;
  close(): Promise<void>;
}

/**
 * starts a stub HTTP server on localhost
 * @param handler answers every request
 * @returns the server and its localhost origin
 */
export async function stubServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<StubServer> {
  const server: Server = createServer(handler);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://localhost:${port}`,
    close: async () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/**
 * builds a fetch answering every request with one JSON body
 * @param body the body, or a function of the request URL
 * @param init the response options
 * @returns a fetch that resolves every request to that JSON body
 */
export function jsonFetch(
  body: unknown,
  init: ResponseInit = {
    status: 200,
    headers: { 'content-type': 'application/json' },
  },
): typeof fetch {
  return async () => new Response(JSON.stringify(body), init);
}
