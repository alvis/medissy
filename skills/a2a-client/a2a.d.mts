/** types for the generic A2A client script, for the tests that import it */

/** what the client runs with */
export interface ClientIo {
  /** the transport; redirects are refused, never followed */
  fetch: typeof fetch;
  /** the environment; `A2A_ALLOWED_ORIGINS` and `A2A_REQUEST_TIMEOUT_MS` are read */
  env: Record<string, string | undefined>;
  /** the sink for the one JSON envelope */
  stdout: (text: string) => void;
  /** never written: task ids and sign-in codes stay out of logs */
  stderr: (text: string) => void;
  /** the wait between polls */
  sleep: (ms: number) => Promise<void>;
  /** the clock, in milliseconds */
  now: () => number;
  /**
   * a saver of one checked artifact image that returns its path; defaults to an
   * owner-only file in a fresh private temporary directory
   */
  saveImage?: (bytes: Buffer, ext: string) => string;
}

/**
 * runs one command and prints one JSON envelope
 * @param argv the arguments after the script
 * @param io the io
 * @returns the exit code: 0 answered, 1 refused or failed, 2 usage error
 */
export function main(argv: string[], io: ClientIo): Promise<number>;
