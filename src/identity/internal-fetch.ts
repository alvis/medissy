/**
 * Medissy's calls to its own issuer (device authorization, device-code polls,
 * the portal's code exchange) run in-process through `app.inject` instead of
 * going out through the public URL and the proxy; they then never share a
 * client IP's rate-limit bucket: each carries a per-process random marker that
 * `isInternal` recognises, and no outside caller can know it; calls to any
 * other origin (an external IdP, ADR-3) use the real `fetch`
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { Fetch } from './issuer';

/** request header carrying the in-process marker */
const MARKER_HEADER = 'x-medissy-internal';
const MARKER_BYTES = 32;
/** statuses whose responses must not have a body */
const HTTP_SWITCHING_PROTOCOLS = 101;
const HTTP_NO_CONTENT = 204;
const HTTP_RESET_CONTENT = 205;
const HTTP_NOT_MODIFIED = 304;
const NULL_BODY = new Set([
  HTTP_SWITCHING_PROTOCOLS,
  HTTP_NO_CONTENT,
  HTTP_RESET_CONTENT,
  HTTP_NOT_MODIFIED,
]);

/** an in-process HTTP client for the app's own origin */
export interface InternalCaller {
  /** drop-in `fetch`: own-origin URLs go through `app.inject` */
  fetch: Fetch;
  /** attaches the app once it exists (in a setup) */
  bind(app: FastifyInstance): void;
  /** checks whether a request came from `fetch` above */
  isInternal(request: FastifyRequest): boolean;
}

/**
 * flattens fetch headers into a plain object
 * @param headers fetch init headers
 * @returns lower-case header names and values
 */
function plainHeaders(headers: RequestInit['headers']): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries());
}

/**
 * builds the in-process caller for one public origin
 * @param publicUrl Medissy's public URL
 * @param external the client for every other origin
 * @returns the caller that routes same-origin requests in process
 */
export function createInternalCaller(
  publicUrl: string,
  external: Fetch = globalThis.fetch,
): InternalCaller {
  const origin = new URL(publicUrl).origin;
  const marker = randomBytes(MARKER_BYTES).toString('base64url');
  const expected = Buffer.from(marker);
  let app: FastifyInstance | undefined;

  const fetch: Fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);

    if (url.origin !== origin || !app) {
      return external(input, init);
    }

    const res = await app.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST',
      url: `${url.pathname}${url.search}`,
      headers: {
        ...plainHeaders(init?.headers),
        host: url.host,
        [MARKER_HEADER]: marker,
      },
      payload: typeof init?.body === 'string' ? init.body : undefined,
    });
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
  };

  return {
    fetch,
    /**
     * attaches the app that serves in-process requests
     * @param instance the Fastify instance to inject into
     */
    bind(instance) {
      app = instance;
    },
    /**
     * checks whether a request carries the in-process marker
     * @param request the incoming request
     * @returns true only for the exact secret marker value
     */
    isInternal(request) {
      const value = request.headers[MARKER_HEADER];

      if (typeof value !== 'string') {
        return false;
      }

      const given = Buffer.from(value);

      return (
        given.length === expected.length && timingSafeEqual(given, expected)
      );
    },
  };
}
