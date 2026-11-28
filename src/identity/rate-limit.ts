/**
 * per-client-IP fixed-window rate limits for the sign-in surface: each
 * synthetic issuer's (`/demo-idp`, `/institution-idp`) device pages,
 * authorization endpoint, account-picker POSTs and token endpoint, sharing
 * one counter per kind across both issuers, Medissy's `/auth/*` routes, and the A2A endpoint
 * (whose SendMessage starts device sign-ins); the counters live in a bounded
 * in-memory map (one process, ADR-1); the client IP is Fastify's
 * `request.ip`, which trusts at most the one proxy hop configured in
 * `createApp`; Medissy's own in-process calls to its issuer are exempt (see
 * `isExempt`); concurrent device sign-ins are capped globally by the device
 * flow's `maxPending` instead
 */
import { isIPv4, isIPv6 } from 'node:net';

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

/** IPv6 hextets kept for a client key: a /64, one end-user allocation */
const IPV6_PREFIX_HEXTETS = 4;
const IPV6_HEXTETS = 8;

/**
 * derives the key a per-client limit counts under; an IPv4 address (including an
 * IPv4-mapped IPv6 one) is its own key; an IPv6 address is keyed by its /64,
 * because one end user usually holds a whole /64 and could otherwise rotate
 * addresses to dodge a per-IP cap
 * @param ip the client IP as Fastify reports it
 * @returns the key the limit counts under
 */
export function clientKey(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];

  if (mapped && isIPv4(mapped)) {
    return mapped;
  }

  if (!isIPv6(ip)) {
    return ip;
  }

  const [head = '', tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill = ip.includes('::')
    ? Array<string>(IPV6_HEXTETS - left.length - right.length).fill('0')
    : [];
  const hextets = [...left, ...fill, ...right];

  return `${hextets
    .slice(0, IPV6_PREFIX_HEXTETS)
    .map((hextet) => hextet.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

const HTTP_TOO_MANY_REQUESTS = 429;
const MS_PER_SECOND = 1000;
const DEFAULT_MAX_KEYS = 10_000;
const MINUTE = 60;

/** one limit: at most `limit` requests per `windowSeconds` per client IP */
export interface RateRule {
  /** bucket name; requests matching rules of the same name share a counter */
  name: string;
  /** path prefix the rule covers (matched on the raw and decoded path) */
  prefix: string;
  /** HTTP methods covered; all methods when omitted */
  methods?: readonly string[];
  limit: number;
  windowSeconds: number;
}

/** where the synthetic issuers are mounted: the patient's and the institution's */
const ISSUER_MOUNTS = ['/demo-idp', '/institution-idp'] as const;

/**
 * lists the limits on one issuer's endpoints; both issuers use the same bucket
 * names, so a client gets one budget across them, not one each
 * @param mount where the issuer is mounted
 * @returns device, token, authorize and passphrase limits under that mount
 */
function issuerRules(mount: string): RateRule[] {
  return [
    {
      name: 'device',
      prefix: `${mount}/device`,
      limit: 30,
      windowSeconds: MINUTE,
    },
    {
      name: 'token',
      prefix: `${mount}/token`,
      limit: 60,
      windowSeconds: MINUTE,
    },
    {
      name: 'authorize',
      prefix: `${mount}/auth`,
      limit: 30,
      windowSeconds: MINUTE,
    },
    // passphrase attempts on the account picker; GETs of the page are free
    {
      name: 'passphrase',
      prefix: `${mount}/interaction/`,
      methods: ['POST'],
      limit: 10,
      windowSeconds: MINUTE,
    },
  ];
}

/** defaults, per client IP; the first matching rule applies */
export const DEFAULT_RATE_RULES: readonly RateRule[] = [
  ...ISSUER_MOUNTS.flatMap(issuerRules),
  { name: 'auth', prefix: '/auth/', limit: 30, windowSeconds: MINUTE },
  // A2A JSON-RPC: every SendMessage may start a device sign-in, and polls
  // (GetTask) share the bucket; the engine also caps pending sign-ins per IP
  {
    name: 'a2a',
    prefix: '/a2a/v1',
    methods: ['POST'],
    limit: 120,
    windowSeconds: MINUTE,
  },
];

/** options for the rate limiter */
export interface RateLimitOptions {
  rules?: readonly RateRule[];
  /** requests never counted, e.g. Medissy's own in-process issuer calls */
  isExempt?: (request: FastifyRequest) => boolean;
  /** most client/bucket counters held at once; the oldest go first */
  maxKeys?: number;
  now?: () => Date;
}

/** outcome of counting one request */
export interface RateDecision {
  allowed: boolean;
  /** seconds until the window resets */
  retryAfterSeconds: number;
}

/** counts requests per (rule, client) */
export interface RateLimiter {
  /** rule covering a request, if any */
  ruleFor(url: string, method?: string): RateRule | undefined;
  hit(rule: RateRule, client: string): RateDecision;
  /** counters currently held */
  readonly size: number;
}

interface Window {
  count: number;
  resetAt: number;
}

/**
 * returns the path of a URL, and its percent-decoded form when that differs
 * @param url the request URL
 * @returns the candidate paths
 */
function pathsOf(url: string): string[] {
  const path = url.split('?')[0] ?? '';

  try {
    const decoded = decodeURIComponent(path);

    return decoded === path ? [path] : [path, decoded];
  } catch {
    return [path];
  }
}

/**
 * builds a rate limiter
 * @param options rules, capacity and clock
 * @returns a limiter that counts hits in fixed windows
 */
export function createRateLimiter(options: RateLimitOptions = {}): RateLimiter {
  const rules = options.rules ?? DEFAULT_RATE_RULES;
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  const now = options.now ?? (() => new Date());
  const windows = new Map<string, Window>();

  const makeRoom = (at: number): void => {
    for (const [key, window] of windows) {
      if (window.resetAt <= at) {
        windows.delete(key);
      }
    }

    // still full: drop the oldest counters (Map keeps insertion order)
    for (const key of windows.keys()) {
      if (windows.size < maxKeys) {
        break;
      }

      windows.delete(key);
    }
  };

  return {
    ruleFor: (url, method = 'GET') =>
      rules.find(
        (rule) =>
          (!rule.methods || rule.methods.includes(method)) &&
          pathsOf(url).some((path) => path.startsWith(rule.prefix)),
      ),
    /**
     * counts one hit against a rule
     * @param rule the rule whose window is used
     * @param client the key of the calling client
     * @returns whether the hit is allowed and when to retry
     */
    hit(rule, client) {
      const at = now().getTime();
      const key = `${rule.name}\u0000${client}`;
      let window = windows.get(key);

      if (!window || window.resetAt <= at) {
        windows.delete(key);

        if (windows.size >= maxKeys) {
          makeRoom(at);
        }

        window = { count: 0, resetAt: at + rule.windowSeconds * MS_PER_SECOND };
        windows.set(key, window);
      }

      window.count += 1;

      return {
        allowed: window.count <= rule.limit,
        retryAfterSeconds: Math.ceil((window.resetAt - at) / MS_PER_SECOND),
      };
    },
    /** the number of windows currently held */
    get size() {
      return windows.size;
    },
  };
}

/**
 * enforces the limits on the root instance (not encapsulated), answering 429
 * with `Retry-After` once a client exceeds a rule
 * @param app the root Fastify instance
 * @param options rules, capacity and clock
 */
const rateLimit: FastifyPluginAsync<RateLimitOptions> = async (
  app,
  options,
) => {
  const limiter = createRateLimiter(options);

  app.addHook('onRequest', async (request: FastifyRequest, reply) => {
    const rule = limiter.ruleFor(request.url, request.method);

    if (!rule || options.isExempt?.(request)) {
      return;
    }

    const decision = limiter.hit(rule, clientKey(request.ip));

    if (!decision.allowed) {
      return reply
        .code(HTTP_TOO_MANY_REQUESTS)
        .header('retry-after', String(decision.retryAfterSeconds))
        .header('cache-control', 'no-store')
        .send({ error: 'rate_limited' });
    }
  });
};

(rateLimit as unknown as Record<symbol, boolean>)[Symbol.for('skip-override')] =
  true;

export const rateLimitPlugin = rateLimit;
