/**
 * gated source download: GET /a2a/v1/tasks/:taskId/files/:fileId; a file is
 * served only when the task is bound, completed and unexpired, its grant
 * passes a fresh re-check, every record in the file version is in the
 * released scope, the bytes match an imported version, and the type is in
 * the safe set; every refusal is the same 404; the body is always an
 * attachment, never cached, and never a redirect to Box
 */
import { createHash } from 'node:crypto';

import { listSourceRecordMap } from '../box/catalog';
import {
  connectorConfigFromEnv,
  createConnectorAdapter,
} from '../box/connector';

import { A2A_PATH } from './card';

import type { DatabaseSync } from 'node:sqlite';

import type { FastifyInstance, FastifyReply } from 'fastify';

import type { FetchLike } from '../box/gateway';
import type { SourceAdapter } from '../box/types';

import type { TaskEngine } from './engine';

/** route of the download */
export const DOWNLOAD_ROUTE = `${A2A_PATH}/tasks/:taskId/files/:fileId`;
/** template shown in the text part; the caller fills in its own task id */
export const DOWNLOAD_TEMPLATE = `${A2A_PATH}/tasks/{taskId}/files/{fileId}`;
/** largest file served */
export const MAX_DOWNLOAD_BYTES = 5_000_000;

const HTTP_NOT_FOUND = 404;
const FILE_ID = /^\d{1,32}$/;

/** the only types served, by extension */
export const SAFE_TYPES: Readonly<Record<string, string>> = {
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

/** one source file's bytes and its source name */
export interface SourceFile {
  bytes: Uint8Array;
  name: string;
}

/** reads a source file's bytes (Box in production, fixtures in tests) */
export interface SourceFileReader {
  read(fileId: string): Promise<SourceFile | undefined>;
}

/**
 * reads files through the Box source adapter, inside its allowed folder only
 * @param adapter the configured Box (or fixture) adapter
 * @returns a reader that refuses anything outside that folder
 */
export function createAdapterReader(adapter: SourceAdapter): SourceFileReader {
  return {
    read: async (fileId) => {
      const meta = await adapter.metadata(fileId);

      if (meta.parentId !== adapter.folderId) {
        return undefined;
      }

      const bytes = await adapter.download(
        fileId,
        MAX_DOWNLOAD_BYTES,
        meta.versionId,
      );

      return { bytes, name: meta.name };
    },
  };
}

/** the `.env.example` placeholder: a setting left at it is absent */
const ENV_PLACEHOLDER = 'replace-me';

/**
 * builds a reader over the Sprites Box connector when its settings are present;
 * without both settings there is no reader: no download link is advertised
 * and the download route is not registered
 * @param env an environment, normally `process.env`
 * @param fetchImpl the fetch the connector uses
 * @returns the reader, or undefined when Box is not configured
 * @throws {Error} when a setting is present but malformed
 */
export function sourceReaderFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl: FetchLike = fetch,
): SourceFileReader | undefined {
  const present = (value: string | undefined): boolean =>
    Boolean(value) && value !== ENV_PLACEHOLDER;

  if (
    !present(env.BOX_GATEWAY_CONNECTION_ID) ||
    !present(env.BOX_ALLOWED_FOLDER_ID)
  ) {
    return undefined;
  }

  return createAdapterReader(
    createConnectorAdapter({
      ...connectorConfigFromEnv(env),
      fetch: fetchImpl,
    }),
  );
}

/**
 * returns the served content type for a source name
 * @param name the source file name
 * @returns the content type, or undefined when not in the safe set
 */
export function safeType(name: string): string | undefined {
  const dot = name.lastIndexOf('.');

  return dot < 0 ? undefined : SAFE_TYPES[name.slice(dot).toLowerCase()];
}

/** what the route is bound to */
export interface DownloadDeps {
  db: DatabaseSync;
  engine: Pick<TaskEngine, 'released'>;
  reader: SourceFileReader;
}

/**
 * decides and reads one download
 * @param deps the vault, engine and reader
 * @param taskId the task id (the D10 capability)
 * @param fileId the Box file id
 * @returns the bytes and type, or undefined for any refusal
 */
export async function resolveDownload(
  deps: DownloadDeps,
  taskId: string,
  fileId: string,
): Promise<{ bytes: Uint8Array; type: string; ext: string } | undefined> {
  if (!FILE_ID.test(fileId)) {
    return undefined;
  }

  const scope = await deps.engine.released(taskId);

  if (!scope) {
    return undefined;
  }

  // a file version is one unit of disclosure: all its records must be in scope
  const versions = listSourceRecordMap(deps.db, scope.patientId).filter(
    (source) =>
      source.boxFileId === fileId &&
      source.records.length > 0 &&
      source.records.every((record) => scope.recordIds.has(record.id)),
  );

  if (versions.length === 0) {
    return undefined;
  }

  const file = await deps.reader.read(fileId).catch(() => undefined);
  const type = file ? safeType(file.name) : undefined;

  if (!file || !type || file.bytes.byteLength > MAX_DOWNLOAD_BYTES) {
    return undefined;
  }

  const sha256 = createHash('sha256').update(file.bytes).digest('hex');

  if (!versions.some((source) => source.sha256 === sha256)) {
    return undefined;
  }

  return {
    bytes: file.bytes,
    type,
    ext: file.name.slice(file.name.lastIndexOf('.')).toLowerCase(),
  };
}

/**
 * sends the uniform refusal
 * @param reply the reply to answer with the refusal
 * @returns the reply
 */
function notFound(reply: FastifyReply): FastifyReply {
  return reply
    .code(HTTP_NOT_FOUND)
    .header('Cache-Control', 'no-store')
    .send({ error: 'not_found' });
}

/**
 * registers the download route; its path carries the task id, so request
 * logging is off for it
 * @param app the root app
 * @param deps the vault, engine and reader
 */
export function registerDownloads(
  app: FastifyInstance,
  deps: DownloadDeps,
): void {
  app.get(DOWNLOAD_ROUTE, { logLevel: 'silent' }, async (request, reply) => {
    const { taskId, fileId } = request.params as {
      taskId: string;
      fileId: string;
    };
    const file = await resolveDownload(deps, taskId, fileId);

    if (!file) {
      return notFound(reply);
    }

    return reply
      .header('Content-Type', file.type)
      .header(
        'Content-Disposition',
        `attachment; filename="medissy-source-${fileId}${file.ext}"`,
      )
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .send(Buffer.from(file.bytes));
  });
}
