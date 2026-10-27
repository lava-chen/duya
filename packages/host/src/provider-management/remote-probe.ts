/**
 * remote-probe.ts — ask one configured provider what it serves.
 *
 * ## Why one call answers both questions
 *
 * The TUI needs a connectivity test (`t`) and a remote model list (`r`), and
 * the only request a key-having endpoint will answer for a chat provider is
 * its own model list. Two routes would fetch the same URL twice and report two
 * different verdicts about the same endpoint, so there is one: the probe
 * returns its health AND the ids it got back.
 *
 * ## What the built-in catalog contributes
 *
 * `config.toml` names an endpoint and a `providerType`; it does not say where
 * that vendor's model list lives. That is a vendor fact, and `@duya/ai`'s
 * catalog carries it (`modelsSource`: a path, an absolute URL, or `static`).
 * Reading it here is what makes the probe work for `ollama` (`/api/tags`)
 * instead of assuming every endpoint is the OpenAI one.
 *
 * The entry is resolved two ways, in this order, because the two fields answer
 * for different things:
 *   - `providerType` decides the AUTH, and it is the family the worker itself
 *     switches on (`mapProviderType`), so the probe must not use a header the
 *     run will not use. `config.toml` spells it as the legacy protocol
 *     (`anthropic`, `openai-compatible`, `openrouter`), which the catalog
 *     carries as `legacyProtocol` — a value several entries share, so the first
 *     match is a family sample, not the vendor.
 *   - the table key decides the ENDPOINT, and it equals a catalog `id` for
 *     every provider the Desktop wrote (`minimax-cn`, `openrouter`). This is
 *     the same resolution `findPresetEntry` in `worker-config/provider-catalog.ts`
 *     documents: exact id, then the first id that extends it.
 *
 * ## What never leaves this file
 *
 * The key. A failure message names the endpoint and the status, and any
 * occurrence of the submitted key is replaced before the string is returned —
 * an upstream that echoes the request's Authorization header into its error
 * body is a real thing this has to survive.
 */

import type { HostProviderProbeCode } from '@duya/agent-protocol/provider-catalog';
import { BUILTIN_CATALOG, type ProviderCatalogEntry } from '@duya/ai';
import { mapProviderType } from '../worker-config/file-config.js';

/** How long to wait for a vendor that is not going to answer. */
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Cap on the ids a probe returns.
 *
 * An aggregator lists hundreds of models; a panel that received all of them
 * would spend the user's scroll wheel on a row nobody enabled. The cap is
 * reported (`truncated`) rather than hidden, because "this endpoint has more"
 * is a fact about the provider.
 */
const MAX_MODEL_IDS = 400;

/** One probe of one provider. */
export interface ProbeTarget {
  /** `ProviderEntry.baseUrl` as configured — the writer does not normalize it. */
  readonly baseUrl: string;
  /** The stored key, or `''`. Never returned. */
  readonly apiKey: string;
  /** `ProviderEntry.providerType`, used to find the built-in entry. */
  readonly providerType: string;
  /** The configuration table key, which is what the catalog is indexed by. */
  readonly providerId: string;
}

export interface ProbeOutcome {
  readonly ok: boolean;
  readonly code: HostProviderProbeCode;
  readonly message?: string;
  readonly latencyMs: number;
  readonly modelIds: readonly string[];
  readonly truncated: boolean;
}

/** The shape of `fetch` this probe needs, so a test can answer without a port. */
export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface ProbeOptions {
  readonly timeoutMs?: number;
  readonly fetchImpl?: FetchLike;
}

/** The vendor facts a probe reads off the catalog, resolved for one target. */
interface ProbeStyle {
  /** The Anthropic family takes `x-api-key`, everyone else a bearer token. */
  readonly anthropicAuth: boolean;
  /** A local runtime answers unsigned, so an empty key is not a fault. */
  readonly keyOptional: boolean;
  /** False for a provider that authenticates from the environment. */
  readonly testable: boolean;
  /** List endpoints to try, best guess first. */
  readonly paths: readonly string[];
}

/**
 * Entries that can stand for a `providerType` family.
 *
 * Media presets are dropped: `providerType` is shared by a chat vendor and its
 * image endpoint, and the image row's list path is not the chat endpoint's.
 */
function catalogEntries(): readonly ProviderCatalogEntry[] {
  return BUILTIN_CATALOG.list().filter((entry) => entry.category !== 'media');
}

/** The catalog row a configured provider's vendor corresponds to; see the header. */
function resolveStyle(target: ProbeTarget, isLoopback: boolean): ProbeStyle {
  const entries = catalogEntries();
  const family =
    entries.find((entry) => entry.legacyProtocol === target.providerType) ??
    entries.find((entry) => entry.protocol === target.providerType);
  const prefix = `${target.providerId}-`;
  const preset =
    entries.find((entry) => entry.id === target.providerId) ??
    entries.find((entry) => entry.id.startsWith(prefix));
  const named = preset ?? family;

  const paths: string[] = [];
  for (const entry of [preset, family]) {
    const source = entry?.modelsSource;
    if (source?.type === 'custom-url') paths.push(source.url);
    else if (source?.type === 'openai-compatible-models') paths.push(source.path ?? '/v1/models');
  }
  paths.push('/v1/models', '/models');

  return {
    // The runtime's own classification wins; the catalog family is the fallback
    // for a providerType the worker does not map (`google`, `openai-responses`).
    anthropicAuth:
      mapProviderType(target.providerType) === 'anthropic' ||
      (mapProviderType(target.providerType) === undefined && named?.protocol === 'anthropic'),
    // A local runtime is identified by its catalog row OR by dialing this
    // machine, because a hand-written table key has no row to resolve to.
    // Guessing "optional" when the row is unknown costs one unsigned HTTP
    // answer instead of a refusal the user cannot act on; guessing the other
    // way tells someone to go get an API key for Ollama.
    keyOptional: named?.providerCategory === 'local' || isLoopback,
    testable: target.providerType !== 'bedrock' && target.providerType !== 'vertex',
    paths,
  };
}

/**
 * The endpoints a style would try, normalised, deduped, and capped.
 *
 * Three at most, so a dead endpoint costs three timeouts instead of six.
 */
function pathsOf(style: ProbeStyle): string[] {
  const seen = new Set<string>();
  return style.paths
    .map((candidate) => (candidate.startsWith('/') ? candidate : `/${candidate}`))
    .filter((candidate) => (seen.has(candidate) ? false : seen.add(candidate)))
    .slice(0, 3);
}

/** The list endpoints a configured provider could answer from, best guess first. */
export function candidatePaths(target: ProbeTarget): string[] {
  return pathsOf(resolveStyle(target, isLoopbackHost(target.baseUrl)));
}

/** `x-api-key` for the Anthropic family, `Authorization` for everyone else. */
function authHeaders(style: ProbeStyle, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey === '') return headers;
  if (style.anthropicAuth) {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    return headers;
  }
  headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

/**
 * True for an endpoint on this machine, which is how a local runtime is
 * recognised when the table key is a hand-written name the catalog does not
 * know (`[providers.my-llama]`).
 */
function isLoopbackHost(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

/**
 * Probe `target`'s endpoint.
 *
 * Never throws: a provider whose host does not resolve is a state of the
 * configuration, and the caller's job is to put that state on screen.
 */
export async function probeProvider(
  target: ProbeTarget,
  options: ProbeOptions = {},
): Promise<ProbeOutcome> {
  const base = target.baseUrl.trim().replace(/\/+$/, '');
  if (base === '') {
    return { ok: false, code: 'no_base_url', message: 'no baseUrl configured', latencyMs: 0, modelIds: [], truncated: false };
  }
  if (!/^https?:\/\//i.test(base)) {
    return {
      ok: false,
      code: 'rejected',
      message: `baseUrl "${redactBaseUrl(base)}" is not an http(s) URL`,
      latencyMs: 0,
      modelIds: [],
      truncated: false,
    };
  }
  const apiKey = target.apiKey.trim();
  const style = resolveStyle(target, isLoopbackHost(base));
  if (!style.testable) {
    return {
      ok: false,
      code: 'not_testable',
      message:
        'this provider authenticates from the environment, so there is no key-authed endpoint to call',
      latencyMs: 0,
      modelIds: [],
      truncated: false,
    };
  }
  if (apiKey === '' && !style.keyOptional) {
    return {
      ok: false,
      code: 'no_api_key',
      message: 'no API key stored for this provider',
      latencyMs: 0,
      modelIds: [],
      truncated: false,
    };
  }

  const started = Date.now();
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let lastCode: HostProviderProbeCode = 'unknown';
  let lastMessage: string | undefined;

  for (const path of pathsOf(style)) {
    const url = `${base}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        headers: authHeaders(style, apiKey),
        signal: controller.signal,
      });
      if (!response.ok) {
        lastCode = classifyStatus(response.status);
        lastMessage = `${redactBaseUrl(url)}: HTTP ${response.status}`;
        continue;
      }
      const parsed = parseModelList(await response.json());
      if (parsed.ids.length === 0) {
        lastCode = 'empty_list';
        lastMessage = `${redactBaseUrl(url)}: no models listed`;
        continue;
      }
      return {
        ok: true,
        code: 'ok',
        latencyMs: Date.now() - started,
        modelIds: parsed.ids.slice(0, MAX_MODEL_IDS),
        truncated: parsed.ids.length > MAX_MODEL_IDS,
      };
    } catch (error) {
      const aborted = (error as { name?: string }).name === 'AbortError';
      lastCode = aborted ? 'timeout' : 'network';
      lastMessage = `${redactBaseUrl(url)}: ${redact(errorText(error), apiKey)}`;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    ok: false,
    code: lastCode,
    ...(lastMessage === undefined ? {} : { message: redact(lastMessage, apiKey) }),
    latencyMs: Date.now() - started,
    modelIds: [],
    truncated: false,
  };
}

function classifyStatus(status: number): HostProviderProbeCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 400 && status < 500) return 'rejected';
  return 'unknown';
}

/**
 * The ids a model list carries, across the shapes vendors actually use.
 *
 * `{data:[{id}]}` is the OpenAI spelling, `{models:[{name}]}` is Ollama's, and
 * a bare array shows up on hand-rolled proxies. Rows with a non-`llm` `type`
 * are dropped: an embedding model listed next to the chat models is a row the
 * picker would offer and the run would fail on.
 */
export function parseModelList(value: unknown): { ids: string[] } {
  const rows = Array.isArray(value)
    ? value
    : isRecord(value)
      ? (Array.isArray(value.data) ? value.data : Array.isArray(value.models) ? value.models : [])
      : [];
  const ids: string[] = [];
  for (const row of rows) {
    if (!isRecord(row)) {
      if (typeof row === 'string' && row.trim() !== '') push(ids, row.trim());
      continue;
    }
    const type = row.type;
    if (typeof type === 'string' && type !== '' && type !== 'llm') continue;
    const id = [row.id, row.name, row.model].find(
      (candidate): candidate is string => typeof candidate === 'string' && candidate.trim() !== '',
    );
    if (id !== undefined) push(ids, id.trim());
  }
  return { ids };
}

function push(ids: string[], id: string): void {
  if (!ids.includes(id)) ids.push(id);
}

/**
 * An endpoint label that is safe to put on a screen.
 *
 * The query string and fragment are dropped (a key smuggled into `?api_key=`
 * is exactly what this must not repeat), and so is any `user:pass@` authority.
 */
export function redactBaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split('?')[0]?.split('#')[0] ?? '';
  }
}

/** Replace every occurrence of the key, then the usual header spellings. */
function redact(message: string, apiKey: string): string {
  let out = message;
  if (apiKey !== '') out = out.split(apiKey).join('[REDACTED]');
  return out
    .replace(/(Bearer\s+)[A-Za-z0-9._\-+/=]{8,}/gi, '$1[REDACTED]')
    .replace(/(x-api-key["']?\s*[:=]\s*["']?)[A-Za-z0-9._\-+/=]{8,}/gi, '$1[REDACTED]');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
