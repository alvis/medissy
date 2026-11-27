/**
 * each synthetic issuer's ES256 signing key, one `idp_store` row per issuer
 * (`IssuerProfile.signingKeyId`); it is generated on first start and kept
 * in the vault (gitignored SQLite on the Sprite volume), never in the
 * repository; with `DEMO_IDP_KEY_ENCRYPTION_KEY` set, the stored row is
 * AES-256-GCM ciphertext bound to its row; without it the row holds the
 * private JWK in plaintext (allowed only for a local http run; see
 * `parseKeyEncryptionKey` and `createFromEnv`)
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';

import type { DatabaseSync } from 'node:sqlite';

import type { JWK } from 'jose';

/** `idp_store` model of the key rows; no provider model uses this name */
const KEY_MODEL = 'MedissySigningKey';
/** the patient issuer's row id, kept from before there were two issuers */
const DEFAULT_KEY_ID = 'es256';
const ALG = 'ES256';
const CIPHER = 'aes-256-gcm';
const ENCRYPTION = 'A256GCM';
const KEK_BYTES = 32;
const IV_BYTES = 12;

/** the private signing key and its public half */
export interface SigningKey {
  /** private JWK handed to oidc-provider; never leaves the process */
  privateJwk: JWK;
  /** public JWK for verifiers */
  publicJwk: JWK;
}

interface Sealed {
  enc: typeof ENCRYPTION;
  iv: string;
  tag: string;
  ct: string;
}

/**
 * parses `DEMO_IDP_KEY_ENCRYPTION_KEY`: 32 random bytes, base64url
 * @param value the configured value
 * @returns the 32-byte key
 */
export function parseKeyEncryptionKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64url');

  if (key.length !== KEK_BYTES || key.toString('base64url') !== value) {
    throw new RangeError(
      'DEMO_IDP_KEY_ENCRYPTION_KEY must be 32 random bytes, base64url-encoded',
    );
  }

  return key;
}

/**
 * strips the private member from an EC JWK
 * @param jwk the private key
 * @returns the public key with the same id and use
 */
function toPublic(jwk: JWK): JWK {
  const { d: _private, ...rest } = jwk;

  return rest;
}

/**
 * builds the additional data binding a ciphertext to its row, so it cannot be
 * moved to another row (another issuer's key) and still decrypt
 * @param keyId the row id
 * @returns the additional authenticated data
 */
function aadFor(keyId: string): Buffer {
  return Buffer.from(`${KEY_MODEL}/${keyId}`);
}

/**
 * encrypts the private JWK for storage
 * @param jwk the private key
 * @param sealing the key-encryption key and the row id it is bound to
 * @param sealing.kek the key-encryption key
 * @param sealing.keyId the row id
 * @returns the sealed payload
 */
function seal(jwk: JWK, sealing: { kek: Buffer; keyId: string }): Sealed {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER, sealing.kek, iv).setAAD(
    aadFor(sealing.keyId),
  );
  const ct = Buffer.concat([
    cipher.update(JSON.stringify(jwk), 'utf8'),
    cipher.final(),
  ]);

  return {
    enc: ENCRYPTION,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ct: ct.toString('base64url'),
  };
}

/**
 * decrypts a stored payload; a wrong key, a tampered row or a row moved from
 * another id throws
 * @param sealed the stored payload
 * @param sealing the key-encryption key and the row id it is bound to
 * @param sealing.kek the key-encryption key
 * @param sealing.keyId the row id
 * @returns the private key
 */
function open(sealed: Sealed, sealing: { kek: Buffer; keyId: string }): JWK {
  const decipher = createDecipheriv(
    CIPHER,
    sealing.kek,
    Buffer.from(sealed.iv, 'base64url'),
  )
    .setAAD(aadFor(sealing.keyId))
    .setAuthTag(Buffer.from(sealed.tag, 'base64url'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(sealed.ct, 'base64url')),
    decipher.final(),
  ]);

  return JSON.parse(plain.toString('utf8')) as JWK;
}

/**
 * reads the stored key, re-sealing a plaintext row when a key is configured
 * @param db the vault
 * @param stored the row payload
 * @param row the key-encryption key, if configured, and the row id
 * @param row.kek the key-encryption key
 * @param row.keyId which issuer's `idp_store` row, also bound into the AAD
 * @returns the private key
 */
function readStored(
  db: DatabaseSync,
  stored: Sealed | JWK,
  row: { kek: Buffer | undefined; keyId: string },
): JWK {
  const { kek, keyId } = row;

  if ('enc' in stored) {
    if (!kek) {
      throw new Error(
        'the demo IdP signing key is encrypted; set DEMO_IDP_KEY_ENCRYPTION_KEY',
      );
    }

    return open(stored, { kek, keyId });
  }

  const jwk = stored;

  if (kek) {
    db.prepare(
      'UPDATE idp_store SET payload = ? WHERE model = ? AND id = ?',
    ).run(JSON.stringify(seal(jwk, { kek, keyId })), KEY_MODEL, keyId);
  }

  return jwk;
}

/** options for `loadOrCreateSigningKey` */
export interface SigningKeyOptions {
  /** encrypts the stored row (`DEMO_IDP_KEY_ENCRYPTION_KEY`) */
  kek?: Buffer;
  /** the issuer's row id; defaults to the patient issuer's */
  keyId?: string;
}

/**
 * loads an issuer's stored signing key, or generates and stores one on first
 * start
 * @param db a vault opened through `openVault`
 * @param options the key-encryption key and the issuer's row id
 * @returns the key pair
 */
export async function loadOrCreateSigningKey(
  db: DatabaseSync,
  options: SigningKeyOptions = {},
): Promise<SigningKey> {
  const { kek, keyId = DEFAULT_KEY_ID } = options;
  const row = db
    .prepare('SELECT payload FROM idp_store WHERE model = ? AND id = ?')
    .get(KEY_MODEL, keyId) as { payload: string } | undefined;

  if (row) {
    const privateJwk = readStored(db, JSON.parse(row.payload) as Sealed | JWK, {
      kek,
      keyId,
    });

    return { privateJwk, publicJwk: toPublic(privateJwk) };
  }

  const { privateKey } = await generateKeyPair(ALG, { extractable: true });
  const exported = await exportJWK(privateKey);
  const privateJwk: JWK = {
    ...exported,
    kid: await calculateJwkThumbprint(exported),
    alg: ALG,
    use: 'sig',
  };
  const payload = kek ? seal(privateJwk, { kek, keyId }) : privateJwk;

  // INSERT without OR IGNORE: a concurrent first start fails loudly instead of
  // silently signing with a key nobody else holds
  db.prepare('INSERT INTO idp_store (model, id, payload) VALUES (?, ?, ?)').run(
    KEY_MODEL,
    keyId,
    JSON.stringify(payload),
  );

  return { privateJwk, publicJwk: toPublic(privateJwk) };
}
