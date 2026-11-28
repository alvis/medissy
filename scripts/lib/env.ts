/**
 * environment helpers shared by the operator scripts; values come from the
 * process environment, optionally topped up from an untracked env file
 * (`.env.local` by default); nothing here prints a value
 */
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

import { MIN_PASSPHRASE_CHARS, secretEnvName } from '../../src/demo-idp/secrets';

/** the env file read when `--env-file` is not given */
export const DEFAULT_ENV_FILE = '.env.local';

/** a mutable environment, normally `process.env` */
export type Env = Record<string, string | undefined>;

/**
 * fills unset variables from an env file; variables already set win, so a
 * value exported in the shell is never overridden by the file
 * @param env the environment to fill
 * @param text the env file contents
 * @returns the names that were filled (never the values)
 */
export function mergeEnvText(env: Env, text: string): string[] {
  const filled: string[] = [];

  for (const [name, value] of Object.entries(parseEnv(text))) {
    if (env[name] === undefined && value !== undefined) {
      env[name] = value;
      filled.push(name);
    }
  }

  return filled;
}

/**
 * fills unset variables from an env file when it exists
 * @param env the environment to fill
 * @param path the env file; a missing default file is not an error
 * @param required whether a missing file is an error
 * @returns the names that were filled
 * @throws {Error} when a required file is missing
 */
export function loadEnvFile(env: Env, path: string, required: boolean): string[] {
  if (!existsSync(path)) {
    if (required) {
      throw new Error(`env file not found: ${path}`);
    }

    return [];
  }

  return mergeEnvText(env, readFileSync(path, 'utf8'));
}

/** options every script accepts besides its own */
export interface CommonArgs {
  /** the env file to read, and whether it was named explicitly */
  envFile: { path: string; explicit: boolean };
  /** arguments left for the script */
  rest: string[];
}

/**
 * splits `--env-file <path>` (or `--env-file=<path>`) off the arguments
 * @param argv arguments after the script name
 * @returns the env file and the remaining arguments
 */
export function parseCommonArgs(argv: readonly string[]): CommonArgs {
  const rest: string[] = [];
  let envFile = { path: DEFAULT_ENV_FILE, explicit: false };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';

    if (token === '--') {
      continue;
    }

    if (token === '--env-file') {
      envFile = { path: argv[index + 1] ?? '', explicit: true };
      index += 1;
    } else if (token.startsWith('--env-file=')) {
      envFile = { path: token.slice('--env-file='.length), explicit: true };
    } else {
      rest.push(token);
    }
  }

  return { envFile, rest };
}

/**
 * reads a persona's demo passphrase from `DEMO_IDP_SECRET_<PERSONA>`; a hashed
 * (`scrypt$...`) value cannot sign in from a script, so it is refused
 * @param env the environment
 * @param persona the persona key, e.g. `cardiologist`
 * @returns the plaintext passphrase
 * @throws {Error} naming the variable (never its value) when unusable
 */
export function personaPassphrase(env: Env, persona: string): string {
  const name = secretEnvName(persona);
  const value = env[name];

  if (!value) {
    throw new Error(`${name} is not set; put it in an untracked ${DEFAULT_ENV_FILE}`);
  }

  if (value.startsWith('scrypt$')) {
    throw new Error(`${name} holds a hash; the script needs the plaintext passphrase`);
  }

  if (value.length < MIN_PASSPHRASE_CHARS) {
    throw new Error(`${name} is shorter than ${MIN_PASSPHRASE_CHARS} characters`);
  }

  return value;
}

/**
 * normalises an origin argument: scheme, host and port only
 * @param value the argument
 * @returns the origin, e.g. `https://medissy-abc.sprites.app`
 * @throws {Error} when the value is not an http(s) URL
 */
export function parseOrigin(value: string | undefined): string {
  const url = value ? URL.parse(value) : null;

  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    throw new Error('an origin such as https://medissy-<org>.sprites.app or http://localhost:8080 is required');
  }

  return url.origin;
}
