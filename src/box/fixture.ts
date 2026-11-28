import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SourceAdapterError } from './types';

import type {
  SecureStore,
  SourceAdapter,
  SourceFileEntry,
  SourceFileMetadata,
} from './types';

const HTTP_NOT_FOUND = 404;

/**
 * FIXTURE ADAPTER: FOR TESTS ONLY; it reads in-memory or on-disk synthetic
 * files and never touches Box; every sync it drives is stored with adapter
 * `fixture`, so it can never be mistaken for connector I/O (A01 needs the
 * connector)
 */
export const FIXTURE_LABEL = 'FIXTURE ADAPTER (tests only, not Box)';

/** one in-memory file; fields are deliberately loose so tests can attack */
export interface FixtureFile {
  id: string;
  name: string;
  version: string;
  bytes: Uint8Array;
  /** parent folder; defaults to the adapter's folder */
  parentId?: string;
  /** size the listing declares; defaults to the real length */
  declaredSize?: number;
}

/**
 * creates the tests-only adapter over in-memory files
 * @param folderId the folder id the adapter pretends to be
 * @param files the files in that folder
 * @returns a source adapter whose `kind` is `fixture`
 */
export function createFixtureAdapter(
  folderId: string,
  files: readonly FixtureFile[],
): SourceAdapter {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'the fixture adapter is for tests and must not run in production',
    );
  }

  const find = (fileId: string): FixtureFile => {
    const file = files.find((candidate) => candidate.id === fileId);

    if (!file) {
      throw new SourceAdapterError('not-found', HTTP_NOT_FOUND);
    }

    return file;
  };

  const entryOf = (file: FixtureFile): SourceFileEntry => ({
    id: file.id,
    name: file.name,
    size: file.declaredSize ?? file.bytes.length,
    version: file.version,
  });

  return {
    kind: 'fixture',
    label: FIXTURE_LABEL,
    folderId,
    list: async () =>
      Promise.resolve({ entries: files.map(entryOf), truncated: false }),
    metadata: async (fileId): Promise<SourceFileMetadata> => {
      const file = find(fileId);

      return Promise.resolve({
        ...entryOf(file),
        parentId: file.parentId ?? folderId,
        versionId: file.version,
      });
    },
    download: async (fileId, maxBytes, versionId) => {
      const { bytes, version } = find(fileId);

      if (versionId !== undefined && versionId !== version) {
        return Promise.reject(new SourceAdapterError('not-found'));
      }

      return bytes.length > maxBytes
        ? Promise.reject(new SourceAdapterError('too-large'))
        : Promise.resolve(bytes);
    },
  };
}

/** first file id the fixture store hands out; clear of the synthetic set */
const FIXTURE_UPLOAD_ID_BASE = 9_700_000_000;

/**
 * creates the tests-only secure store; uploads are appended to `files`, so a
 * fixture adapter over the same array lists them on the next sync, exactly
 * as Box would; refused under `NODE_ENV=production`, like the adapter
 * @param folderId the folder id the store pretends to file into
 * @param files the in-memory folder the uploads are appended to
 * @returns a secure store whose `kind` is `fixture`
 */
export function createFixtureStore(
  folderId: string,
  files: FixtureFile[] = [],
): SecureStore {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'the fixture store is for tests and must not run in production',
    );
  }

  let next = FIXTURE_UPLOAD_ID_BASE;

  return {
    kind: 'fixture',
    label: FIXTURE_LABEL,
    folderId,
    upload: async ({ name, bytes }) => {
      while (files.some((file) => file.id === String(next))) {
        next += 1;
      }

      const file: FixtureFile = {
        id: String(next),
        name,
        version: `v${next}`,
        bytes: new Uint8Array(bytes),
      };

      files.push(file);

      return Promise.resolve({
        fileId: file.id,
        version: file.version,
        name,
        size: bytes.length,
      });
    },
  };
}

/**
 * reads the repository's synthetic source documents as fixture files, using the
 * fixture manifest for ids and versions
 * @param root the `fixtures/synthetic` directory
 * @returns one fixture file per manifest source document
 */
export function loadSyntheticFixtureFiles(root: string): FixtureFile[] {
  const manifest = JSON.parse(
    readFileSync(join(root, 'manifest.json'), 'utf8'),
  ) as {
    sourceDocuments: Array<{
      file: string;
      boxFileId: string;
      version: string;
    }>;
  };

  return manifest.sourceDocuments.map((document) => ({
    id: document.boxFileId,
    name: document.file,
    version: document.version,
    bytes: new Uint8Array(
      readFileSync(join(root, 'source-docs', document.file)),
    ),
  }));
}
