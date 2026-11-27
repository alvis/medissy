import { SourceAdapterError } from './types';

/** the subset of `fetch` the connector uses; tests inject a fake */
export type FetchLike = (
  url: string,
  init: {
    method: 'GET' | 'POST';
    redirect: 'manual';
    headers: Record<string, string>;
    signal: AbortSignal;
    /** a multipart upload body (POST only) */
    body?: FormData;
  },
) => Promise<Response>;

/** what one gateway call needs: the injected fetch and a timeout */
export interface GatewayOptions {
  fetch: FetchLike;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const REDIRECT_MIN = 300;
const REDIRECT_MAX = 399;
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;
const HTTP_NOT_FOUND = 404;

/** listing and metadata responses are small; anything larger is refused */
export const MAX_JSON_BYTES = 1_048_576;

/** Box serves signed downloads only from this domain and its subdomains */
const BOX_DOWNLOAD_DOMAIN = 'boxcloud.com';

/**
 * reads a response body up to a cap, stopping the stream as soon as it is hit
 * @param response the response to drain
 * @param maxBytes the cap
 * @returns the body bytes
 */
export async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  const reader = response.body?.getReader() as
    ReadableStreamDefaultReader<Uint8Array> | undefined;

  if (!reader) {
    throw new SourceAdapterError('bad-response');
  }

  if (declared > maxBytes) {
    await reader.cancel();
    throw new SourceAdapterError('too-large');
  }

  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    total += value.length;

    if (total > maxBytes) {
      await reader.cancel();
      throw new SourceAdapterError('too-large');
    }

    chunks.push(value);
  }

  return Buffer.concat(chunks);
}

/**
 * reads a JSON body through the byte cap
 * @param response a 2xx response
 * @returns the parsed JSON value
 */
export async function readJson(response: Response): Promise<unknown> {
  const bytes = await readCapped(response, MAX_JSON_BYTES);

  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new SourceAdapterError('bad-response');
  }
}

/**
 * checks whether a status is a redirect
 * @param status an HTTP status
 * @returns true for 3xx
 */
function isRedirect(status: number): boolean {
  return status >= REDIRECT_MIN && status <= REDIRECT_MAX;
}

/**
 * turns a status into an error, for any status that is not a plain 2xx
 * @param response a response
 * @returns the error to throw, or undefined for a 2xx response
 */
function errorForStatus(response: Response): SourceAdapterError | undefined {
  const { status } = response;

  if (isRedirect(status)) {
    return new SourceAdapterError('redirect-refused', status);
  }

  if (status === HTTP_NOT_FOUND) {
    return new SourceAdapterError('not-found', status);
  }

  return status < HTTP_OK_MIN || status > HTTP_OK_MAX
    ? new SourceAdapterError('http-status', status)
    : undefined;
}

/**
 * sends one GET (or a multipart POST) with manual redirects and a timeout
 * @param options the injected fetch and timeout
 * @param request the URL, the headers and any body to send
 * @param request.url the URL to fetch
 * @param request.headers the headers to send
 * @param request.body a multipart body, which makes the request a POST
 * @returns the raw response, whatever its status
 */
async function send(
  options: GatewayOptions,
  request: { url: string; headers: Record<string, string>; body?: FormData },
): Promise<Response> {
  try {
    return await options.fetch(request.url, {
      method: request.body ? 'POST' : 'GET',
      redirect: 'manual',
      headers: request.headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      ...(request.body ? { body: request.body } : {}),
    });
  } catch {
    throw new SourceAdapterError('network');
  }
}

/**
 * throws for a non-2xx response, discarding its body
 * @param response a response
 * @returns the same response when it is 2xx
 */
async function require2xx(response: Response): Promise<Response> {
  const failure = errorForStatus(response);

  if (failure) {
    await response.body?.cancel();
    throw failure;
  }

  return response;
}

/**
 * sends one GET against the gateway: no redirects, a timeout, no credential
 * @param options the injected fetch and timeout
 * @param url the full gateway URL
 * @returns a 2xx response
 */
export async function gatewayGet(
  options: GatewayOptions,
  url: string,
): Promise<Response> {
  return require2xx(await send(options, { url, headers: { accept: '*/*' } }));
}

/**
 * sends one multipart POST against the gateway: no redirects (a 3xx is refused),
 * a timeout, no credential; the multipart boundary header is set by `fetch`
 * from the body
 * @param options the injected fetch and timeout
 * @param url the full gateway upload URL
 * @param body the multipart body, attributes first
 * @returns a 2xx response
 */
export async function gatewayPost(
  options: GatewayOptions,
  url: string,
  body: FormData,
): Promise<Response> {
  return require2xx(
    await send(options, {
      url,
      headers: { accept: 'application/json' },
      body,
    }),
  );
}

/**
 * accepts a redirect target only when it is a plain https URL on a Box download
 * host: no credentials in the URL, no custom port
 * @param location the untrusted `Location` header
 * @returns the URL to fetch, or undefined when it must be refused
 */
function allowedDownloadUrl(location: string | null): string | undefined {
  if (!location) {
    return undefined;
  }

  let url: URL;

  try {
    url = new URL(location);
  } catch {
    return undefined;
  }

  const host = url.hostname.toLowerCase();
  const onBox =
    host === BOX_DOWNLOAD_DOMAIN || host.endsWith(`.${BOX_DOWNLOAD_DOMAIN}`);
  const plain = url.username === '' && url.password === '' && url.port === '';

  return url.protocol === 'https:' && onBox && plain ? url.href : undefined;
}

/**
 * fetches a file body through the gateway; the gateway answers with a redirect to
 * a signed Box download URL; exactly one such redirect is followed, and only to
 * an https Box download host; the second request carries no headers; the signed
 * URL is used for that one request and never logged, stored or returned, and a
 * second redirect is refused
 * @param options the injected fetch and timeout
 * @param url the full gateway content URL
 * @returns a 2xx response with the file body
 */
export async function gatewayDownload(
  options: GatewayOptions,
  url: string,
): Promise<Response> {
  const first = await send(options, { url, headers: { accept: '*/*' } });

  if (!isRedirect(first.status)) {
    return require2xx(first);
  }

  const target = allowedDownloadUrl(first.headers.get('location'));

  await first.body?.cancel();

  if (!target) {
    throw new SourceAdapterError('redirect-refused', first.status);
  }

  return require2xx(await send(options, { url: target, headers: {} }));
}
