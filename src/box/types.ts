/** which implementation produced a sync; stored on every `sync_runs` row */
export const ADAPTER_KINDS = ['box-connector', 'fixture'] as const;
export type AdapterKind = (typeof ADAPTER_KINDS)[number];

/** a file the adapter reports in the allowed folder; all fields are untrusted */
export interface SourceFileEntry {
  id: string;
  name: string;
  /** size in bytes as declared by the source */
  size: number;
  /** source version identifier (Box file version id) */
  version: string;
}

/** metadata for one file, including the folder it sits in */
export interface SourceFileMetadata extends SourceFileEntry {
  parentId: string;
  /** Box file version id, when the source reports one; used to pin downloads */
  versionId?: string;
}

/** one listing: the entries seen, and whether more existed beyond the cap */
export interface SourceListing {
  entries: SourceFileEntry[];
  truncated: boolean;
}

/**
 * the one interface both sources implement; the sync service never sees which
 * one it has beyond `kind` and `label`
 */
export interface SourceAdapter {
  readonly kind: AdapterKind;
  /** human-readable label; the fixture adapter's label says it is test-only */
  readonly label: string;
  /** the configured allowed folder; nothing outside it is ever read */
  readonly folderId: string;
  /**
   * lists the files directly inside the allowed folder
   * @returns untrusted file entries and whether the listing was cut short
   */
  list(): Promise<SourceListing>;
  /**
   * fetches metadata for one file id
   * @param fileId a validated numeric file id
   * @returns the file metadata including its parent folder id
   */
  metadata(fileId: string): Promise<SourceFileMetadata>;
  /**
   * downloads one file body, never more than `maxBytes`
   * @param fileId a validated numeric file id
   * @param maxBytes hard cap on the body size
   * @param versionId the version to fetch, so the bytes match the label
   * @returns the raw bytes
   */
  download(
    fileId: string,
    maxBytes: number,
    versionId?: string,
  ): Promise<Uint8Array>;
}

/** a file the secure store accepted, as the store reports it */
export interface FiledFile {
  /** numeric Box file id */
  fileId: string;
  /** Box file version id, used as the provenance version */
  version: string;
  name: string;
  size: number;
}

/**
 * the patient's secure store for records a clinician hands back (ADR-10);
 * Box behind the Sprites connector is one implementation; the tests-only
 * fixture store is another; every upload lands in the configured folder:
 * the caller never chooses a parent
 */
export interface SecureStore {
  readonly kind: AdapterKind;
  /** human-readable label; the fixture store's label says it is test-only */
  readonly label: string;
  /** the configured allowed folder every upload is filed into */
  readonly folderId: string;
  /**
   * files one new document into the allowed folder
   * @param file a generated safe name and the bytes to store
   * @param file.name the generated name, safe for Box and the sync
   * @param file.bytes the document bytes
   * @returns the stored file's id, version, name and size
   * @throws {SourceAdapterError} on any refusal, redirect or bad response
   */
  upload(file: { name: string; bytes: Uint8Array }): Promise<FiledFile>;
}

export type AdapterErrorCode =
  | 'http-status'
  | 'redirect-refused'
  | 'too-large'
  | 'bad-response'
  | 'network'
  | 'not-found';

/** an adapter failure; the message never carries a response body or URL */
export class SourceAdapterError extends Error {
  public readonly code: AdapterErrorCode;

  public readonly status: number | undefined;

  /**
   * @param code the failure category
   * @param status HTTP status when the failure came from one
   */
  constructor(code: AdapterErrorCode, status?: number) {
    super(status === undefined ? code : `${code}:${status}`);
    this.name = 'SourceAdapterError';
    this.code = code;
    this.status = status;
  }
}

/** why a file was not imported; stored as a content-free reason code */
export const REJECTION_REASONS = [
  'invalid-file-id',
  'invalid-version',
  'unsafe-name',
  'unsupported-type',
  'not-in-allowed-folder',
  'oversized',
  'size-mismatch',
  'empty',
  'not-utf8',
  'malformed-json',
  'malformed-structure',
  'too-many-entries',
  'unsupported-resource',
  'unclassified-content',
  'duplicate-resource-id',
  'invalid-record',
  'foreign-patient',
  'mixed-patient',
  'missing-patient-marker',
  'fetch-failed',
  'version-conflict',
  'listing-truncated',
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];
