import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

/**
 * Load `.env.local` into `process.env` without overwriting anything already set.
 *
 * Small on purpose — the integration scripts need four values and nothing here
 * should pull a dependency into a package that ships.
 */
export function loadEnv(file = resolve(repoRoot, '.env.local')): void {
  let contents: string;
  try {
    contents = readFileSync(file, 'utf8');
  } catch {
    return; // Nothing to load; the caller reports what is missing.
  }

  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] ??= value;
  }
}

/** Read a required variable, or exit with a message naming what to set. */
export function required(name: string, hint: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    console.error(`Missing ${name}. ${hint}`);
    console.error(`Set it in ${resolve(repoRoot, '.env.local')} (gitignored) or in the environment.`);
    process.exit(1);
  }
  return value.trim();
}

/** Read an optional variable. */
export function optional(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

/** Show a credential's shape without showing the credential. */
export function fingerprint(secret: string): string {
  if (secret.length <= 8) return `${'*'.repeat(secret.length)} (${secret.length} chars)`;
  return `${secret.slice(0, 4)}…${secret.slice(-4)} (${secret.length} chars)`;
}
