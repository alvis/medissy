import { z } from 'zod';

import {
  gatewayDownload,
  gatewayGet,
  gatewayPost,
  readCapped,
  readJson,
} from './gateway';
import { SourceAdapterError } from './types';

import type { FetchLike } from './gateway';
import type {
  FiledFile,
  SecureStore,
  SourceAdapter,
  SourceFileEntry,
  SourceFileMetadata,
  SourceListing,
} from './types';

export type { FetchLike } from './gateway';

/**
 * the Sprites gateway for the Box connector; it is reachable only from inside
 * the Sprite and holds the Box OAuth grant itself, so this module sends no
 * credential of any kind
 */
export const GATEWAY_BASE = 'https://api.sprites.dev/v1/gateway/box';

/**
 * Box REST prefix under the gateway; unverified against the live gateway
 * (SPK03 runs the real listing); change here once the connector details say
 * otherwise
 */
export const BOX_API_PREFIX = '2.0';

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const NUMERIC_ID = /^\d{1,32}$/;
const PLACEHOLDER = 'replace-me';
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const VERSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const FIELDS = 'id,type,name,size,etag,file_version,parent';

/** connection settings taken from the environment */
export interface ConnectorConfig {
  connectionId: string;
  folderId: string;
}

/** everything the connector adapter needs */
export interface ConnectorOptions extends ConnectorConfig {
  fetch: FetchLike;
  timeoutMs?: number;
}

const fileSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  size: z.number(),
  etag: z.string().nullish(),
  file_version: z.looseObject({ id: z.string() }).nullish(),
  parent: z.looseObject({ id: z.string() }).nullish(),
});

/**
 * the gateway path of Box's upload endpoint; it has no `2.0` prefix: Box
 * serves uploads from a separate host, which the gateway maps under
 * `/upload`; the live connector policy must allow it (scripts/deploy.md)
 */
export const UPLOAD_PATH = '/upload/files/content';

/** generated upload names: safe for the sync's name check and for Box */
const UPLOAD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

const uploadSchema = z.looseObject({
  total_count: z.number(),
  entries: z.array(fileSchema).length(1),
});

const listSchema = z.looseObject({
  total_count: z.number(),
  entries: z.array(z.looseObject({ type: z.string() })),
});

/**
 * reads the connector settings from environment placeholders
 * @param env an environment, normally `process.env`
 * @returns the validated settings
 */
export function connectorConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): ConnectorConfig {
  const connectionId = env.BOX_GATEWAY_CONNECTION_ID;
  const folderId = env.BOX_ALLOWED_FOLDER_ID;

  if (!connectionId || connectionId === PLACEHOLDER || !ID.test(connectionId)) {
    throw new Error('BOX_GATEWAY_CONNECTION_ID is missing or invalid');
  }

  if (!folderId || folderId === PLACEHOLDER || !NUMERIC_ID.test(folderId)) {
    throw new Error('BOX_ALLOWED_FOLDER_ID is missing or invalid');
  }

  return { connectionId, folderId };
}

/**
 * picks the version identifier of a Box file
 * @param file a parsed file object
 * @returns the file-version id, else the etag, else an empty string
 */
function versionOf(file: z.infer<typeof fileSchema>): string {
  return file.file_version?.id ?? file.etag ?? '';
}

/**
 * maps a parsed Box file object to a listing entry
 * @param file the Box file object after schema validation
 * @returns a listing entry with id, name, size and version
 */
function entryOf(file: z.infer<typeof fileSchema>): SourceFileEntry {
  return {
    id: file.id,
    name: file.name,
    size: file.size,
    version: versionOf(file),
  };
}

/**
 * lists the files of the allowed folder, page by page
 * @param getJson fetches a gateway path as JSON
 * @param folderId the allowed folder id
 * @returns the file entries (sub-folders are skipped)
 */
async function listFolder(
  getJson: (path: string) => Promise<unknown>,
  folderId: string,
): Promise<SourceListing> {
  const entries: SourceFileEntry[] = [];
  let truncated = false;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const offset = page * PAGE_SIZE;
    const parsed = listSchema.safeParse(
      await getJson(
        `/folders/${folderId}/items?fields=${FIELDS}&limit=${PAGE_SIZE}&offset=${offset}`,
      ),
    );

    if (!parsed.success) {
      throw new SourceAdapterError('bad-response');
    }

    for (const item of parsed.data.entries) {
      const file = item.type === 'file' ? fileSchema.safeParse(item) : null;

      if (file?.success) {
        entries.push(entryOf(file.data));
      }
    }

    if (offset + PAGE_SIZE >= parsed.data.total_count) {
      break;
    }

    truncated = page === MAX_PAGES - 1;
  }

  return { entries, truncated };
}

/**
 * requires a plain numeric file id before it can reach a URL
 * @param fileId an untrusted id
 */
function assertFileId(fileId: string): void {
  if (!NUMERIC_ID.test(fileId)) {
    throw new SourceAdapterError('bad-response');
  }
}

/**
 * creates the adapter that reads Box through the Sprites gateway
 * @param options connection id, allowed folder id and the injected fetch
 * @returns a source adapter whose `kind` is `box-connector`
 */
export function createConnectorAdapter(
  options: ConnectorOptions,
): SourceAdapter {
  const { connectionId, folderId } = options;

  if (!ID.test(connectionId) || !NUMERIC_ID.test(folderId)) {
    throw new Error('connector ids must be plain identifiers');
  }

  const base = `${GATEWAY_BASE}/${connectionId}/${BOX_API_PREFIX}`;
  const get = async (path: string): Promise<Response> =>
    gatewayGet(options, `${base}${path}`);
  const getJson = async (path: string): Promise<unknown> => {
    try {
      return await readJson(await get(path));
    } catch (error) {
      throw error instanceof SourceAdapterError
        ? error
        : new SourceAdapterError('bad-response');
    }
  };

  return {
    kind: 'box-connector',
    label: 'Sprites Box connector',
    folderId,
    list: async () => listFolder(getJson, folderId),
    metadata: async (fileId): Promise<SourceFileMetadata> => {
      assertFileId(fileId);

      const parsed = fileSchema.safeParse(
        await getJson(`/files/${fileId}?fields=${FIELDS}`),
      );

      if (!parsed.success || parsed.data.id !== fileId) {
        throw new SourceAdapterError('bad-response');
      }

      return {
        ...entryOf(parsed.data),
        parentId: parsed.data.parent?.id ?? '',
        ...(parsed.data.file_version
          ? { versionId: parsed.data.file_version.id }
          : {}),
      };
    },
    download: async (fileId, maxBytes, versionId) => {
      assertFileId(fileId);

      if (versionId !== undefined && !VERSION_ID.test(versionId)) {
        throw new SourceAdapterError('bad-response');
      }

      const query = versionId ? `?version=${versionId}` : '';
      const response = await gatewayDownload(
        options,
        `${base}/files/${fileId}/content${query}`,
      );

      return readCapped(response, maxBytes);
    },
  };
}

/**
 * checks Box's answer to an upload: one file, in the allowed folder, with the
 * name and size sent and a usable version id
 * @param body the parsed response body
 * @param expected the folder, name and size the upload asked for
 * @param expected.folderId the allowed folder
 * @param expected.name the generated name
 * @param expected.size the byte length sent
 * @returns the id, version, name and size Box reported
 */
function filedFileOf(
  body: unknown,
  expected: { folderId: string; name: string; size: number },
): FiledFile {
  const parsed = uploadSchema.safeParse(body);
  const file = parsed.success ? parsed.data.entries[0] : undefined;
  const version = file ? versionOf(file) : '';

  if (
    !file ||
    !NUMERIC_ID.test(file.id) ||
    file.parent?.id !== expected.folderId ||
    file.name !== expected.name ||
    file.size !== expected.size ||
    !VERSION_ID.test(version)
  ) {
    throw new SourceAdapterError('bad-response');
  }

  return { fileId: file.id, version, name: file.name, size: file.size };
}

/**
 * creates the secure store that files uploads into the allowed Box folder
 * through the Sprites gateway; the parent folder is fixed here: the gateway
 * policy can allow the upload endpoint but cannot pin its parent, so Medissy
 * does; no credential is sent and no redirect is followed
 * @param options connection id, allowed folder id and the injected fetch
 * @returns a secure store whose `kind` is `box-connector`
 */
export function createConnectorStore(options: ConnectorOptions): SecureStore {
  const { connectionId, folderId } = options;

  if (!ID.test(connectionId) || !NUMERIC_ID.test(folderId)) {
    throw new Error('connector ids must be plain identifiers');
  }

  const url = `${GATEWAY_BASE}/${connectionId}${UPLOAD_PATH}`;

  return {
    kind: 'box-connector',
    label: 'Sprites Box connector',
    folderId,
    upload: async ({ name, bytes }) => {
      if (!UPLOAD_NAME.test(name)) {
        throw new SourceAdapterError('bad-response');
      }

      const body = new FormData();

      // Box requires the attributes part before the file part
      body.append(
        'attributes',
        JSON.stringify({ name, parent: { id: folderId } }),
      );
      body.append(
        'file',
        new Blob([bytes], { type: 'application/json' }),
        name,
      );

      let parsed: unknown;

      try {
        parsed = await readJson(await gatewayPost(options, url, body));
      } catch (error) {
        throw error instanceof SourceAdapterError
          ? error
          : new SourceAdapterError('bad-response');
      }

      return filedFileOf(parsed, { folderId, name, size: bytes.length });
    },
  };
}
