#!/usr/bin/env node
/**
 * a generic A2A 1.0 JSON-RPC client for an OpenClaw skill; plain Node 24
 * ESM, no dependencies; it knows no agent: the only input is an agent
 * origin, which must be https (or http on localhost) and listed in
 * A2A_ALLOWED_ORIGINS; it holds no credentials; an agent that needs a
 * sign-in asks for it inside the task (AUTH_REQUIRED) and this client only
 * relays what a human must open and type
 *
 * usage:
 *   node a2a.mjs card <origin>
 *   node a2a.mjs send <origin> --data-b64 <base64url JSON object>
 *   node a2a.mjs send <origin> --data '<json object>' | --text '<text>'
 *   node a2a.mjs get  <origin> <taskId>
 *   node a2a.mjs wait <origin> <taskId> [--timeout <seconds>]
 *
 * every run prints exactly one JSON envelope on stdout:
 *   {state, text, terminal?, taskId?, contextId?, timedOut?, signin?, html?, images?, data?, agent?, error?}
 * exit codes: 0 when the agent answered, whatever the task state (a
 * rejected or failed task is an answer, read `state`); 1 when this client
 * refused or the call failed (`state: "error"`); 2 for a usage error;
 * nothing is written to stderr or logs: task ids are bearer capabilities;
 * the only files written are a completed task's PNG or JPEG artifact parts,
 * each checked against its magic bytes and size cap, saved owner-only in a
 * fresh private temporary directory so a chat client can attach them;
 * task and context ids are limited to a shell-safe charset, so pasting one
 * into a command can never run anything
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CARD_PATH = '/.well-known/agent-card.json';
const PROTOCOL_VERSION = '1.0';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_MS = 5_000;
const MIN_POLL_MS = 1_000;
const MAX_POLL_MS = 60_000;
const DEFAULT_WAIT_S = 120;
const MAX_WAIT_S = 900;
const MAX_ERROR_TEXT = 500;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const TERMINAL = new Set(['completed', 'failed', 'canceled', 'rejected']);
/** the states a wait keeps polling through */
const PENDING = new Set(['submitted', 'working', 'auth-required']);
/** shell-safe charset for task and context ids, from argv or a response */
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;
const MAX_DATA_DEPTH = 32;
/**
 * code point ranges stripped from remote text: C0 (except tab and newline),
 * DEL, C1, Arabic letter mark, zero-width and directional marks, line and
 * paragraph separators, bidi embeddings, overrides and isolates, and BOM
 */
const STRIPPED = [
  [0x00, 0x08],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
  [0x061c, 0x061c],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];
/** RFC 8628 and OAuth secrets never relayed from a data part */
const SECRET_KEY = /^(device_?code|verification_?uri_?complete)$|token/i;
/** image parts saved from a completed artifact: media type, extension and magic bytes */
const IMAGE_TYPES = new Map([
  ['image/png', { ext: 'png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
  ['image/jpeg', { ext: 'jpg', magic: [0xff, 0xd8, 0xff] }],
]);
/** largest image part saved, in decoded bytes */
const MAX_IMAGE_BYTES = 512 * 1024;
/** most image parts saved from one task */
const MAX_IMAGES = 4;

/** a refusal or failure, printed as an error envelope */
class ClientError extends Error {
  /**
   * @param {string} code stable error code
   * @param {string} message human-readable message, never carrying a task id
   * @param {Record<string, unknown>} [extra] further fields for the envelope
   * @param {number} [exitCode] the process exit code
   */
  constructor(code, message, extra = {}, exitCode = 1) {
    super(message);
    this.code = code;
    this.extra = extra;
    this.exitCode = exitCode;
  }
}

/**
 * removes characters that can drive a terminal or reorder text
 * @param {string} text remote text
 * @returns {string} the text without control characters
 */
function clean(text) {
  let out = '';

  for (const char of text) {
    const point = char.codePointAt(0) ?? 0;

    if (!STRIPPED.some(([low, high]) => point >= low && point <= high)) {
      out += char;
    }
  }

  return out;
}

/**
 * cleans every string in a data payload and drops secret-bearing keys
 * @param {unknown} value the payload
 * @param {number} [depth] the nesting depth
 * @returns {unknown} the cleaned payload
 */
function cleanData(value, depth = 0) {
  if (depth > MAX_DATA_DEPTH) {
    throw new ClientError('invalid-response', 'The agent answered with data nested too deeply.');
  }

  if (typeof value === 'string') {
    return clean(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => cleanData(item, depth + 1));
  }

  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !SECRET_KEY.test(key))
        .map(([key, item]) => [clean(key), cleanData(item, depth + 1)]),
    );
  }

  return value;
}

/**
 * returns true for an http(s) URL a human may open: https, or http on localhost,
 * with no credentials, query or fragment
 * @param {string} value the URL
 * @returns {boolean} whether it is acceptable
 */
function isSafeLink(value) {
  if (!URL.canParse(value)) {
    return false;
  }

  const url = new URL(value);
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname));

  return secure && !url.username && !url.password && !url.search && !url.hash && !value.includes('?') && !value.includes('#');
}

/**
 * throws a usage error
 * @param {string} message what is wrong
 * @returns {never} never returns
 */
function usage(message) {
  throw new ClientError('usage', message, {}, 2);
}

/**
 * parses and checks an agent origin against the allowlist
 * @param {string | undefined} value the origin argument
 * @param {Record<string, string | undefined>} env the environment
 * @returns {string} the normalized origin
 */
function checkOrigin(value, env) {
  if (!value) {
    usage('An agent origin is required.');
  }

  let url;

  try {
    url = new URL(value);
  } catch {
    throw new ClientError('invalid-origin', 'The agent origin is not a URL.');
  }

  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new ClientError('invalid-origin', 'Give the agent origin only (scheme, host and port), with no path, query or credentials.');
  }

  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname));

  if (!secure) {
    throw new ClientError('insecure-origin', 'The agent origin must use https (http is allowed for localhost only).');
  }

  const allowed = new Set(
    (env.A2A_ALLOWED_ORIGINS ?? '')
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((item) => {
        try {
          return new URL(item).origin;
        } catch {
          return '';
        }
      }),
  );

  if (!allowed.has(url.origin)) {
    throw new ClientError('origin-not-allowed', 'This agent origin is not in A2A_ALLOWED_ORIGINS.');
  }

  return url.origin;
}

/**
 * reads a body, refusing more than the cap
 * @param {Response} res the response
 * @returns {Promise<string>} the body text
 */
async function readCapped(res) {
  const declared = Number(res.headers.get('content-length') ?? '0');

  if (declared > MAX_RESPONSE_BYTES) {
    await res.body?.cancel();
    throw new ClientError('response-too-large', 'The agent response is too large.');
  }

  const chunks = [];
  let size = 0;

  if (res.body) {
    for await (const chunk of res.body) {
      size += chunk.byteLength;

      if (size > MAX_RESPONSE_BYTES) {
        throw new ClientError('response-too-large', 'The agent response is too large.');
      }

      chunks.push(chunk);
    }
  }

  return Buffer.concat(chunks).toString('utf8');
}

/**
 * fetches JSON with no redirects, a timeout and a size cap
 * @param {ClientIo} io the io
 * @param {string} url the URL
 * @param {RequestInit} [init] the request
 * @returns {Promise<unknown>} the parsed JSON
 */
async function fetchJson(io, url, init = {}) {
  const timeout = Number(io.env.A2A_REQUEST_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  let res;

  try {
    res = await io.fetch(url, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeout),
    });

    if ((res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect') {
      await res.body?.cancel();
      throw new ClientError('redirect-refused', 'The agent answered with a redirect; redirects are not followed.');
    }

    if (!res.ok) {
      await res.body?.cancel();
      throw new ClientError('http-error', `The agent answered HTTP ${res.status}.`, { status: res.status });
    }

    const json = /^application\/([\w.+-]+\+)?json\b/i.test(res.headers.get('content-type') ?? '');
    const text = await readCapped(res);

    if (!json) {
      throw new ClientError('invalid-response', 'The agent did not answer with JSON.');
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new ClientError('invalid-response', 'The agent answered with malformed JSON.');
    }
  } catch (error) {
    if (error instanceof ClientError) {
      throw error;
    }

    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new ClientError('timeout', 'The agent did not answer in time.');
    }

    throw new ClientError('network-error', 'The agent could not be reached.');
  }
}

/**
 * returns true for a plain object
 * @param {unknown} value anything
 * @returns {value is Record<string, any>} whether it is an object
 */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * fetches and validates the minimal shape of an Agent Card
 * @param {ClientIo} io the io
 * @param {string} origin the checked origin
 * @returns {Promise<{name: string, description: string, endpoint: string, skills: Array<Record<string, unknown>>}>} the card summary
 */
async function loadCard(io, origin) {
  const card = await fetchJson(io, `${origin}${CARD_PATH}`, {
    headers: { accept: 'application/json' },
  });

  if (!isObject(card) || typeof card.name !== 'string' || !Array.isArray(card.supportedInterfaces)) {
    throw new ClientError('invalid-card', 'The agent card is missing its name or interfaces.');
  }

  const binding = card.supportedInterfaces.find(
    (item) =>
      isObject(item) &&
      item.protocolBinding === 'JSONRPC' &&
      typeof item.protocolVersion === 'string' &&
      item.protocolVersion.split('.')[0] === PROTOCOL_VERSION.split('.')[0] &&
      typeof item.url === 'string',
  );

  if (!binding) {
    throw new ClientError('invalid-card', 'The agent card offers no A2A 1.0 JSON-RPC interface.');
  }

  let endpoint;

  try {
    endpoint = new URL(binding.url);
  } catch {
    throw new ClientError('invalid-card', 'The agent card endpoint is not a URL.');
  }

  if (endpoint.origin !== origin || endpoint.username || endpoint.password) {
    throw new ClientError('invalid-card', 'The agent card endpoint is not on the agent origin.');
  }

  const skills = (Array.isArray(card.skills) ? card.skills : [])
    .filter((skill) => isObject(skill) && typeof skill.id === 'string')
    .map((skill) => ({
      id: clean(skill.id),
      name: clean(typeof skill.name === 'string' ? skill.name : skill.id),
      description: clean(typeof skill.description === 'string' ? skill.description : ''),
      examples: (Array.isArray(skill.examples) ? skill.examples : [])
        .filter((example) => typeof example === 'string')
        .map(clean),
    }));

  return {
    name: clean(card.name),
    description: clean(typeof card.description === 'string' ? card.description : ''),
    endpoint: endpoint.href,
    skills,
  };
}

/**
 * calls a JSON-RPC method on the card's endpoint
 * @param {ClientIo} io the io
 * @param {string} endpoint the endpoint from the card
 * @param {string} method the PascalCase method
 * @param {Record<string, unknown>} params the params
 * @returns {Promise<unknown>} the result
 */
async function rpc(io, endpoint, method, params) {
  const reply = await fetchJson(io, endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'A2A-Version': PROTOCOL_VERSION,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
  });

  if (!isObject(reply)) {
    throw new ClientError('invalid-response', 'The agent answered with a malformed JSON-RPC reply.');
  }

  if (isObject(reply.error)) {
    const message = clean(String(reply.error.message ?? 'The agent refused the request.')).slice(0, MAX_ERROR_TEXT);

    throw new ClientError('rpc-error', message, {
      rpcCode: typeof reply.error.code === 'number' ? reply.error.code : undefined,
    });
  }

  if (!('result' in reply)) {
    throw new ClientError('invalid-response', 'The agent answered with no result.');
  }

  return reply.result;
}

/**
 * returns the client-facing state name: `TASK_STATE_AUTH_REQUIRED` -> `auth-required`
 * @param {unknown} state the A2A state
 * @returns {string} the short state
 */
function stateName(state) {
  return typeof state === 'string' && state.length > 0
    ? state.replace(/^TASK_STATE_/, '').toLowerCase().replaceAll('_', '-')
    : 'unknown';
}

/**
 * returns the first string among several keys
 * @param {Record<string, unknown>} data the object
 * @param {string[]} keys candidate keys
 * @returns {string | undefined} the value
 */
function pick(data, keys) {
  for (const key of keys) {
    if (typeof data[key] === 'string') {
      return data[key];
    }
  }

  return undefined;
}

/**
 * extracts a device sign-in (RFC 8628 vocabulary) a human must complete, keeping
 * only what they need: never a device code, a prefilled link or a token
 * @param {Record<string, unknown>} data a data part payload
 * @returns {{verificationUri: string, userCode: string, expiresAt?: string} | null | undefined} the sign-in, null for an unusable one, undefined when the part is no sign-in
 */
function signInOf(data) {
  const uri = pick(data, ['verificationUri', 'verification_uri']);
  const userCode = pick(data, ['userCode', 'user_code']);

  if (!uri && !userCode) {
    return undefined;
  }

  if (!uri || !userCode || !isSafeLink(uri)) {
    return null;
  }

  const expiresAt = pick(data, ['expiresAt', 'expires_at']);

  return {
    verificationUri: clean(uri),
    userCode: clean(userCode),
    ...(expiresAt ? { expiresAt: clean(expiresAt) } : {}),
  };
}

/**
 * decodes an HTML part exactly as sent
 * @param {Record<string, unknown>} part the part
 * @returns {string | undefined} the HTML
 */
function htmlOf(part) {
  if (!String(part.mediaType ?? '').toLowerCase().startsWith('text/html')) {
    return undefined;
  }

  if (typeof part.raw === 'string') {
    return Buffer.from(part.raw, 'base64').toString('utf8');
  }

  return typeof part.text === 'string' ? part.text : undefined;
}

/**
 * decodes a PNG or JPEG raw part whose bytes match its declared type
 * @param {Record<string, unknown>} part the part
 * @returns {{mediaType: string, ext: string, bytes: Buffer} | null | undefined} the image; null for an image part that fails its checks; undefined for a non-image part
 */
function imageOf(part) {
  const mediaType = String(part.mediaType ?? '').toLowerCase();

  if (!mediaType.startsWith('image/')) {
    return undefined;
  }

  const type = IMAGE_TYPES.get(mediaType);

  if (!type || typeof part.raw !== 'string' || !BASE64.test(part.raw)) {
    return null;
  }

  const bytes = Buffer.from(part.raw, 'base64');
  const matches = type.magic.every((byte, index) => bytes[index] === byte);

  return matches && bytes.length <= MAX_IMAGE_BYTES ? { mediaType, ext: type.ext, bytes } : null;
}

/**
 * sorts parts into the envelope's text, sign-in, html, images and data; HTML
 * and images are taken only from parts the caller marks as artifact
 * content (a completed task's artifacts); anywhere else they are dropped
 * @param {unknown[]} parts the parts, status message first
 * @param {(part: unknown) => boolean} [artifactAllowed] whether a part may carry html or an image
 * @returns {{text: string, signin?: object, html?: string, images?: Array<{mediaType: string, ext: string, bytes: Buffer}>, data?: Array<{mediaType?: string, data: unknown}>, pollMs?: number}} the content
 */
function contentOf(parts, artifactAllowed = () => false) {
  const texts = [];
  const data = [];
  const images = [];
  let signin;
  let html;
  let pollMs;

  for (const part of parts.filter(isObject)) {
    const markup = htmlOf(part);
    const image = markup === undefined ? imageOf(part) : undefined;

    if (markup !== undefined) {
      if (artifactAllowed(part)) {
        html ??= markup;
      }
    } else if (image !== undefined) {
      if (image && artifactAllowed(part) && images.length < MAX_IMAGES) {
        images.push(image);
      }
    } else if (typeof part.text === 'string') {
      texts.push(clean(part.text));
    } else if (isObject(part.data)) {
      const found = signInOf(part.data);
      const interval = part.data.pollIntervalSeconds ?? part.data.intervalSeconds ?? part.data.interval;

      if (typeof interval === 'number' && Number.isFinite(interval)) {
        pollMs = interval * 1000;
      }

      if (found) {
        signin ??= found;
      } else if (found === null) {
        // an unusable sign-in is dropped whole, never shown as data
      } else if (Object.keys(part.data).some((key) => !/interval/i.test(key))) {
        data.push({
          ...(typeof part.mediaType === 'string' ? { mediaType: clean(part.mediaType) } : {}),
          data: cleanData(part.data),
        });
      }
    }
  }

  return {
    text: texts.filter(Boolean).join('\n\n'),
    ...(signin ? { signin } : {}),
    ...(html === undefined ? {} : { html }),
    ...(images.length > 0 ? { images } : {}),
    ...(data.length > 0 ? { data } : {}),
    ...(pollMs === undefined ? {} : { pollMs }),
  };
}

/**
 * refuses an id that is not in the shell-safe charset
 * @param {unknown} value an id from a response
 * @returns {string} the id
 */
function safeRemoteId(value) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new ClientError(
      'unsafe-id',
      'The agent returned a task or context id outside the safe charset (letters, digits and . _ : -); it was not used.',
    );
  }

  return value;
}

/**
 * builds the envelope for a task
 * @param {unknown} task the task JSON
 * @returns {Record<string, unknown> & {pollMs?: number}} the envelope
 */
function taskEnvelope(task) {
  if (!isObject(task) || typeof task.id !== 'string') {
    throw new ClientError('invalid-response', 'The agent answered with a malformed task.');
  }

  const taskId = safeRemoteId(task.id);
  const contextId = task.contextId === undefined || task.contextId === '' ? undefined : safeRemoteId(task.contextId);

  const status = isObject(task.status) ? task.status : {};
  const message = isObject(status.message) && Array.isArray(status.message.parts) ? status.message.parts : [];
  const artifacts = (Array.isArray(task.artifacts) ? task.artifacts : [])
    .filter(isObject)
    .flatMap((artifact) => (Array.isArray(artifact.parts) ? artifact.parts : []));
  const state = stateName(status.state);
  const artifactParts = new Set(artifacts);

  return {
    state,
    terminal: TERMINAL.has(state),
    taskId,
    ...(contextId ? { contextId } : {}),
    ...contentOf([...message, ...artifacts], (part) => state === 'completed' && artifactParts.has(part)),
  };
}

/**
 * builds the envelope for a SendMessage result: a task or a direct message
 * @param {unknown} result the result
 * @returns {Record<string, unknown>} the envelope
 */
function sendEnvelope(result) {
  if (isObject(result) && isObject(result.message)) {
    const content = contentOf(Array.isArray(result.message.parts) ? result.message.parts : []);

    return withoutPoll({ state: 'message', terminal: true, ...content });
  }

  return withoutPoll(taskEnvelope(isObject(result) && isObject(result.task) ? result.task : result));
}

/**
 * drops the internal poll hint
 * @param {Record<string, unknown>} envelope an envelope
 * @returns {Record<string, unknown>} the envelope to print
 */
function withoutPoll(envelope) {
  const rest = { ...envelope };

  delete rest.pollMs;

  return rest;
}

/**
 * checks a task id argument
 * @param {string | undefined} value the argument
 * @returns {string} the task id
 */
function checkTaskId(value) {
  if (!value || !SAFE_ID.test(value)) {
    usage('A task id (1-128 letters, digits and . _ : - only) is required.');
  }

  return value;
}

/**
 * builds the message parts for `send`
 * @param {{data?: string, 'data-b64'?: string, text?: string}} values the options
 * @returns {Array<Record<string, unknown>>} the parts
 */
function sendParts(values) {
  const given = [values.data, values['data-b64'], values.text].filter((value) => value !== undefined);

  if (given.length !== 1) {
    usage('Give exactly one of --data-b64 <base64url json>, --data <json object> or --text <text>.');
  }

  if (values.text !== undefined) {
    return [{ text: values.text }];
  }

  const b64 = values['data-b64'];

  if (b64 !== undefined && !BASE64.test(b64)) {
    usage('--data-b64 must be base64url (or base64) of a JSON object.');
  }

  const json = b64 === undefined ? values.data : Buffer.from(b64, 'base64').toString('utf8');
  let data;

  try {
    data = JSON.parse(json);
  } catch {
    usage('--data must be a JSON object.');
  }

  if (!isObject(data)) {
    usage('--data must be a JSON object.');
  }

  return [{ data, mediaType: 'application/json' }];
}

/**
 * polls a task until it leaves a pending state or the wait times out
 * @param {ClientIo} io the io
 * @param {string} endpoint the endpoint
 * @param {string} taskId the task id
 * @param {number} seconds the wait budget
 * @returns {Promise<Record<string, unknown>>} the envelope
 */
async function waitFor(io, endpoint, taskId, seconds) {
  const deadline = io.now() + seconds * 1000;

  for (;;) {
    const envelope = taskEnvelope(await rpc(io, endpoint, 'GetTask', { id: taskId }));

    if (!PENDING.has(String(envelope.state))) {
      return withoutPoll(envelope);
    }

    const interval = Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, envelope.pollMs ?? DEFAULT_POLL_MS));

    if (io.now() + interval > deadline) {
      return { ...withoutPoll(envelope), timedOut: true };
    }

    await io.sleep(interval);
  }
}

/**
 * builds human-readable text for a card
 * @param {{name: string, description: string, skills: Array<{id: string, name: string, description: string}>}} agent the card summary
 * @returns {string} the text
 */
function cardText(agent) {
  return [
    `${agent.name}${agent.description ? `: ${agent.description}` : ''}`,
    ...agent.skills.map((skill) => `- ${skill.id} (${skill.name})${skill.description ? `: ${skill.description}` : ''}`),
  ].join('\n');
}

/** options that take a value */
const OPTIONS = new Set(['data', 'data-b64', 'text', 'timeout']);

/**
 * splits the command line into options and positionals; only the exact
 * option names above are options; any other token, including a task id
 * that starts with `-` (base64url ids can), is a positional
 * @param {string[]} argv the arguments after the script
 * @returns {{values: Record<string, string>, positionals: string[]}} the parsed command line
 */
function parseCommandLine(argv) {
  const values = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    const [flag, inline] = token.startsWith('--') ? [token.slice(2).split('=')[0], token.includes('=') ? token.slice(token.indexOf('=') + 1) : undefined] : [];

    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (flag === undefined || !OPTIONS.has(flag)) {
      positionals.push(token);
      continue;
    }

    const value = inline ?? argv[index + 1];

    if (value === undefined || flag in values) {
      usage(`--${flag} needs exactly one value.`);
    }

    values[flag] = value;
    index += inline === undefined ? 1 : 0;
  }

  return { values, positionals };
}

/**
 * runs one command
 * @param {string[]} argv the arguments after the script
 * @param {ClientIo} io the io
 * @returns {Promise<Record<string, unknown>>} the envelope
 */
async function execute(argv, io) {
  const parsed = parseCommandLine(argv);
  const [command, originArg, taskArg] = parsed.positionals;

  if (!['card', 'send', 'get', 'wait'].includes(command ?? '')) {
    usage('Unknown command. Use: card|send|get|wait <origin> ...');
  }

  if (parsed.positionals.length > (command === 'get' || command === 'wait' ? 3 : 2)) {
    usage('Too many arguments. Use: card|send|get|wait <origin> ...');
  }

  const parts = command === 'send' ? sendParts(parsed.values) : undefined;
  const taskId = command === 'get' || command === 'wait' ? checkTaskId(taskArg) : undefined;
  const wait = Number(parsed.values.timeout ?? DEFAULT_WAIT_S);

  if (!Number.isFinite(wait) || wait <= 0 || wait > MAX_WAIT_S) {
    usage(`--timeout must be between 1 and ${MAX_WAIT_S} seconds.`);
  }

  const origin = checkOrigin(originArg, io.env);
  const agent = await loadCard(io, origin);

  switch (command) {
    case 'card':
      return { state: 'card', text: cardText(agent), agent };
    case 'send':
      return sendEnvelope(
        await rpc(io, agent.endpoint, 'SendMessage', {
          message: { messageId: randomUUID(), role: 'ROLE_USER', parts },
        }),
      );
    case 'get':
      return withoutPoll(taskEnvelope(await rpc(io, agent.endpoint, 'GetTask', { id: taskId })));
    default:
      return waitFor(io, agent.endpoint, taskId, wait);
  }
}

/**
 * @typedef {object} ClientIo
 * @property {typeof fetch} fetch the transport
 * @property {Record<string, string | undefined>} env the environment
 * @property {(text: string) => void} stdout the envelope writer
 * @property {(text: string) => void} stderr unused for data; kept for symmetry
 * @property {(ms: number) => Promise<void>} sleep the wait between polls
 * @property {() => number} now the clock, in milliseconds
 * @property {(bytes: Buffer, ext: string) => string} [saveImage] the saver of one image, owner-only, returning its absolute path
 */

/**
 * saves an image owner-only in a fresh private temporary directory
 * @param {Buffer} bytes the checked image bytes
 * @param {string} ext the file extension
 * @returns {string} the absolute path
 */
function saveImageFile(bytes, ext) {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-client-'));

  chmodSync(dir, 0o700);

  const path = join(dir, `image.${ext}`);

  writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });

  return path;
}

/**
 * replaces the decoded images of an envelope with the paths they were saved
 * to; an image that cannot be saved is dropped
 * @param {Record<string, unknown>} envelope the envelope
 * @param {ClientIo} io the io
 * @returns {Record<string, unknown>} the envelope to print
 */
function withSavedImages(envelope, io) {
  if (!Array.isArray(envelope.images)) {
    return envelope;
  }

  const save = io.saveImage ?? saveImageFile;
  const images = envelope.images.flatMap((image) => {
    try {
      return [{ path: save(image.bytes, image.ext), mediaType: image.mediaType }];
    } catch {
      return [];
    }
  });
  const rest = { ...envelope };

  delete rest.images;

  return images.length > 0 ? { ...rest, images } : rest;
}

/**
 * runs the client and prints one envelope
 * @param {string[]} argv the arguments after the script
 * @param {ClientIo} io the io
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, io) {
  let envelope;
  let code = 0;

  try {
    envelope = withSavedImages(await execute(argv, io), io);
  } catch (error) {
    const failure =
      error instanceof ClientError ? error : new ClientError('internal', 'The client failed unexpectedly.');

    envelope = {
      state: 'error',
      text: failure.message,
      error: { code: failure.code, message: failure.message, ...failure.extra },
    };
    code = failure.exitCode;
  }

  io.stdout(`${JSON.stringify(envelope)}\n`);

  return code;
}

/**
 * returns true when this file is the script node was started with
 * @returns {boolean} whether to run
 */
function isEntryPoint() {
  if (import.meta.main !== undefined) {
    return import.meta.main;
  }

  try {
    return pathToFileURL(realpathSync(process.argv[1] ?? '')).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = await main(process.argv.slice(2), {
    fetch: globalThis.fetch,
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    sleep: async (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  });
}
