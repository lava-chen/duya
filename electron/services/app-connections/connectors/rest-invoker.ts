/**
 * RestTemplateInvoker — Plan 460 generic REST template executor.
 *
 * Executes a `.app.json` tool declaration whose `invoke` is a REST
 * template (`RestInvokeDeclarationSchema`). This is the "declaration is
 * the connector" layer: plugin authors define tools entirely in config —
 * no TypeScript in the duya core, no central directory service.
 *
 * Template variables are expanded inside `url` / `headers` / `query` /
 * `body` string values:
 *   - `${args.<path>}`  — argument value (dot path into the args object)
 *   - `${accessToken}`  — the connection's access token
 *   - `${tokenType}`    — e.g. `Bearer`
 *   - `${error}`        — error detail, only in `response.errorTemplate`
 *
 * Response projection (`response` block):
 *   - `ok`             — dot path whose truthiness marks success (default:
 *                        HTTP 2xx). e.g. Slack `body.ok`.
 *   - `dataPath`       — dot path of the result data (default: whole body).
 *   - `errorPath`      — dot path of the error message string.
 *   - `errorTemplate`  — template string for the error message; `${error}`
 *                        is replaced with the `errorPath` value (or the
 *                        HTTP detail when absent).
 *   - `retryableStatus`— status codes that produce `retriable: true`.
 *
 * Tokens never leave the main process: the access token is attached to
 * the outbound request here and is never included in the returned result.
 */

import type {
  AppToolDeclaration,
  RestInvokeDeclaration,
} from '@duya/plugin-core/src/connectors/app-schema.js';
import type { ConnectorInvokeResult } from '../connector-types.js';

const DEFAULT_RETRYABLE_STATUS = [502, 503, 504];

/** Value context available to template expansion. */
export interface RestInvokeContext {
  args: Record<string, unknown>;
  accessToken: string;
  tokenType: string;
}

/**
 * Execute one REST-template tool call.
 *
 * @param tool  The declaring tool (`AppToolDeclaration` with `invoke`).
 * @param ctx   Expanded value context (args + token).
 * @param fetchImpl  Fetch implementation (tests inject a fake).
 */
export async function invokeRestTemplate(
  tool: AppToolDeclaration,
  ctx: RestInvokeContext,
  fetchImpl: typeof fetch = fetch,
): Promise<ConnectorInvokeResult> {
  const invoke = tool.invoke;
  if (!invoke) {
    return failure(
      'invalid_arguments',
      `tool ${tool.name} declares no invoke template`,
      false,
    );
  }

  const url = buildUrl(invoke, ctx);
  if (!url) {
    return failure(
      'invalid_arguments',
      `tool ${tool.name} has an invalid or unresolvable URL template`,
      false,
    );
  }

  const headers = buildHeaders(invoke, ctx);
  const body = buildBody(invoke, ctx);

  let resp: Response;
  try {
    resp = await fetchImpl(url, {
      method: invoke.method,
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(body !== undefined ? { body } : {}),
    });
  } catch (err) {
    return failure(
      'network_error',
      `${tool.name} request failed: ${err instanceof Error ? err.message : String(err)}`,
      true,
    );
  }

  return projectResponse(invoke, resp, url, tool.name);
}

/** Build the final request URL: expand template, apply query params. */
function buildUrl(invoke: RestInvokeDeclaration, ctx: RestInvokeContext): string | null {
  const expanded = expandTemplate(invoke.url, ctx);
  if (!expanded) return null;
  let url: URL;
  try {
    url = new URL(expanded);
  } catch {
    return null;
  }
  if (invoke.query) {
    for (const [key, raw] of Object.entries(invoke.query)) {
      const value = expandTemplate(raw, ctx);
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

/** Build request headers; auto-attach Authorization when not declared. */
function buildHeaders(invoke: RestInvokeDeclaration, ctx: RestInvokeContext): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, raw] of Object.entries(invoke.headers ?? {})) {
    headers[key] = expandTemplate(raw, ctx);
  }
  const hasAuth = Object.keys(headers).some(
    (key) => key.toLowerCase() === 'authorization',
  );
  if (!hasAuth && ctx.accessToken) {
    const scheme = ctx.tokenType && ctx.tokenType.toLowerCase() !== 'bearer'
      ? ctx.tokenType
      : 'Bearer';
    headers.Authorization = `${scheme} ${ctx.accessToken}`;
  }
  return headers;
}

/** Build the request body: expand templates inside string leaves. */
function buildBody(invoke: RestInvokeDeclaration, ctx: RestInvokeContext): string | undefined {
  if (invoke.body === undefined) return undefined;
  if (typeof invoke.body === 'string') {
    return expandTemplate(invoke.body, ctx);
  }
  return JSON.stringify(expandDeep(invoke.body, ctx));
}

/** Map an HTTP response onto the declared projection rules. */
async function projectResponse(
  invoke: RestInvokeDeclaration,
  resp: Response,
  url: string,
  toolName: string,
): Promise<ConnectorInvokeResult> {
  const retryable = (invoke.response?.retryableStatus ?? DEFAULT_RETRYABLE_STATUS).includes(resp.status);
  const rawText = await resp.text();
  let body: unknown;
  try {
    body = rawText ? JSON.parse(rawText) : null;
  } catch {
    body = rawText || null;
  }

  const okRule = invoke.response?.ok;
  const success = okRule
    ? truthy(getPath(body, okRule))
    : resp.ok;

  if (success) {
    const data = invoke.response?.dataPath ? getPath(body, invoke.response.dataPath) : body;
    return { success: true, data: data === undefined ? body : data };
  }

  let message: string;
  if (invoke.response?.errorTemplate) {
    const detail = invoke.response.errorPath
      ? stringify(getPath(body, invoke.response.errorPath))
      : '';
    message = expandTemplate(invoke.response.errorTemplate, {
      ...ctxOf(resp.status, url),
      error: detail || `${resp.status}`,
    });
  } else if (invoke.response?.errorPath) {
    const detail = stringify(getPath(body, invoke.response.errorPath));
    message = detail || `${toolName} failed with status ${resp.status}`;
  } else {
    message = `${toolName} failed with status ${resp.status}`;
  }

  return {
    success: false,
    error: {
      code: resp.ok ? 'provider_error' : `http_${resp.status}`,
      message,
      retriable: retryable || resp.status >= 500,
    },
  };
}

/** Minimal error context for error-template expansion (`${error}`/`${status}`/`${url}`). */
function ctxOf(status: number, url: string): Record<string, unknown> {
  return { status, url };
}

/** Recursively expand `${...}` inside every string leaf of a JSON value. */
function expandDeep(value: unknown, ctx: RestInvokeContext): unknown {
  if (typeof value === 'string') return expandTemplate(value, ctx);
  if (Array.isArray(value)) return value.map((item) => expandDeep(item, ctx));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = expandDeep(item, ctx);
    }
    return out;
  }
  return value;
}

/** Replace `${expr}` placeholders using the invocation context. */
function expandTemplate(value: string, ctx: Record<string, unknown>): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, expr: string) => {
    const resolved = lookup(expr.trim(), ctx);
    return resolved === undefined ? match : String(resolved);
  });
}

/** Resolve a single template expression against the context. */
function lookup(expr: string, ctx: Record<string, unknown>): unknown {
  if (expr.startsWith('args.')) {
    return getPath(ctx.args, expr.slice('args.'.length));
  }
  if (Object.prototype.hasOwnProperty.call(ctx, expr)) {
    return ctx[expr];
  }
  return undefined;
}

/** Dot-path getter: `getPath({a:{b:[1]}}, 'a.b.0')` → `1`. */
export function getPath(target: unknown, path: string): unknown {
  if (!path) return target;
  let current: unknown = target;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function truthy(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 0 && value.toLowerCase() !== 'false';
  return Boolean(value);
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function failure(
  code: string,
  message: string,
  retriable: boolean,
): ConnectorInvokeResult {
  return { success: false, error: { code, message, retriable } };
}
