import { describe, expect, it } from 'vitest';

import { getSyncOverview } from '../../src/box/catalog';
import {
  GATEWAY_BASE,
  connectorConfigFromEnv,
  createConnectorAdapter,
} from '../../src/box/connector';
import { runSync } from '../../src/box/sync';
import { SourceAdapterError } from '../../src/box/types';

import {
  CURATION,
  MANIFEST,
  PATIENT,
  count,
  freshVault,
  syntheticFiles,
} from './support';

import type { FetchLike } from '../../src/box/connector';

const CONNECTION = 'conn_test-1';
const FOLDER = '8800000001';
const BASE = `${GATEWAY_BASE}/${CONNECTION}/2.0`;

interface Call {
  url: string;
  init: Parameters<FetchLike>[1];
}

/**
 * builds a fake gateway
 * @param handler maps a URL to a response
 * @returns the fetch and the calls it saw
 */
function fakeFetch(handler: (url: string) => Response): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];

  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });

      return Promise.resolve(handler(url));
    },
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const meta = (id: string, name: string, size: number) => ({
  type: 'file',
  id,
  name,
  size,
  etag: '3',
  file_version: { id: `v${id}` },
  parent: { id: FOLDER },
});

/**
 * builds a gateway serving the synthetic files from the allowed folder
 * @returns the fake fetch
 */
function gatewayOfFixtures(): ReturnType<typeof fakeFetch> {
  const files = syntheticFiles();

  return fakeFetch((url) => {
    const path = url.slice(BASE.length);
    const download = /^\/files\/(\d+)\/content(?:\?version=(.+))?$/.exec(path);
    const one = /^\/files\/(\d+)\?/.exec(path);
    const find = (id: string | undefined) => files.find((f) => f.id === id);

    if (path.startsWith(`/folders/${FOLDER}/items`)) {
      return json({
        total_count: files.length,
        entries: [
          ...files.map((f) => meta(f.id, f.name, f.bytes.length)),
          { type: 'folder', id: '5', name: 'sub' },
        ],
      });
    }

    const file = find(download?.[1] ?? one?.[1]);

    if (!file || (download?.[2] && download[2] !== `v${file.id}`)) {
      return json({}, 404);
    }

    return download
      ? new Response(file.bytes, { status: 200 })
      : json(meta(file.id, file.name, file.bytes.length));
  });
}

const adapterFor = (fetch: FetchLike) =>
  createConnectorAdapter({
    connectionId: CONNECTION,
    folderId: FOLDER,
    fetch,
  });

describe('connector adapter (fake fetch, no network)', () => {
  it('calls only the gateway URL for the allowed folder and sends no credential', async () => {
    const gateway = gatewayOfFixtures();
    const adapter = createConnectorAdapter({
      connectionId: CONNECTION,
      folderId: FOLDER,
      fetch: gateway.fetch,
    });
    const entries = await adapter.list();

    await adapter.metadata('9100000013');
    await adapter.download('9100000013', 10_000, 'v9100000013');

    expect(adapter.kind).toBe('box-connector');
    expect(entries.entries).toHaveLength(syntheticFiles().length);
    expect(entries.truncated).toBe(false);
    expect(gateway.calls.map((c) => c.url)).toEqual([
      expect.stringMatching(new RegExp(`^${BASE}/folders/${FOLDER}/items\\?`)),
      expect.stringMatching(new RegExp(`^${BASE}/files/9100000013\\?`)),
      `${BASE}/files/9100000013/content?version=v9100000013`,
    ]);

    for (const call of gateway.calls) {
      expect(
        Object.keys(call.init.headers).map((h) => h.toLowerCase()),
      ).not.toContain('authorization');
      expect(call.init.redirect).toBe('manual');
    }
  });

  it('reads the connection and folder ids from env and refuses placeholders', () => {
    expect(
      connectorConfigFromEnv({
        BOX_GATEWAY_CONNECTION_ID: 'conn_1',
        BOX_ALLOWED_FOLDER_ID: '123',
      }),
    ).toEqual({ connectionId: 'conn_1', folderId: '123' });
    expect(() =>
      connectorConfigFromEnv({
        BOX_GATEWAY_CONNECTION_ID: 'replace-me',
        BOX_ALLOWED_FOLDER_ID: '123',
      }),
    ).toThrow(/CONNECTION_ID/);
    expect(() =>
      connectorConfigFromEnv({ BOX_GATEWAY_CONNECTION_ID: 'conn_1' }),
    ).toThrow(/FOLDER_ID/);
    expect(() =>
      connectorConfigFromEnv({
        BOX_GATEWAY_CONNECTION_ID: '../x',
        BOX_ALLOWED_FOLDER_ID: '1',
      }),
    ).toThrow();
  });

  it('refuses ids that could steer the path', () => {
    const { fetch } = fakeFetch(() => json({}));

    expect(() =>
      createConnectorAdapter({
        connectionId: 'a/../b',
        folderId: FOLDER,
        fetch,
      }),
    ).toThrow();
    expect(() =>
      createConnectorAdapter({
        connectionId: CONNECTION,
        folderId: '1/../2',
        fetch,
      }),
    ).toThrow();
  });

  it('never calls the gateway for a non-numeric file id', async () => {
    const gateway = fakeFetch(() => json({}));
    const adapter = createConnectorAdapter({
      connectionId: CONNECTION,
      folderId: FOLDER,
      fetch: gateway.fetch,
    });

    await expect(adapter.download('../1', 100)).rejects.toBeInstanceOf(
      SourceAdapterError,
    );
    await expect(
      adapter.metadata('https://app.box.com/s/x'),
    ).rejects.toBeInstanceOf(SourceAdapterError);
    expect(gateway.calls).toEqual([]);
  });

  describe('the one allowed redirect on a file download', () => {
    const SIGNED = 'https://dl.boxcloud.com/d/1/signed-secret-token';
    const redirect = (location: string): Response =>
      new Response(null, { status: 302, headers: { location } });

    it('follows one redirect to an https Box download host with no headers', async () => {
      const gateway = fakeFetch((url) =>
        url.startsWith(GATEWAY_BASE)
          ? redirect(SIGNED)
          : new Response('hello', { status: 200 }),
      );
      const bytes = await adapterFor(gateway.fetch).download('1', 100);

      expect(new TextDecoder().decode(bytes)).toBe('hello');
      expect(gateway.calls.map((c) => c.url)).toEqual([
        `${BASE}/files/1/content`,
        SIGNED,
      ]);
      expect(gateway.calls[1]?.init.headers).toEqual({});
      expect(gateway.calls[1]?.init.redirect).toBe('manual');
    });

    it.each([
      ['a host that is not a Box download host', 'https://evil.example.com/x'],
      ['a look-alike host', 'https://boxcloud.com.evil.example/x'],
      ['plain http', 'http://dl.boxcloud.com/d/1/signed-secret-token'],
      ['a URL with credentials', 'https://u:p@dl.boxcloud.com/x'],
      ['a URL with a port', 'https://dl.boxcloud.com:8443/x'],
      ['a relative location', '/files/2/content'],
    ])(
      'refuses a redirect to %s without following or leaking it',
      async (_n, location) => {
        const gateway = fakeFetch(() => redirect(location));
        const failure = await adapterFor(gateway.fetch)
          .download('1', 100)
          .catch((error: unknown) => error);

        expect(failure).toMatchObject({
          code: 'redirect-refused',
          status: 302,
        });
        expect((failure as Error).message).toBe('redirect-refused:302');
        expect(gateway.calls).toHaveLength(1);
      },
    );

    it('refuses a second hop', async () => {
      const gateway = fakeFetch(() => redirect(SIGNED));
      const failure = await adapterFor(gateway.fetch)
        .download('1', 100)
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({ code: 'redirect-refused' });
      expect(gateway.calls).toHaveLength(2);
      expect(String((failure as Error).message)).not.toContain('signed');
    });

    it('refuses any redirect on metadata and listing calls', async () => {
      const gateway = fakeFetch(() => redirect(SIGNED));

      await expect(
        adapterFor(gateway.fetch).metadata('1'),
      ).rejects.toMatchObject({ code: 'redirect-refused' });
      await expect(adapterFor(gateway.fetch).list()).rejects.toMatchObject({
        code: 'redirect-refused',
      });
      expect(gateway.calls).toHaveLength(2);
    });
  });

  it('refuses a version id that could steer the URL', async () => {
    const gateway = fakeFetch(() => json({}));
    const adapter = createConnectorAdapter({
      connectionId: CONNECTION,
      folderId: FOLDER,
      fetch: gateway.fetch,
    });

    await expect(adapter.download('1', 100, '1&x=../')).rejects.toMatchObject({
      code: 'bad-response',
    });
    expect(gateway.calls).toEqual([]);
  });

  it('caps listing and metadata responses instead of buffering them', async () => {
    const big = ' '.repeat(1_100_000);
    const adapter = createConnectorAdapter({
      connectionId: CONNECTION,
      folderId: FOLDER,
      fetch: fakeFetch(() => new Response(big, { status: 200 })).fetch,
    });

    await expect(adapter.list()).rejects.toMatchObject({ code: 'too-large' });
    await expect(adapter.metadata('1')).rejects.toMatchObject({
      code: 'too-large',
    });
  });

  it('reports a listing cut at 500 entries as truncated', async () => {
    const page = (offset: number): unknown => ({
      total_count: 1000,
      entries: Array.from({ length: 100 }, (_v, i) =>
        meta(String(offset + i + 1), `f${offset + i}.txt`, 1),
      ),
    });
    const adapter = createConnectorAdapter({
      connectionId: CONNECTION,
      folderId: FOLDER,
      fetch: fakeFetch((url) =>
        json(page(Number(/offset=(\d+)/.exec(url)?.[1]))),
      ).fetch,
    });
    const listing = await adapter.list();

    expect(listing.entries).toHaveLength(500);
    expect(listing.truncated).toBe(true);
  });

  it('caps a download by content-length and by streamed bytes', async () => {
    const declared = createConnectorAdapter({
      connectionId: CONNECTION,
      folderId: FOLDER,
      fetch: fakeFetch(
        () =>
          new Response('x', {
            status: 200,
            headers: { 'content-length': '999999' },
          }),
      ).fetch,
    });
    const streamed = createConnectorAdapter({
      connectionId: CONNECTION,
      folderId: FOLDER,
      fetch: fakeFetch(
        () => new Response(new Uint8Array(5000), { status: 200 }),
      ).fetch,
    });

    await expect(declared.download('1', 100)).rejects.toMatchObject({
      code: 'too-large',
    });
    await expect(streamed.download('1', 100)).rejects.toMatchObject({
      code: 'too-large',
    });
  });

  it('maps HTTP errors and network failures to codes without bodies', async () => {
    const adapter = adapterFor;

    await expect(
      adapter(
        fakeFetch(() => new Response('secret body', { status: 500 })).fetch,
      ).list(),
    ).rejects.toMatchObject({
      code: 'http-status',
      status: 500,
      message: 'http-status:500',
    });
    await expect(
      adapter(fakeFetch(() => json({}, 404)).fetch).metadata('1'),
    ).rejects.toMatchObject({ code: 'not-found' });
    await expect(
      adapter(async () =>
        Promise.reject(new Error('socket token=abc')),
      ).download('1', 10),
    ).rejects.toMatchObject({ code: 'network', message: 'network' });
    await expect(
      adapter(
        fakeFetch(() => new Response('<html>', { status: 200 })).fetch,
      ).list(),
    ).rejects.toMatchObject({ code: 'bad-response' });
  });
});

describe('sync through the connector adapter (fake fetch)', () => {
  it('imports the synthetic folder and stamps the run as box-connector, not fixture', async () => {
    const db = freshVault();
    const gateway = gatewayOfFixtures();
    const adapter = createConnectorAdapter({
      connectionId: CONNECTION,
      folderId: FOLDER,
      fetch: gateway.fetch,
    });
    const summary = await runSync(
      { db, adapter, curation: CURATION, patientId: PATIENT },
      { trigger: 'owner' },
    );

    expect(summary).toMatchObject({
      adapter: 'box-connector',
      status: 'partial',
      rejected: 1,
    });
    expect(count(db, 'records')).toBe(30);
    expect(getSyncOverview(db, PATIENT).lastRun?.adapter).toBe('box-connector');
    expect(
      gateway.calls.every((c) =>
        c.url.startsWith(`${GATEWAY_BASE}/${CONNECTION}/`),
      ),
    ).toBe(true);
  });

  it('rejects a file whose metadata puts it outside the allowed folder', async () => {
    const db = freshVault();
    const files = syntheticFiles();
    const gateway = fakeFetch((url) => {
      const path = url.slice(BASE.length);

      if (path.startsWith('/folders/')) {
        return json({
          total_count: 1,
          entries: [
            meta('9100000013', 'northgate-clinic-letter-2026-10-20.txt', 717),
          ],
        });
      }

      return json({
        ...meta('9100000013', 'northgate-clinic-letter-2026-10-20.txt', 717),
        parent: { id: '999' },
      });
    });
    const adapter = createConnectorAdapter({
      connectionId: CONNECTION,
      folderId: FOLDER,
      fetch: gateway.fetch,
    });
    const summary = await runSync(
      { db, adapter, curation: CURATION, patientId: PATIENT },
      { trigger: 'owner' },
    );

    expect(files.length).toBeGreaterThan(0);
    expect(summary.rejections).toEqual([
      { fileId: '9100000013', reason: 'not-in-allowed-folder' },
    ]);
    expect(gateway.calls.some((c) => c.url.endsWith('/content'))).toBe(false);
  });

  it('audits a gateway outage as a failed sync without leaking the error', async () => {
    const db = freshVault();
    const adapter = createConnectorAdapter({
      connectionId: CONNECTION,
      folderId: FOLDER,
      fetch: async () => Promise.reject(new Error(`down ${MANIFEST.canary}`)),
    });
    const summary = await runSync(
      { db, adapter, curation: CURATION, patientId: PATIENT },
      { trigger: 'owner' },
    );
    const audit = JSON.stringify(
      db.prepare('SELECT type, outcome, details FROM audit_events').all(),
    );

    expect(summary.status).toBe('failed');
    expect(audit).toContain('sync.failed');
    expect(audit).not.toContain(MANIFEST.canary);
    expect(count(db, 'records')).toBe(0);
  });
});
