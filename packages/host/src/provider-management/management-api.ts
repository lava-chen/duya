/**
 * management-api.ts — the Host's provider write side.
 *
 * ## What this is for
 *
 * `config.toml` decides which provider answers a turn, and until now the only
 * code that could change it ran inside Electron. That left the CLI able to
 * select a provider and never add one. This module is the write side moved to
 * the Host so any client of the local control plane can reach it, and it is
 * deliberately the ONLY Host code that touches `[providers.*]`.
 *
 * ## The rules this holds itself to
 *
 * - The key is never in `config.toml`, and never in a response. Reads hand back
 *   `hasApiKey` plus a mask; a write accepts a key and does not echo it.
 * - A declared field is REPLACED, an undeclared one is copied through. The
 *   Desktop editor owns the fields it names; it does not own
 *   `options.model_context`, `extraEnv`, or a hand-written comment.
 * - A mutation reads both files fresh. There is no snapshot cache here, because
 *   the other writer is a GUI that a person is clicking in right now.
 * - `expectedRevision` is optional. Echoing the revision read with the row
 *   turns "the other surface edited this while my form was open" into a
 *   refusal; omitting it is the caller choosing to overwrite blind.
 */

import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { redactSecrets } from '@duya/ai';
import { maskProviderApiKey } from '@duya/agent-protocol/provider-catalog';
import type {
  HostLocalProviderManagementApiV1,
  HostProviderDefaultResult,
  HostProviderDeleteResult,
  HostProviderDetail,
  HostProviderList,
  HostProviderMutationResult,
  HostProviderTestResult,
  HostProviderWriteInput,
} from '@duya/agent-protocol/provider-catalog';
import { resolveDataRoot } from '@duya/data/data-paths';
import { getSecret } from '../worker-config/file-config.js';
import {
  ProviderFileError,
  dropProviderSecret,
  providerFilePaths,
  providerSecretPath,
  readProviderSnapshot,
  revisionOf,
  writeProviderTables,
  type ProviderEntryTable,
  type ProviderFiles,
  type ProviderSnapshot,
} from './provider-files.js';
import { probeProvider, type FetchLike } from './remote-probe.js';

/** A provider id that survives a TOML table header and a flat secret path. */
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A stored key that is really a mask the client read back off a row. */
const MASKED_KEY_PATTERN = /\*{3,}/;

/** A refusal the HTTP layer can turn into a status without guessing. */
export class HostProviderApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HostProviderApiError';
  }
}

export interface ProviderManagementOptions {
  /** Directory holding `config.toml` and `secrets.json`. */
  readonly root?: string | undefined;
  /** Test seam for the connectivity probe. */
  readonly fetchImpl?: FetchLike | undefined;
}

/**
 * Create the provider management API.
 *
 * Mutations run through one queue: the read-modify-write of two files is not
 * atomic on its own, and two clients saving at once would otherwise lose one
 * of them inside the window between the read and the rename.
 */
export function createHostLocalProviderManagementApi(
  options: ProviderManagementOptions = {},
): HostLocalProviderManagementApiV1 {
  const files = providerFilePaths(options.root ?? resolveDataRoot());
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    async listProviders(): Promise<HostProviderList> {
      return listFromFiles(files);
    },

    async upsertProvider(input: HostProviderWriteInput): Promise<HostProviderMutationResult> {
      return serialize(async () => {
        const write = normalizeWrite(input);
        const snapshot = await openForWrite(files, write.expectedRevision);
        const id = write.providerId ?? allocateProviderId(write.name, snapshot.providers);
        if (!PROVIDER_ID_PATTERN.test(id)) {
          throw new HostProviderApiError(
            400,
            'invalid_provider',
            `provider id "${id}" must match ${PROVIDER_ID_PATTERN}`,
          );
        }
        const existing = snapshot.providers[id];
        const secrets = { ...snapshot.secrets };
        const carried = typeof existing?.apiKey === 'string' ? existing.apiKey.trim() : '';

        applyKey(secrets, id, write.apiKey, carried);
        const next = buildEntry(id, existing, write);
        // The key and the `id` field are one value: a row whose own `id` names
        // a different provider resolves inconsistently depending on which
        // reader trusts which.
        next.id = id;
        if (input.validateConnection !== undefined && typeof input.validateConnection !== 'boolean') {
          throw new HostProviderApiError(400, 'invalid_provider', 'validateConnection must be a boolean');
        }
        if (input.validateConnection === true) {
          const outcome = await probeProvider({
            providerId: id,
            providerType: write.providerType,
            baseUrl: write.baseUrl,
            apiKey: secretsKey(secrets, id) ?? '',
          }, options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl });
          if (!outcome.ok) throw new HostProviderApiError(400, 'provider_probe_failed', outcome.message ?? `Connection test failed (${outcome.code})`);
          // An external writer may have changed the files while the probe ran.
          await openForWrite(files, snapshot.revision);
        }
        snapshot.providers[id] = next;

        await persist(files, snapshot, secrets, { providers: true });
        const after = await listFromFiles(files);
        const provider = after.providers.find((row) => row.providerId === id);
        if (provider === undefined) {
          throw new HostProviderApiError(
            500,
            'provider_write_failed',
            `provider "${id}" was written but is not in the file`,
          );
        }
        return { provider, revision: after.revision };
      });
    },

    async deleteProvider(
      providerId: string,
      expectedRevision?: string,
    ): Promise<HostProviderDeleteResult> {
      return serialize(async () => {
        const snapshot = await openForWrite(files, expectedRevision);
        if (!requireEntry(snapshot, providerId)) {
          throw providerNotFound(providerId);
        }
        delete snapshot.providers[providerId];
        const secrets = { ...snapshot.secrets };
        dropProviderSecret(secrets, providerId);

        // A default that points at a deleted provider is a pointer to nothing;
        // every reader tolerates it, but leaving it set means the next turn
        // fails with a message about a provider the user just removed.
        const wasDefault = trimString(snapshot.model.provider) === providerId;
        if (wasDefault) snapshot.model.provider = '';

        await persist(files, snapshot, secrets, { providers: true, model: wasDefault });
        return {
          providerId,
          clearedDefault: wasDefault,
          revision: await revisionOf(files),
        };
      });
    },

    async setDefaultProvider(
      providerId: string | null,
      expectedRevision?: string,
    ): Promise<HostProviderDefaultResult> {
      return serialize(async () => {
        const snapshot = await openForWrite(files, expectedRevision);
        if (providerId !== null && !requireEntry(snapshot, providerId)) {
          throw providerNotFound(providerId);
        }
        // Only the pointer moves. `[model].default` is a separate choice — a
        // provider change that also rewrote the user's model would be two
        // edits dressed as one.
        snapshot.model.provider = providerId ?? '';
        await persist(files, snapshot, null, { model: true });
        const after = await listFromFiles(files);
        return {
          ...(after.activeProviderId === undefined ? {} : { activeProviderId: after.activeProviderId }),
          ...(after.activeModel === undefined ? {} : { activeModel: after.activeModel }),
          revision: after.revision,
        };
      });
    },

    async testProvider(providerId: string): Promise<HostProviderTestResult> {
      const snapshot = await openSnapshot(files);
      const entry = snapshot.providers[providerId];
      if (entry === undefined) throw providerNotFound(providerId);
      const secret = secretsKey(snapshot.secrets, providerId);
      const outcome = await probeProvider(
        {
          baseUrl: trimString(entry.baseUrl),
          apiKey: secret ?? '',
          providerType: trimString(entry.providerType),
          providerId,
        },
        options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
      );
      return {
        ok: outcome.ok,
        code: outcome.code,
        ...(outcome.message === undefined ? {} : { message: outcome.message }),
        latencyMs: outcome.latencyMs,
        modelIds: outcome.modelIds,
        truncated: outcome.truncated,
      };
    },
  };
}

/** The list, read through the same projection the writes return. */
async function listFromFiles(files: ProviderFiles): Promise<HostProviderList> {
  const configRoot = path.dirname(files.configPath);
  try {
    const snapshot = await readProviderSnapshot(files);
    const activeProviderId = trimString(snapshot.model.provider);
    const activeModel = trimString(snapshot.model.default);
    const providers = Object.entries(snapshot.providers).map(([key, entry]) =>
      detailOf(key, entry, snapshot.secrets, activeProviderId),
    );
    return {
      providers,
      supportsCandidateValidation: true,
      ...(activeProviderId === '' ? {} : { activeProviderId }),
      ...(activeModel === '' ? {} : { activeModel }),
      configRoot,
      revision: snapshot.revision,
    };
  } catch (error) {
    // A catalog the caller can still explain beats one that throws: the row
    // the user has to fix is named here, and nowhere else knows it.
    return {
      providers: [],
      configRoot,
      revision: '',
      error: error instanceof Error ? redactSecrets(error.message) : String(error),
    };
  }
}

/** Read a snapshot, refusing to continue when it is stale or unwritable. */
async function openForWrite(
  files: ProviderFiles,
  expectedRevision?: string,
): Promise<ProviderSnapshot> {
  let snapshot: ProviderSnapshot;
  try {
    snapshot = await readProviderSnapshot(files);
  } catch (error) {
    if (error instanceof HostProviderApiError) throw error;
    throw new HostProviderApiError(
      409,
      'provider_config_unwritable',
      error instanceof ProviderFileError
        ? error.message
        : `The provider configuration could not be read: ${
            error instanceof Error ? error.message : String(error)
          }`,
    );
  }
  if (expectedRevision !== undefined && expectedRevision !== snapshot.revision) {
    throw new HostProviderApiError(
      409,
      'provider_revision_conflict',
      'the provider configuration changed since it was read; reload the list and re-apply',
    );
  }
  return snapshot;
}

async function openSnapshot(files: ProviderFiles): Promise<ProviderSnapshot> {
  try {
    return await readProviderSnapshot(files);
  } catch (error) {
    throw new HostProviderApiError(
      409,
      'provider_config_unwritable',
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function persist(
  files: ProviderFiles,
  snapshot: ProviderSnapshot,
  secrets: Record<string, unknown> | null,
  touched: { providers?: boolean; model?: boolean },
): Promise<void> {
  try {
    await writeProviderTables(
      files,
      {
        ...(touched.providers === true ? { providers: snapshot.providers } : {}),
        ...(touched.model === true ? { model: snapshot.model } : {}),
      },
      secrets,
    );
  } catch (error) {
    // `error.message` from the TOML layer names the file and the parse
    // problem, never a value — but a write that failed halfway is worth
    // stating, because the user has to know which of the two files moved.
    throw new HostProviderApiError(
      500,
      'provider_write_failed',
      `the provider configuration could not be saved: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function requireEntry(snapshot: ProviderSnapshot, providerId: string): ProviderEntryTable | null {
  const entry = snapshot.providers[providerId];
  if (entry === undefined) return null;
  if (!PROVIDER_ID_PATTERN.test(providerId)) {
    throw new HostProviderApiError(
      409,
      'provider_config_unwritable',
      `provider key "${providerId}" cannot be written back as a TOML table header`,
    );
  }
  return entry;
}

function providerNotFound(providerId: string): HostProviderApiError {
  return new HostProviderApiError(404, 'provider_not_found', `no provider "${providerId}"`);
}

/**
 * The declared fields of one `[providers.<id>]` row, merged over the stored
 * entry so nothing this surface does not name is lost.
 *
 * `apiKey` is removed from the table on every write. When the file carried one
 * (hand-written, or left by an older Desktop), {@link applyKey} has already
 * moved it to `secrets.json` — dropping it without that move would silently
 * unconfigure a provider the user never asked to change.
 */
function buildEntry(
  id: string,
  existing: ProviderEntryTable | undefined,
  write: NormalizedWrite,
): ProviderEntryTable {
  const entry: ProviderEntryTable = { ...(existing ?? {}) };
  delete entry.apiKey;
  entry.name = write.name;
  if (write.alias === '') delete entry.alias;
  else entry.alias = write.alias;
  entry.providerType = write.providerType;
  entry.baseUrl = write.baseUrl;

  const options: ProviderEntryTable = isRecord(entry.options) ? { ...entry.options } : {};
  if (write.models.length === 0) delete options.enabled_models;
  else options.enabled_models = [...write.models];
  if (write.defaultModel === '') delete options.defaultModel;
  else options.defaultModel = write.defaultModel;
  if (Object.keys(options).length === 0) delete entry.options;
  else entry.options = options;
  return entry;
}

/**
 * Put the key where it belongs: `secrets.json`, never the table.
 *
 * Three cases and no fourth: the caller sent a key (store it), sent `''`
 * (delete it), or sent nothing (keep whatever is there — including a key that
 * is currently sitting in the TOML entry and is about to be stripped from it,
 * which is what `carried` is for).
 *
 * Every case goes through {@link dropProviderSecret} first, because a document
 * that spells the path twice would leave a credential readable after the user
 * cleared it.
 */
function applyKey(
  secrets: Record<string, unknown>,
  providerId: string,
  apiKey: string | undefined,
  carried: string,
): void {
  if (apiKey === undefined) {
    if (carried !== '' && secretsKey(secrets, providerId) === undefined) {
      dropProviderSecret(secrets, providerId);
      secrets[providerSecretPath(providerId)] = carried;
    }
    return;
  }
  dropProviderSecret(secrets, providerId);
  if (apiKey !== '') secrets[providerSecretPath(providerId)] = apiKey;
}

function detailOf(
  key: string,
  entry: ProviderEntryTable,
  secrets: Record<string, unknown>,
  activeProviderId: string,
): HostProviderDetail {
  const options = isRecord(entry.options) ? entry.options : {};
  const stored = secretsKey(secrets, key);
  const models = Array.isArray(options.enabled_models)
    ? options.enabled_models.filter((model): model is string => typeof model === 'string' && model !== '')
    : [];
  const defaultModel = trimString(options.defaultModel);
  const alias = trimString(entry.alias);
  return {
    providerId: key,
    name: trimString(entry.name) || key,
    ...(alias === '' ? {} : { alias }),
    providerType: trimString(entry.providerType) || 'unknown',
    baseUrl: trimString(entry.baseUrl),
    models,
    ...(defaultModel === '' ? {} : { defaultModel }),
    hasApiKey: stored !== undefined,
    maskedApiKey: maskProviderApiKey(stored ?? ''),
    isDefault: activeProviderId !== '' && activeProviderId === key,
  };
}

/** The stored key of a provider, or undefined when it has none worth showing. */
function secretsKey(secrets: Record<string, unknown>, providerId: string): string | undefined {
  // Read through the same resolver the worker uses: `secrets.json` is flat by
  // convention but `getSecret` also walks the nested spelling for the files
  // people write by hand. Reading only the flat key would show `hasApiKey:
  // false` for a provider whose turns work fine.
  const value = getSecret(secrets, providerSecretPath(providerId));
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * A usable id for a new provider: the name, lowercased and dashed, made unique
 * against the keys already in the file.
 *
 * The suffix is random rather than `-2`, `-3`: two people adding the same
 * vendor from two machines hit the deterministic names in the same order and
 * still collide the moment one of those names is edited into the file by hand.
 */
export function allocateProviderId(name: string, taken: Record<string, unknown>): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const base = /^[a-z0-9]/.test(slug) ? slug : `duya-${slug}`.slice(0, 48);
  const desired = base.replace(/-+$/g, '');
  const candidate = /^[a-z0-9][A-Za-z0-9._-]{0,63}$/.test(desired) ? desired : 'provider';
  if (!Object.prototype.hasOwnProperty.call(taken, candidate)) return candidate;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const withSuffix = `${candidate}-${randomBytes(3).toString('hex')}`;
    if (!Object.prototype.hasOwnProperty.call(taken, withSuffix)) return withSuffix;
  }
  throw new HostProviderApiError(
    409,
    'provider_config_unwritable',
    `could not allocate an id for provider "${name}"`,
  );
}

/** A write body after validation: every field present, trimmed, and bounded. */
export interface NormalizedWrite {
  readonly providerId?: string;
  readonly name: string;
  readonly alias: string;
  readonly providerType: string;
  readonly baseUrl: string;
  readonly models: readonly string[];
  readonly defaultModel: string;
  readonly apiKey?: string;
  readonly expectedRevision?: string;
}

/**
 * Validate a write body.
 *
 * Runs on the HTTP boundary as well as here, because the caller that reaches
 * this function from a test does not get to skip the rules — a masked key is
 * refused wherever it came from.
 */
export function normalizeWrite(input: HostProviderWriteInput): NormalizedWrite {
  if (!isRecord(input)) throw invalidWrite('the write body must be an object');
  const raw = input as Record<string, unknown>;
  const name = requireField(raw, 'name', 200);
  const providerType = requireField(raw, 'providerType', 64);
  const alias = optionalField(raw, 'alias', 200);
  const baseUrl = optionalField(raw, 'baseUrl', 500);
  const defaultModel = optionalField(raw, 'defaultModel', 200);
  const providerId = raw.providerId === undefined ? undefined : trimString(raw.providerId);
  if (providerId !== undefined && providerId !== '' && !PROVIDER_ID_PATTERN.test(providerId)) {
    throw invalidWrite(`provider id "${providerId}" must match ${PROVIDER_ID_PATTERN}`);
  }
  if (baseUrl !== '' && !/^https?:\/\//i.test(baseUrl)) {
    throw invalidWrite('baseUrl must start with http:// or https://');
  }
  if (raw.models !== undefined && !Array.isArray(raw.models)) {
    throw invalidWrite('models must be a list of model ids');
  }
  const models = Array.isArray(raw.models) ? uniqueStrings(raw.models, 'model id', 200, 500) : [];
  const apiKey = raw.apiKey === undefined ? undefined : String(raw.apiKey ?? '');
  if (apiKey !== undefined) {
    if (MASKED_KEY_PATTERN.test(apiKey)) {
      throw new HostProviderApiError(
        400,
        'masked_api_key',
        'that looks like a masked key, not a real one; paste the key from the provider console',
      );
    }
    if (apiKey !== '' && /[\s\u0000-\u001f]/.test(apiKey)) {
      throw invalidWrite('an API key cannot contain whitespace or control characters');
    }
    if (apiKey.length > 400) throw invalidWrite('API key is too long');
  }
  const expectedRevision =
    raw.expectedRevision === undefined ? undefined : trimString(raw.expectedRevision);
  return {
    ...(providerId === undefined || providerId === '' ? {} : { providerId }),
    name,
    providerType,
    alias,
    baseUrl,
    models,
    defaultModel,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(expectedRevision === undefined || expectedRevision === ''
      ? {}
      : { expectedRevision }),
  };
}

function requireField(raw: Record<string, unknown>, field: string, max: number): string {
  const value = trimString(raw[field]);
  if (value === '') throw invalidWrite(`${field} is required`);
  if (value.length > max) throw invalidWrite(`${field} is longer than ${max} characters`);
  return value;
}

function optionalField(raw: Record<string, unknown>, field: string, max: number): string {
  const value = raw[field] === undefined ? '' : trimString(raw[field]);
  if (value.length > max) throw invalidWrite(`${field} is longer than ${max} characters`);
  return value;
}

function uniqueStrings(
  values: readonly unknown[],
  label: string,
  maxLength: number,
  maxItems: number,
): string[] {
  if (values.length > maxItems) throw invalidWrite(`${label}: more than ${maxItems} entries`);
  const out: string[] = [];
  for (const value of values) {
    const item = trimString(value);
    if (item === '') throw invalidWrite(`${label}: an entry is empty`);
    if (item.length > maxLength) {
      throw invalidWrite(`${label}: an entry is longer than ${maxLength} characters`);
    }
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

function invalidWrite(message: string): HostProviderApiError {
  return new HostProviderApiError(400, 'invalid_provider', message);
}

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
