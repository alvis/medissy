/**
 * per-persona demo passphrases; every synthetic account needs its own
 * passphrase, read from `DEMO_IDP_SECRET_<PERSONA>` (the owner's is
 * `DEMO_IDP_SECRET_OWNER`, separate from every clinician's); a value is either
 * an `scrypt$<salt>$<hash>` string from `hashPassphrase` or plaintext that is
 * hashed at boot; plaintext never stays in memory past `loadPassphrases`;
 * a persona without a configured passphrase cannot sign in
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** prefix of the per-persona environment variables */
export const SECRET_ENV_PREFIX = 'DEMO_IDP_SECRET_';

const HASH_SCHEME = 'scrypt';
const SALT_BYTES = 16;
const HASH_BYTES = 32;
/**
 * shortest accepted plaintext passphrase; lockout is per client (REV03 P1), so
 * an attacker rotating addresses keeps guessing; the length keeps that
 * infeasible for a random passphrase (REV03 P3-3)
 */
export const MIN_PASSPHRASE_CHARS = 20;
/** longest passphrase considered; longer input is rejected before hashing */
const MAX_PASSPHRASE_CHARS = 256;
const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK = 8;
const BYTES_PER_MIB = 1_048_576;
const SCRYPT_MAXMEM_MIB = 64;
const SCRYPT_MAXMEM = SCRYPT_MAXMEM_MIB * BYTES_PER_MIB;
/** fields in a stored hash: scheme, salt and hash */
const HASH_FIELDS = 3;

interface StoredHash {
  salt: Buffer;
  hash: Buffer;
}

/** checks a passphrase attempt for a persona */
export interface PassphraseBook {
  /** personas that have a passphrase and can therefore sign in */
  readonly enabled: ReadonlySet<string>;
  /**
   * checks an attempt in constant time; unknown or disabled personas still cost
   * one scrypt run, so timing does not reveal which personas exist
   */
  check(persona: string, attempt: string): Promise<boolean>;
}

/**
 * derives the scrypt hash of a passphrase
 * @param passphrase the text to derive from
 * @param salt the random salt stored with the hash
 * @returns the derived key
 */
async function derive(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      passphrase.normalize('NFC'),
      salt,
      HASH_BYTES,
      { N: SCRYPT_COST, r: SCRYPT_BLOCK, p: 1, maxmem: SCRYPT_MAXMEM },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/**
 * hashes a passphrase for `DEMO_IDP_SECRET_<PERSONA>`
 * @param passphrase the plaintext, at least `MIN_PASSPHRASE_CHARS` long
 * @returns `scrypt$<salt>$<hash>`, both base64url
 */
export async function hashPassphrase(passphrase: string): Promise<string> {
  if (passphrase.length < MIN_PASSPHRASE_CHARS) {
    throw new RangeError(
      `a demo passphrase needs at least ${MIN_PASSPHRASE_CHARS} characters`,
    );
  }

  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(passphrase, salt);

  return `${HASH_SCHEME}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

/**
 * turns a configured value into a stored hash, hashing plaintext
 * @param value an `scrypt$...` string or plaintext
 * @returns the salt and hash
 */
async function toStoredHash(value: string): Promise<StoredHash> {
  const parts = value.split('$');

  if (parts[0] === HASH_SCHEME && parts.length === HASH_FIELDS) {
    const salt = Buffer.from(parts[1] ?? '', 'base64url');
    const hash = Buffer.from(parts[2] ?? '', 'base64url');

    if (salt.length !== SALT_BYTES || hash.length !== HASH_BYTES) {
      throw new RangeError('a demo passphrase hash is malformed');
    }

    return { salt, hash };
  }

  const [, salt = '', hash = ''] = (await hashPassphrase(value)).split('$');

  return {
    salt: Buffer.from(salt, 'base64url'),
    hash: Buffer.from(hash, 'base64url'),
  };
}

/**
 * names the environment variable holding a persona's passphrase
 * @param persona the persona key, e.g. `unknown-clinician`
 * @returns e.g. `DEMO_IDP_SECRET_UNKNOWN_CLINICIAN`
 */
export function secretEnvName(persona: string): string {
  return `${SECRET_ENV_PREFIX}${persona.toUpperCase().replaceAll('-', '_')}`;
}

/**
 * reads each persona's passphrase from the environment
 * @param env the environment
 * @param personas persona keys
 * @returns configured values by persona; missing ones are omitted
 */
export function passphrasesFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  personas: readonly string[],
): Record<string, string> {
  const values: Record<string, string> = {};

  for (const persona of personas) {
    const value = env[secretEnvName(persona)];

    if (value) {
      values[persona] = value;
    }
  }

  return values;
}

/**
 * builds the passphrase book from configured values
 * @param values plaintext or hashed passphrases by persona key
 * @returns the book
 */
export async function loadPassphrases(
  values: Readonly<Record<string, string | undefined>>,
): Promise<PassphraseBook> {
  const hashes = new Map<string, StoredHash>();

  for (const [persona, value] of Object.entries(values)) {
    if (value) {
      hashes.set(persona, await toStoredHash(value));
    }
  }

  // compared against when the persona is unknown, so the work is the same
  const decoy = await toStoredHash(randomBytes(SALT_BYTES).toString('hex'));

  return {
    enabled: new Set(hashes.keys()),
    /**
     * checks an attempt against a persona's stored hash, doing the same work
     * for an unknown persona
     * @param persona the synthetic account key
     * @param attempt the passphrase the person typed
     * @returns true when the persona exists and the attempt matches
     */
    async check(persona, attempt) {
      const stored = hashes.get(persona);
      const target = stored ?? decoy;
      const bounded = attempt.slice(0, MAX_PASSPHRASE_CHARS);
      const derived = await derive(bounded, target.salt);
      const equal = timingSafeEqual(derived, target.hash);

      return (
        stored !== undefined &&
        equal &&
        attempt.length > 0 &&
        attempt.length <= MAX_PASSPHRASE_CHARS
      );
    },
  };
}
