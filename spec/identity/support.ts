import { newTaskId } from '../../src/contracts';
import { createDemoIdentity } from '../../src/demo-idp/compose';
import {
  DEMO_OWNER,
  INSTITUTION_ISSUER,
  ISSUER_PROFILES,
} from '../../src/demo-idp/users';
import { createApp } from '../../src/server';
import { openVault } from '../../src/vault/migrate';

import type { DatabaseSync } from 'node:sqlite';

import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

import type { DemoIdentity } from '../../src/demo-idp/compose';
import type { DeviceSignIn } from '../../src/identity/device-flow';
import type { RateRule } from '../../src/identity/rate-limit';
import type { AppSetup } from '../../src/server';

export const PUBLIC_URL = 'http://medissy.test';
export const HOST = 'medissy.test';
export const PATIENT_ID = '7b1f4c2e-5d3a-4e8b-9a61-2c0d8f4e1a35';
const NULL_BODY = new Set([101, 204, 205, 304]);

/** synthetic, test-only demo passphrases by persona key */
export const TEST_PASSPHRASES: Readonly<Record<string, string>> = {
  'owner': 'test-only-owner-passphrase',
  'cardiologist': 'test-only-cardiologist-pass',
  'dentist': 'test-only-dentist-passphrase',
  'unknown-clinician': 'test-only-unknown-clinician',
};

/** test-only key-encryption key for the stored signing key */
export const TEST_KEK = Buffer.alloc(32, 7);

/** a clock tests can move forward */
export interface TestClock {
  now: () => Date;
  advance(seconds: number): void;
}

/**
 * builds a clock starting at the real time
 * @returns a clock tests can advance by hand
 */
export function testClock(): TestClock {
  let offset = 0;

  return {
    now: () => new Date(Date.now() + offset),
    advance: (seconds) => {
      offset += seconds * 1000;
    },
  };
}

/** everything a test needs: app, vault, identity and the issuer traffic */
export interface Harness {
  app: FastifyInstance;
  db: DatabaseSync;
  demo: DemoIdentity;
  clock: TestClock;
  /** bodies of every token-endpoint response the server received */
  tokenResponses: Array<Record<string, unknown>>;
  /** count of calls made by the server to issuer endpoints */
  issuerCalls: { count: number };
}

/**
 * converts a light-my-request response into a fetch Response
 * @param res the injected response
 * @returns the fetch response
 */
function toResponse(res: LightMyRequestResponse): Response {
  const headers = new Headers();

  for (const [name, value] of Object.entries(res.headers)) {
    for (const item of [value].flat()) {
      if (item !== undefined) {
        headers.append(name, String(item));
      }
    }
  }

  return new Response(NULL_BODY.has(res.statusCode) ? null : res.rawPayload, {
    status: res.statusCode,
    headers,
  });
}

/**
 * builds an in-memory vault with the synthetic patient owned by the demo owner
 * @returns a vault holding the synthetic patient and its owner
 */
export function vaultWithPatient(): DatabaseSync {
  const db = openVault(':memory:');

  db.prepare(
    `INSERT INTO patient (id, label, owner_issuer, owner_subject, created_at) VALUES (?, 'SYNTHETIC patient', ?, ?, ?)`,
  ).run(
    PATIENT_ID,
    `${PUBLIC_URL}/demo-idp`,
    DEMO_OWNER.subject,
    new Date().toISOString(),
  );

  return db;
}

/**
 * inserts an unbound AUTH_REQUIRED task for the synthetic patient
 * @param db the vault
 * @returns the new task id
 */
export function insertTask(db: DatabaseSync): string {
  const id = newTaskId();
  const now = new Date();

  db.prepare(
    `INSERT INTO a2a_tasks (id, context_id, patient_id, origin_message_id, state, status_json, created_at, updated_at, expires_at)
     VALUES (?, 'ctx-1', ?, ?, 'TASK_STATE_AUTH_REQUIRED', '{"state":"TASK_STATE_AUTH_REQUIRED"}', ?, ?, ?)`,
  ).run(
    id,
    PATIENT_ID,
    `msg-${id}`,
    now.toISOString(),
    now.toISOString(),
    new Date(now.getTime() + 86_400_000).toISOString(),
  );

  return id;
}

/** what a test passes to `createHarness` */
export interface HarnessOptions {
  /** route setups built once the identity exists */
  setup?: (demo: DemoIdentity) => AppSetup[];
  /** vault to reuse (e.g. to simulate a restart) */
  db?: DatabaseSync;
  clock?: TestClock;
  rateRules?: readonly RateRule[];
  passphrases?: Readonly<Record<string, string | undefined>>;
}

/**
 * builds the app with the demo identity; issuer calls go through `inject`
 * @param extra additional setups, vault, clock, limits and passphrases
 * @returns the running app with its clock, vault and helpers
 */
export async function createHarness(
  extra: HarnessOptions = {},
): Promise<Harness> {
  const db = extra.db ?? vaultWithPatient();
  const clock = extra.clock ?? testClock();
  const tokenResponses: Array<Record<string, unknown>> = [];
  const issuerCalls = { count: 0 };
  // eslint-disable-next-line prefer-const -- assigned after the fetch closure that reads it
  let app: FastifyInstance | undefined;

  const fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    if (!app) {
      throw new Error('app not ready');
    }

    issuerCalls.count += 1;

    const url = new URL(input instanceof Request ? input.url : input);
    const res = await app.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST',
      url: `${url.pathname}${url.search}`,
      headers: {
        ...(init?.headers as Record<string, string> | undefined),
        host: url.host,
      },
      payload: typeof init?.body === 'string' ? init.body : undefined,
    });

    if (url.pathname.endsWith('/token')) {
      tokenResponses.push(res.json());
    }

    return toResponse(res);
  };

  const demo = await createDemoIdentity({
    db,
    publicUrl: PUBLIC_URL,
    passphrases: extra.passphrases ?? TEST_PASSPHRASES,
    cookieKeys: ['test-only-cookie-key'],
    keyEncryptionKey: TEST_KEK,
    rateRules: extra.rateRules,
    fetch,
    now: clock.now,
  });

  app = await createApp({
    allowedHosts: [HOST],
    setup: [...demo.setup, ...(extra.setup?.(demo) ?? [])],
  });

  return { app, db, demo, clock, tokenResponses, issuerCalls };
}

/**
 * strips the public origin from a URL
 * @param location an absolute or relative URL
 * @returns the path and query
 */
export function pathOf(location: string): string {
  const url = new URL(location, PUBLIC_URL);

  return `${url.pathname}${url.search}`;
}

/**
 * unescapes the entities the pages use
 * @param value escaped attribute text
 * @returns the plain text
 */
function unescape(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

/**
 * lists the hidden inputs of the first form in a page
 * @param html the page
 * @returns the hidden field values by name
 */
export function hiddenFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};

  for (const match of html.matchAll(
    /<input type="hidden" name="([^"]+)" value="([^"]*)"/g,
  )) {
    fields[match[1] ?? ''] = unescape(match[2] ?? '');
  }

  return fields;
}

/**
 * returns the `action` of the first form in a page
 * @param html the page
 * @returns the form action path
 */
export function formAction(html: string): string {
  const match = /<form[^>]*action="([^"]+)"/.exec(html);

  if (!match?.[1]) {
    throw new Error('no form in page');
  }

  return pathOf(unescape(match[1]));
}

/** a cookie-keeping browser over `app.inject` */
/**
 * returns the mount of the issuer that holds an account: the owner at `/demo-idp`,
 * Northgate staff at `/institution-idp`
 * @param account the account key
 * @returns the issuer mount (the institution for an unknown key)
 */
export function issuerMountOf(account: string): string {
  return (
    ISSUER_PROFILES.find((profile) =>
      profile.users.some((user) => user.key === account),
    )?.mount ?? INSTITUTION_ISSUER.mount
  );
}

/** the institution issuer URL in the test harness */
export const INSTITUTION_URL = `${PUBLIC_URL}${INSTITUTION_ISSUER.mount}`;

export class Browser {
  public readonly cookies = new Map<string, string>();

  /**
   * @param app the app under test
   * @param ip the client address this browser connects from
   */
  constructor(
    private readonly app: FastifyInstance,
    private readonly ip = '127.0.0.1',
  ) {}

  /**
   * sends one request, storing cookies; redirects are not followed
   * @param method HTTP method
   * @param url path or absolute URL
   * @param form urlencoded form fields
   * @returns the response
   */
  public async request(
    method: 'GET' | 'POST',
    url: string,
    form?: Record<string, string>,
  ): Promise<LightMyRequestResponse> {
    const res = await this.app.inject({
      method,
      url: pathOf(url),
      remoteAddress: this.ip,
      headers: {
        host: HOST,
        cookie: [...this.cookies]
          .map(([name, value]) => `${name}=${value}`)
          .join('; '),
        ...(form
          ? { 'content-type': 'application/x-www-form-urlencoded' }
          : {}),
      },
      payload: form ? new URLSearchParams(form).toString() : undefined,
    });

    for (const cookie of res.cookies as Array<{
      name: string;
      value: string;
      expires?: Date;
      maxAge?: number;
    }>) {
      const cleared =
        cookie.value === '' ||
        cookie.maxAge === 0 ||
        (cookie.expires !== undefined && cookie.expires.getTime() < Date.now());

      if (cleared) {
        this.cookies.delete(cookie.name);
      } else {
        this.cookies.set(cookie.name, cookie.value);
      }
    }

    return res;
  }

  /**
   * follows redirects with GET until a non-redirect response
   * @param res the response to start from
   * @returns the final response
   */
  public async follow(
    res: LightMyRequestResponse,
  ): Promise<LightMyRequestResponse> {
    let current = res;

    for (let hops = 0; hops < 10; hops += 1) {
      const location = current.headers.location;

      if (current.statusCode < 300 || current.statusCode >= 400 || !location) {
        return current;
      }

      current = await this.request('GET', String(location));
    }

    throw new Error('too many redirects');
  }

  /**
   * picks a synthetic account on the demo IdP's interaction page
   * @param page the interaction page response
   * @param account the account key
   * @param passphrase the persona's passphrase (the test one by default)
   * @returns the response after following redirects
   */
  public async chooseAccount(
    page: LightMyRequestResponse,
    account: string,
    passphrase = TEST_PASSPHRASES[account] ?? '',
  ): Promise<LightMyRequestResponse> {
    const { _csrf } = hiddenFields(page.body);
    const res = await this.request('POST', formAction(page.body), {
      _csrf: _csrf ?? '',
      passphrase,
      account,
    });

    return this.follow(res);
  }

  /**
   * approves a device sign-in as the given account, typing the user code
   * @param userCode the code the agent showed
   * @param account the account key
   * @param mount the issuer the code was issued by; the account's own by default
   * @returns the final page
   */
  public async approveDevice(
    userCode: string,
    account: string,
    mount = issuerMountOf(account),
  ): Promise<LightMyRequestResponse> {
    const login = await this.openDeviceLogin(userCode, mount);

    return this.chooseAccount(login, account);
  }

  /**
   * types the user code at the verification page
   * @param userCode the code the agent showed
   * @param mount the issuer the code was issued by (the institution by default)
   * @returns the confirmation page
   */
  public async enterUserCode(
    userCode: string,
    mount = INSTITUTION_ISSUER.mount,
  ): Promise<LightMyRequestResponse> {
    const input = await this.request('GET', `${mount}/device`);

    return this.request('POST', formAction(input.body), {
      ...hiddenFields(input.body),
      user_code: userCode,
    });
  }

  /**
   * walks from typing the code through its confirmation to the login page
   * @param userCode the code the agent showed
   * @param mount the issuer the code was issued by (the institution by default)
   * @returns the interaction (account picker) page
   */
  public async openDeviceLogin(
    userCode: string,
    mount = INSTITUTION_ISSUER.mount,
  ): Promise<LightMyRequestResponse> {
    const confirm = await this.enterUserCode(userCode, mount);
    const next = await this.request(
      'POST',
      formAction(confirm.body),
      hiddenFields(confirm.body),
    );

    return this.follow(next);
  }

  /**
   * signs into the portal through the browser flow
   * @param kind owner or clinician
   * @param account the account key
   * @returns the callback response (not followed)
   */
  public async signIn(
    kind: 'owner' | 'clinician',
    account: string,
  ): Promise<LightMyRequestResponse> {
    const login = await this.follow(
      await this.request('GET', `/auth/${kind}/sign-in`),
    );
    const { _csrf } = hiddenFields(login.body);
    let res = await this.request('POST', formAction(login.body), {
      _csrf: _csrf ?? '',
      passphrase: TEST_PASSPHRASES[account] ?? '',
      account,
    });

    // follow until the callback answers
    for (let hops = 0; hops < 10; hops += 1) {
      const location = res.headers.location;

      if (!location || pathOf(String(location)).startsWith('/portal')) {
        break;
      }

      if (pathOf(String(location)).startsWith('/clinician')) {
        break;
      }

      res = await this.request('GET', String(location));
    }

    return res;
  }
}

/** the synthetic task context every test sign-in carries */
export const TEST_CONTEXT = {
  encounterLabel: 'Cardiology review (SYNTHETIC)',
  question: 'Any prior cardiac findings relevant to chest pain?',
} as const;

/**
 * creates a task and starts a device sign-in for it
 * @param harness the app to start the sign-in on
 * @returns the task id and what the agent would show
 */
export async function startSignIn(
  harness: Harness,
): Promise<{ taskId: string; started: DeviceSignIn }> {
  const taskId = insertTask(harness.db);
  const started = await harness.demo.deviceFlow.start({
    taskId,
    ...TEST_CONTEXT,
  });

  return { taskId, started };
}
