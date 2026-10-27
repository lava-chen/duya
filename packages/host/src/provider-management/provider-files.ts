/**
 * provider-files.ts — the on-disk half of provider management.
 *
 * ## What this owns
 *
 * Two files, one logical record. `[providers.<id>]` and `[model]` live in
 * `config.toml`; the key that makes a provider answer lives in `secrets.json`
 * under the FLAT path `providers.<id>.apiKey`. That split is the Desktop config
 * store's contract (`collectSecrets` / `mergeSecrets` in
 * `apps/desktop/src/main/config/store.ts`), and a Host that put the key in
 * `config.toml` would write a credential into the file users are told to edit
 * by hand and to paste into issue reports.
 *
 * ## Why the order is secrets first
 *
 * A provider write that lands in one file and not the other is a row that
 * lies. Writing `secrets.json` first means the intermediate state is an orphan
 * key with no row — invisible, because every reader starts from the row — and
 * the row then arrives with its key already present. The reverse order would
 * put a `hasApiKey: false` provider on screen, which reads as "the user's key
 * disappeared". A failed `config.toml` write leaves the orphan behind, which
 * the next upsert of that id overwrites.
 *
 * ## Refusal, not empty
 *
 * A `secrets.json` that exists but does not parse is refused rather than read
 * as empty: an empty map plus a write is how the other surfaces' credentials
 * vanish. Same rule as `readConfigTomlDocument`.
 */

import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  readConfigNamespace,
  readConfigTomlDocument,
  readRawConfig,
  writeConfigNamespace,
  writeFileAtomic,
} from '../config-agents/config-file.js';

/** The two files a provider write touches. */
export interface ProviderFiles {
  readonly configPath: string;
  readonly secretsPath: string;
}

export function providerFilePaths(root: string): ProviderFiles {
  return {
    configPath: path.join(root, 'config.toml'),
    secretsPath: path.join(root, 'secrets.json'),
  };
}

/** One `[providers.<id>]` entry exactly as the file holds it. */
export type ProviderEntryTable = Record<string, unknown>;

/** Both files as one snapshot, plus the revision they hash to. */
export interface ProviderSnapshot {
  /** Every `[providers.*]` entry, keyed by table name. */
  readonly providers: Record<string, ProviderEntryTable>;
  /** The `[model]` table — `provider` and `default` are the active pointers. */
  readonly model: Record<string, unknown>;
  /** The whole `secrets.json` document, flat dotted keys included. */
  readonly secrets: Record<string, unknown>;
  readonly revision: string;
}

/** The `secrets.json` path a provider's key lives under. */
export function providerSecretPath(providerId: string): string {
  return `providers.${providerId}.apiKey`;
}

/**
 * Remove a provider's key in BOTH spellings `secrets.json` allows.
 *
 * The convention is a flat dotted key, and the file that is read by hand often
 * spells it nested — `getSecret` accepts either, flat first. So clearing only
 * one spelling leaves a credential the worker can still read after the user
 * watched this surface delete it, and setting one leaves a value that becomes
 * live again the day the flat key goes.
 *
 * Mutates the map it is given. The empty parents it prunes are objects that
 * carry nothing, which in a secrets document is not a state worth keeping.
 */
export function dropProviderSecret(secrets: Record<string, unknown>, providerId: string): void {
  delete secrets[providerSecretPath(providerId)];
  const providers = secrets.providers;
  if (!isPlainMap(providers)) return;
  const entry = providers[providerId];
  if (isPlainMap(entry)) {
    delete entry.apiKey;
    if (Object.keys(entry).length === 0) delete providers[providerId];
  }
  if (Object.keys(providers).length === 0) delete secrets.providers;
}

function isPlainMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The file state is not something this surface may write over. */
export class ProviderFileError extends Error {}

/**
 * Read both files as one snapshot.
 *
 * Throws {@link ProviderFileError} when a file exists in a shape that cannot
 * be written back over — a `[[providers]]` array, a `secrets.json` that does
 * not parse. A missing `config.toml` is not an error: the first provider
 * creates it.
 */
export async function readProviderSnapshot(files: ProviderFiles): Promise<ProviderSnapshot> {
  const doc = await readConfigTomlDocument(files.configPath);
  return {
    providers: readProviderEntries(doc),
    // `[model]` is a flat table (`default`, `provider`, `base_url`): its values
    // are the scalars themselves, not entries to validate.
    model: readConfigNamespace(doc, 'model'),
    secrets: await readSecretsDocument(files.secretsPath),
    revision: await revisionOf(files),
  };
}

/** The `[providers.*]` map as mutable shallow copies. */
function readProviderEntries(doc: Record<string, unknown>): Record<string, ProviderEntryTable> {
  const table = readConfigNamespace(doc, 'providers');
  const out: Record<string, ProviderEntryTable> = {};
  for (const [key, value] of Object.entries(table)) {
    // `[[providers]]` (an array of tables) or a stray scalar cannot be replaced
    // table by table, so it is reported rather than skipped: the alternative is
    // a namespace write that quietly deletes what the user configured.
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new ProviderFileError(
        `config.toml \`providers.${key}\` is not a table; fix the file by hand — ` +
          'nothing here rewrites it',
      );
    }
    out[key] = { ...(value as ProviderEntryTable) };
  }
  return out;
}

async function readSecretsDocument(secretsPath: string): Promise<Record<string, unknown>> {
  let raw: string | null;
  try {
    raw = await readRawConfig(secretsPath);
  } catch (error) {
    throw new ProviderFileError(
      `Cannot read ${secretsPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (raw === null || raw.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new ProviderFileError(
      `${secretsPath} is not a JSON object (${
        error instanceof Error ? error.message : String(error)
      }); the write was refused so no stored credential is lost`,
    );
  }
}

/**
 * A content hash of both files, as short as a row can be.
 *
 * `''` when neither file exists: "no configuration yet" is one value, and a
 * client that echoes it back proves nothing appeared while its form was open.
 */
export async function revisionOf(files: ProviderFiles): Promise<string> {
  const [config, secrets] = await Promise.all([
    readRawConfig(files.configPath),
    readRawConfig(files.secretsPath),
  ]);
  if (config === null && secrets === null) return '';
  const digest = createHash('sha256');
  digest.update(config ?? '\0');
  digest.update('\0');
  digest.update(secrets ?? '\0');
  return digest.digest('hex').slice(0, 16);
}

/**
 * Persist one mutation.
 *
 * Only the namespaces the caller names are rewritten, so setting the default
 * provider does not touch a byte of `[providers.*]`. `secrets` is the WHOLE
 * document — the caller started from a snapshot, so a partial write cannot drop
 * another surface's keys — and null skips the file.
 *
 * Secrets go first: see the header for why the order is not a detail.
 */
export async function writeProviderTables(
  files: ProviderFiles,
  tables: {
    providers?: Record<string, ProviderEntryTable>;
    model?: Record<string, unknown>;
  },
  secrets: Record<string, unknown> | null,
): Promise<void> {
  if (secrets !== null) {
    await writeFileAtomic(files.secretsPath, `${JSON.stringify(secrets, null, 2)}\n`);
  }
  if (tables.providers !== undefined) {
    await writeConfigNamespace(files.configPath, 'providers', tables.providers);
  }
  if (tables.model !== undefined) {
    await writeConfigNamespace(files.configPath, 'model', tables.model);
  }
}
