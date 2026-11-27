import { afterEach, describe, expect, it, vi } from 'vitest';

import { createConnectorStore, GATEWAY_BASE } from '../../src/box/connector';
import { createFixtureStore } from '../../src/box/fixture';
import { SourceAdapterError } from '../../src/box/types';

import type { FetchLike } from '../../src/box/connector';

const FOLDER = '8800000001';
const CONNECTION = 'conn_box_1';
const NAME = 'inbound-20261125-1a2b3c4d.json';
const BYTES = new TextEncoder().encode('{"resourceType":"Bundle"}');

/** one request the fake gateway saw */
interface Seen {
  url: string;
  init: Parameters<FetchLike>[1];
}

/**
 * builds a fake gateway answering every call with one response
 * @param respond builds the response
 * @returns the fetch and the calls it saw
 */
function gateway(respond: () => Response): { fetch: FetchLike; seen: Seen[] } {
  const seen: Seen[] = [];

  return {
    seen,
    fetch: async (url, init) => {
      seen.push({ url, init });

      return Promise.resolve(respond());
    },
  };
}

/**
 * builds Box's upload answer for one file
 * @param overrides fields of the file entry to change
 * @returns the response
 */
function uploaded(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    total_count: 1,
    entries: [
      {
        type: 'file',
        id: '1500000001',
        name: NAME,
        size: BYTES.length,
        file_version: { id: '1700000001' },
        parent: { id: FOLDER },
        ...overrides,
      },
    ],
  });
}

describe('fn:createConnectorStore', () => {
  it('posts one multipart upload, attributes first, into the fixed folder with no credential', async () => {
    const fake = gateway(() => uploaded());
    const store = createConnectorStore({
      connectionId: CONNECTION,
      folderId: FOLDER,
      fetch: fake.fetch,
    });

    const filed = await store.upload({ name: NAME, bytes: BYTES });

    expect(filed).toEqual({
      fileId: '1500000001',
      version: '1700000001',
      name: NAME,
      size: BYTES.length,
    });
    expect(fake.seen).toHaveLength(1);

    const [call] = fake.seen;
    const body = call?.init.body;
    const parts = body ? [...body.keys()] : [];

    expect(call?.url).toBe(
      `${GATEWAY_BASE}/${CONNECTION}/upload/files/content`,
    );
    expect(call?.init).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(
      Object.keys(call?.init.headers ?? {}).map((h) => h.toLowerCase()),
    ).not.toContain('authorization');
    expect(parts).toEqual(['attributes', 'file']);
    expect(JSON.parse(body?.get('attributes') as string)).toEqual({
      name: NAME,
      parent: { id: FOLDER },
    });
  });

  it.each([
    [
      'a redirect',
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://elsewhere.example/' },
        }),
      'redirect-refused',
    ],
    [
      'an error status',
      () => new Response('no', { status: 403 }),
      'http-status',
    ],
    [
      'a file in another folder',
      () => uploaded({ parent: { id: '0' } }),
      'bad-response',
    ],
    ['a renamed file', () => uploaded({ name: 'other.json' }), 'bad-response'],
    ['a size mismatch', () => uploaded({ size: 1 }), 'bad-response'],
    [
      'a non-JSON body',
      () => new Response('<html>', { status: 201 }),
      'bad-response',
    ],
  ])('refuses %s', async (_name, respond, code) => {
    const store = createConnectorStore({
      connectionId: CONNECTION,
      folderId: FOLDER,
      fetch: gateway(respond).fetch,
    });

    await expect(
      store.upload({ name: NAME, bytes: BYTES }),
    ).rejects.toMatchObject({ code });
  });

  it('refuses an unsafe name before any request', async () => {
    const fake = gateway(() => uploaded());
    const store = createConnectorStore({
      connectionId: CONNECTION,
      folderId: FOLDER,
      fetch: fake.fetch,
    });

    await expect(
      store.upload({ name: '../escape.json', bytes: BYTES }),
    ).rejects.toBeInstanceOf(SourceAdapterError);
    expect(fake.seen).toHaveLength(0);
  });
});

describe('fn:createFixtureStore', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('appends uploads to the shared folder with fresh numeric ids', async () => {
    const files = [
      { id: '9700000000', name: 'x.json', version: 'v', bytes: BYTES },
    ];
    const store = createFixtureStore(FOLDER, files);

    const filed = await store.upload({ name: NAME, bytes: BYTES });

    expect(filed.fileId).toBe('9700000001');
    expect(files.map((file) => file.name)).toEqual(['x.json', NAME]);
  });

  it('is refused under NODE_ENV=production', () => {
    vi.stubEnv('NODE_ENV', 'production');

    expect(() => createFixtureStore(FOLDER)).toThrow(/tests/);
  });
});
