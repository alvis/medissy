/* eslint-disable max-lines, max-classes-per-file -- one small toolkit for the operator scripts: report, redaction, forms, browser, A2A */
/**
 * shared pieces of the operator scripts: step reporting with timings, a
 * redactor that keeps secrets out of every printed line, HTML form parsing,
 * a cookie-keeping browser locked to one origin, and a wrapper over the
 * generic A2A client skill (`skills/a2a-client/a2a.mjs`)
 */
import { main as a2aMain } from '../../skills/a2a-client/a2a.mjs';

/** the outcome of one checked step */
export type StepStatus = 'PASS' | 'FAIL' | 'NOT RUN' | 'MEASURED' | 'INFO';

/** one printed step */
export interface StepResult {
  id: string;
  title: string;
  /** acceptance criteria (brief §12) the step evidences */
  acceptance: readonly string[];
  status: StepStatus;
  /** elapsed milliseconds; undefined for a step that did not run */
  ms?: number;
  /** safe, already-redacted detail */
  detail?: string;
}

const MS_PER_SECOND = 1000;
const REDACTED = '[redacted]';
/** shortest value worth redacting; shorter ones would mangle ordinary text */
const MIN_REDACT_CHARS = 4;

/** a redactor that replaces every registered secret in text before it is printed */
export class Redactor {
  private readonly secrets = new Set<string>();

  /**
   * registers values that must never be printed
   * @param values passphrases, task ids, user codes, share links, tokens
   */
  public add(...values: Array<string | undefined>): void {
    for (const value of values) {
      if (value && value.length >= MIN_REDACT_CHARS) {
        this.secrets.add(value);
      }
    }
  }

  /**
   * removes every registered secret, longest first
   * @param text text about to be printed
   * @returns the text with secrets replaced
   */
  public scrub(text: string): string {
    return [...this.secrets]
      .sort((a, b) => b.length - a.length)
      .reduce((current, secret) => current.replaceAll(secret, REDACTED), text);
  }
}

/**
 * formats one step as a single report line
 * @param step the step
 * @returns e.g. `PASS     3 owner confirms through step-up [A07, A14] 4.2 s`
 */
export function formatStep(step: StepResult): string {
  const time = step.ms === undefined ? '' : ` ${(step.ms / MS_PER_SECOND).toFixed(1)} s`;
  const detail = step.detail ? ` :: ${step.detail}` : '';

  return `${step.status.padEnd(8)} ${step.id} ${step.title} [${step.acceptance.join(', ')}]${time}${detail}`;
}

/** a step runner that runs steps in order; after a failure the rest are NOT RUN */
export class StepRunner {
  public readonly results: StepResult[] = [];

  /**
   * @param redactor scrubs every detail before it is stored
   * @param print receives each formatted line
   * @param now the clock in milliseconds
   */
  constructor(
    private readonly redactor: Redactor,
    private readonly print: (line: string) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** whether any step has failed */
  public get failed(): boolean {
    return this.results.some((result) => result.status === 'FAIL');
  }

  /**
   * runs one step, timing it and catching its failure
   * @param step id, title and acceptance criteria
   * @param body the check; it returns a safe detail or throws
   * @param options.independent run even after an earlier failure
   * @returns the stored result
   */
  public async step(
    step: Pick<StepResult, 'id' | 'title' | 'acceptance'>,
    body: () => Promise<string | undefined>,
    options: { independent?: boolean } = {},
  ): Promise<StepResult> {
    if (this.failed && !options.independent) {
      return this.record({ ...step, status: 'NOT RUN', detail: 'an earlier step failed' });
    }

    const started = this.now();

    try {
      const detail = await body();

      return this.record({ ...step, status: 'PASS', ms: this.now() - started, detail });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown failure';

      return this.record({ ...step, status: 'FAIL', ms: this.now() - started, detail: message });
    }
  }

  /**
   * stores and prints a result whose status the caller decided
   * @param result the result
   * @returns the stored result
   */
  public record(result: StepResult): StepResult {
    const safe = {
      ...result,
      ...(result.detail === undefined ? {} : { detail: this.redactor.scrub(result.detail) }),
    };

    this.results.push(safe);
    this.print(formatStep(safe));

    return safe;
  }
}

/**
 * throws unless a condition holds
 * @param condition the condition
 * @param message a safe message (no secrets)
 */
export function check(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

// ---------------------------------------------------------------- forms ---

/** one parsed HTML form */
export interface ParsedForm {
  action: string;
  /** hidden inputs, unescaped */
  hidden: Record<string, string>;
  /** names of every input, select and textarea in the form */
  names: string[];
  body: string;
}

/**
 * undoes the HTML escaping the pages use
 * @param value escaped attribute text
 * @returns plain text
 */
export function unescapeHtml(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&#x27;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

/**
 * lists the attributes of one tag
 * @param tag the inside of a start tag
 * @returns attribute values by name, unescaped
 */
function attributes(tag: string): Record<string, string> {
  const found: Record<string, string> = {};

  // split on quotes: even pieces end in ` name=`, odd pieces are the values
  const pieces = tag.split('"');

  for (let index = 1; index < pieces.length; index += 2) {
    const before = (pieces[index - 1] ?? '').trimEnd();

    if (before.endsWith('=')) {
      const name = before.slice(0, -1).trim().split(/\s/).at(-1) ?? '';

      found[name.toLowerCase()] = unescapeHtml(pieces[index] ?? '');
    }
  }

  return found;
}

/**
 * lists every form in a page
 * @param html the page
 * @returns the forms in document order
 */
export function parseForms(html: string): ParsedForm[] {
  return [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)].map((match) => {
    const body = match[2] ?? '';
    const hidden: Record<string, string> = {};
    const names: string[] = [];

    for (const input of body.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
      const attrs = attributes(input[2] ?? '');

      if (attrs.name) {
        names.push(attrs.name);
      }

      if (input[1] === 'input' && attrs.type === 'hidden' && attrs.name) {
        hidden[attrs.name] = attrs.value ?? '';
      }
    }

    return { action: attributes(match[1] ?? '').action ?? '', hidden, names, body };
  });
}

/**
 * finds the form posting to a path, or the first form when no path is given
 * @param html the page
 * @param action the form action path to look for
 * @returns the form
 */
export function formIn(html: string, action?: string): ParsedForm {
  const forms = parseForms(html);
  const form = action === undefined ? forms[0] : forms.find((candidate) => candidate.action === action);

  check(form, action === undefined ? 'expected a form on the page' : `expected a form posting to ${action}`);

  return form;
}

// -------------------------------------------------------------- browser ---

/** one cookie update from a `Set-Cookie` header */
export interface CookieUpdate {
  name: string;
  value: string;
  /** true when the header clears the cookie */
  cleared: boolean;
}

/**
 * parses one `Set-Cookie` header
 * @param header the header value
 * @param now the current time
 * @returns the update, or undefined when malformed
 */
export function parseSetCookie(header: string, now = new Date()): CookieUpdate | undefined {
  const [pair = '', ...attrs] = header.split(';');
  const eq = pair.indexOf('=');

  if (eq <= 0) {
    return undefined;
  }

  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  const lower = attrs.map((attr) => attr.trim().toLowerCase());
  const maxAge = lower.find((attr) => attr.startsWith('max-age='));
  const expires = lower.find((attr) => attr.startsWith('expires='));
  const expired =
    (maxAge !== undefined && Number(maxAge.slice('max-age='.length)) <= 0) ||
    (expires !== undefined && Date.parse(expires.slice('expires='.length)) < now.getTime());

  return { name, value, cleared: value === '' || expired };
}

/** a fetched page */
export interface Page {
  status: number;
  /** the absolute URL that answered */
  url: string;
  location?: string;
  body: string;
}

const MAX_REDIRECTS = 15;
const REDIRECT_MIN = 300;
const REDIRECT_MAX = 400;

/** a cookie-keeping browser that only ever talks to one origin */
export class Browser {
  private readonly cookies = new Map<string, string>();

  /**
   * @param origin the only origin this browser may contact
   * @param redactor receives every cookie value, so none is ever printed
   * @param fetchImpl the transport
   */
  constructor(
    private readonly origin: string,
    private readonly redactor: Redactor,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * sends one request; redirects are not followed
   * @param method GET or POST
   * @param target a path or a same-origin absolute URL
   * @param form urlencoded fields (repeat a name with an array)
   * @returns the page
   */
  public async request(
    method: 'GET' | 'POST',
    target: string,
    form?: Record<string, string | string[]>,
  ): Promise<Page> {
    const url = new URL(target, this.origin);

    check(url.origin === this.origin, `refused to leave ${this.origin}`);

    const body = form ? new URLSearchParams() : undefined;

    for (const [name, value] of Object.entries(form ?? {})) {
      for (const item of [value].flat()) {
        body?.append(name, item);
      }
    }

    const res = await this.fetchImpl(url, {
      method,
      redirect: 'manual',
      headers: {
        ...(this.cookies.size > 0
          ? { cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ') }
          : {}),
        ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(body ? { body: body.toString() } : {}),
    });

    for (const header of res.headers.getSetCookie()) {
      const update = parseSetCookie(header);

      if (update?.cleared) {
        this.cookies.delete(update.name);
      } else if (update) {
        this.redactor.add(update.value);
        this.cookies.set(update.name, update.value);
      }
    }

    const location = res.headers.get('location') ?? undefined;

    return { status: res.status, url: url.href, body: await res.text(), ...(location ? { location } : {}) };
  }

  /**
   * follows redirects with GET until a non-redirect answer
   * @param page the page to start from
   * @returns the final page
   */
  public async follow(page: Page): Promise<Page> {
    let current = page;

    for (let hops = 0; hops < MAX_REDIRECTS; hops += 1) {
      if (current.status < REDIRECT_MIN || current.status >= REDIRECT_MAX || !current.location) {
        return current;
      }

      current = await this.request('GET', new URL(current.location, current.url).href);
    }

    throw new Error('too many redirects');
  }

  /**
   * fetches a page and follows its redirects
   * @param target a path or same-origin URL
   * @returns the final page
   */
  public async open(target: string): Promise<Page> {
    return this.follow(await this.request('GET', target));
  }
}

/**
 * submits the demo IdP account picker with a persona's passphrase
 * @param browser the browser
 * @param login the account picker page
 * @param persona the persona key
 * @param passphrase the persona's passphrase
 * @returns the page after following redirects
 */
export async function chooseAccount(
  browser: Browser,
  login: Page,
  persona: string,
  passphrase: string,
): Promise<Page> {
  const form = formIn(login.body);

  check(form.names.includes('passphrase'), 'expected the demo IdP passphrase form');

  return browser.follow(
    await browser.request('POST', new URL(form.action, login.url).href, {
      ...form.hidden,
      passphrase,
      account: persona,
    }),
  );
}

/**
 * approves a device sign-in at its verification URI (the institution's
 * `/institution-idp/device` for a clinician) as a person would: type
 * the code, confirm it, then pick the persona and type its passphrase
 * @param browser a browser for the person
 * @param signin the verification link and user code the agent relayed
 * @param signin.verificationUri the verification link
 * @param signin.userCode the user code
 * @param persona the persona key
 * @param passphrase the persona's passphrase
 */
export async function approveDevice(
  browser: Browser,
  signin: { verificationUri: string; userCode: string },
  persona: string,
  passphrase: string,
): Promise<void> {
  const input = await browser.open(signin.verificationUri);
  const inputForm = formIn(input.body);
  const confirm = await browser.request('POST', new URL(inputForm.action, input.url).href, {
    ...inputForm.hidden,
    user_code: signin.userCode,
  });
  const confirmForm = formIn(confirm.body);
  const login = await browser.follow(
    await browser.request('POST', new URL(confirmForm.action, confirm.url).href, confirmForm.hidden),
  );
  const done = await chooseAccount(browser, login, persona, passphrase);

  check(done.body.includes('Sign-in complete'), `the device sign-in did not complete (HTTP ${done.status})`);
}

/**
 * signs in to the owner or clinician portal through `/auth/<kind>/sign-in`;
 * the owner sign-in always asks the issuer for a fresh login (step-up)
 * @param browser the browser
 * @param kind owner or clinician
 * @param persona the persona key
 * @param passphrase the persona's passphrase
 * @returns the landing page
 */
export async function portalSignIn(
  browser: Browser,
  kind: 'owner' | 'clinician',
  persona: string,
  passphrase: string,
): Promise<Page> {
  const login = await browser.open(`/auth/${kind}/sign-in`);

  return chooseAccount(browser, login, persona, passphrase);
}

// ------------------------------------------------------------------ A2A ---

/** the envelope the A2A client skill prints */
export interface Envelope {
  state: string;
  text: string;
  terminal?: boolean;
  taskId?: string;
  timedOut?: boolean;
  signin?: { verificationUri: string; userCode: string; expiresAt?: string };
  html?: string;
  images?: Array<{ path: string; mediaType: string }>;
  data?: Array<{ mediaType?: string; data: unknown }>;
  agent?: { name: string; endpoint: string; skills: Array<{ id: string }> };
  error?: unknown;
}

/**
 * runs one command of the generic A2A client skill in-process and returns
 * its envelope; nothing is printed: the envelope carries task ids; images
 * the client accepts are kept in memory, never written to disk; their
 * `path` is a `memory:` label
 * @param origin the agent origin, the only one allowlisted
 * @param argv the client arguments, e.g. `['card', origin]`
 * @param fetchImpl the transport
 * @returns the envelope
 */
export async function a2a(origin: string, argv: string[], fetchImpl: typeof fetch = fetch): Promise<Envelope> {
  let out = '';
  let saved = 0;

  await a2aMain(argv, {
    fetch: fetchImpl,
    env: { A2A_ALLOWED_ORIGINS: origin },
    stdout: (text) => {
      out += text;
    },
    stderr: () => undefined,
    sleep: async (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    saveImage: (_bytes, ext) => {
      saved += 1;

      return `memory:image-${saved}.${ext}`;
    },
  });

  return JSON.parse(out) as Envelope;
}

/* eslint-enable max-lines, max-classes-per-file */
