/* eslint-disable no-console -- an operator CLI */
/**
 * the explicit demo cleanup path (brief §8): reset the vault to the seeded
 * state; grants, invitations, connections, scope requests and audit rows
 * are append-only (no-delete triggers), so the reset removes the SQLite file
 * and its WAL/SHM siblings, then re-seeds; both synthetic issuers' signing
 * keys (/demo-idp and /institution-idp) live in the vault too, so new ones
 * are generated on the next boot and every earlier token stops verifying
 *
 * usage: pnpm cleanup [--yes] [--no-seed] [--records fixture|none] [--env-file <path>]
 * refuses while a Medissy answers /healthz on 127.0.0.1:$PORT (stop the
 * service first), and refuses a DATABASE_PATH that is not a `.sqlite` file;
 * without `--yes` it asks you to type `reset`
 */
import { existsSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

import { loadEnvFile, parseCommonArgs } from './lib/env';
import { describeSeed, runSeed } from './seed';

import type { Env } from './lib/env';

const DEFAULT_PORT = '8080';
const HEALTH_TIMEOUT_MS = 1500;
/** what the operator must type to confirm */
export const CONFIRM_WORD = 'reset';

/**
 * lists the files that make up a vault
 * @param path the database path
 * @returns the database and its journal siblings
 */
export function vaultFiles(path: string): string[] {
  return [path, `${path}-wal`, `${path}-shm`, `${path}-journal`];
}

/**
 * refuses any path that is not a SQLite vault file
 * @param path DATABASE_PATH
 * @returns the path
 * @throws {Error} for an unset, in-memory or non-`.sqlite` path
 */
export function checkVaultPath(path: string | undefined): string {
  if (!path || path === ':memory:' || !path.endsWith('.sqlite')) {
    throw new Error('DATABASE_PATH must name a .sqlite file; refusing to delete anything else');
  }

  return path;
}

/**
 * checks whether the answer confirms the reset
 * @param answer what the operator typed
 * @returns true only for the exact confirm word
 */
export function confirms(answer: string): boolean {
  return answer.trim() === CONFIRM_WORD;
}

/**
 * checks whether a Medissy is answering on the local port (it holds the vault open)
 * @param env the environment (PORT)
 * @returns true when /healthz answers
 */
async function serverRunning(env: Env): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${env.PORT ?? DEFAULT_PORT}/healthz`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });

    return res.ok;
  } catch {
    return false;
  }
}

if (import.meta.main) {
  try {
    const argv = process.argv.slice(2);
    const { envFile, rest } = parseCommonArgs(argv);

    loadEnvFile(process.env, envFile.path, envFile.explicit);

    const path = checkVaultPath(process.env.DATABASE_PATH);

    if (await serverRunning(process.env)) {
      throw new Error('Medissy is still running on this host; stop it first (locally Ctrl-C, on the Sprite `sprite-env services stop medissy`)');
    }

    if (!rest.includes('--yes')) {
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await prompt.question(`This deletes the demo vault ${path} (synthetic data, grants, audit). Type "${CONFIRM_WORD}" to continue: `);

      prompt.close();

      if (!confirms(answer)) {
        throw new Error('not confirmed; nothing was deleted');
      }
    }

    const removed = vaultFiles(path).filter((file) => existsSync(file));

    for (const file of removed) {
      rmSync(file, { force: true });
    }

    console.log(`removed ${removed.length} vault file(s)`);

    if (!rest.includes('--no-seed')) {
      for (const line of describeSeed(await runSeed(argv.filter((arg) => arg !== '--yes' && arg !== '--no-seed')))) {
        console.log(line);
      }
    }
  } catch (error) {
    console.error(`cleanup failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  }
}

/* eslint-enable no-console */
