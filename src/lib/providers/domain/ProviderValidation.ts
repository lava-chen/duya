/**
 * src/lib/providers/domain/ProviderValidation.ts
 *
 * Validates LlmProvider, AuthConfig, EndpointConfig shapes.
 *
 * The rules here are intentionally minimal and stable. They:
 *  - reject obvious configuration errors at the boundary (UI save, IPC upsert)
 *  - NEVER log raw secrets; any error message is built via `redactSecrets()`
 *  - return a stable `code` so callers can branch programmatically
 *    (e.g. show a specific UI message or a localized key)
 *
 * Capability / connectivity validation is NOT this module's job.
 * It lives in `ProviderHealthService`.
 */

import type { LlmProvider, ValidationResult } from '../types';

const SECRET_KEYS = new Set([
  'apikey',
  'api_key',
  'apikey',
  'authorization',
  'accesstoken',
  'access_token',
  'bearer',
  'token',
  'x-api-key',
  'xapikey',
  'sessionkey',
  'session_key',
  'password',
  'secret',
]);

/** Redact a value if it looks like a secret. */
export function redactSecret(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') {
    if (value.length === 0) return '';
    if (value.length <= 8) return '***';
    return `${value.slice(0, 4)}***${value.slice(-4)}`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  // For objects, redact nested fields whose key looks like a secret.
  try {
    const seen = new WeakSet<object>();
    const json = JSON.stringify(value, (k, v) => {
      if (typeof k === 'string' && SECRET_KEYS.has(k.toLowerCase().replace(/[_-]/g, ''))) {
        return redactSecret(v);
      }
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      return v;
    });
    return json ?? '[unstringifiable]';
  } catch {
    return '[unserializable]';
  }
}

/** Redact any string-shaped value that might contain a secret.
 *  Used to scrub error messages and log lines. */
export function redactSecrets(input: string | undefined | null): string {
  if (!input) return '';
  let out = input;
  // Bearer <token>
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._\-+/=]{8,}/g, '$1[REDACTED]');
  // x-api-key: <token>
  out = out.replace(/(x-api-key["']?\s*[:=]\s*["']?)[A-Za-z0-9._\-+/=]{8,}/gi, '$1[REDACTED]');
  // authorization: <token>
  out = out.replace(/(authorization["']?\s*[:=]\s*["']?)[A-Za-z0-9._\-+/=]{8,}/gi, '$1[REDACTED]');
  // apiKey=<token> / api_key=<token>
  out = out.replace(/((?:api[_-]?key|access[_-]?token)["']?\s*[:=]\s*["']?)[A-Za-z0-9._\-+/=]{8,}/gi, '$1[REDACTED]');
  return out;
}

function ok(): ValidationResult {
  return { ok: true };
}

function fail(code: string, message: string): ValidationResult {
  return { ok: false, code, message: redactSecrets(message) };
}

function isValidUrl(url: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Validate the auth sub-shape. */
export function validateAuth(auth: LlmProvider['auth'] | undefined): ValidationResult {
  if (!auth) return fail('auth.missing', 'auth is required');
  if (!['api-key', 'bearer', 'oauth', 'none'].includes(auth.type)) {
    return fail('auth.invalidType', `unsupported auth.type: ${auth.type}`);
  }
  if (auth.type === 'api-key' || auth.type === 'bearer') {
    if (!auth.apiKey || auth.apiKey.length === 0) {
      return fail('auth.missingApiKey', 'apiKey is required for api-key/bearer auth');
    }
  }
  if (auth.type === 'oauth') {
    if (!auth.accessToken && !auth.oauthAccountId) {
      return fail(
        'auth.missingOAuth',
        'oauth auth requires accessToken or oauthAccountId',
      );
    }
  }
  return ok();
}

/** Validate the endpoints sub-shape. */
export function validateEndpoint(
  endpoints: LlmProvider['endpoints'] | undefined,
  apiFormat: LlmProvider['apiFormat'],
): ValidationResult {
  if (!endpoints) return fail('endpoint.missing', 'endpoints is required');
  const url = (endpoints.baseUrl || '').trim();
  if (!url) {
    return fail('endpoint.missingBaseUrl', 'endpoints.baseUrl is required');
  }
  if (!isValidUrl(url)) {
    return fail('endpoint.invalidUrl', `endpoints.baseUrl is not a valid http(s) URL: ${redactSecrets(url)}`);
  }
  if (apiFormat === 'ollama' && !url.includes('11434') && !url.includes('ollama')) {
    // Not strictly invalid, but warn — Ollama usually runs on 11434.
    // We still return ok since remote Ollama is allowed.
  }
  return ok();
}

/** Validate the full LlmProvider shape. */
export function validateProvider(provider: LlmProvider): ValidationResult {
  if (!provider || typeof provider !== 'object') {
    return fail('provider.notObject', 'provider is not an object');
  }
  if (!provider.id || typeof provider.id !== 'string') {
    return fail('provider.missingId', 'provider.id is required');
  }
  if (!provider.name || typeof provider.name !== 'string') {
    return fail('provider.missingName', 'provider.name is required');
  }
  if (!isValidApiFormat(provider.apiFormat)) {
    return fail('provider.invalidApiFormat', `unsupported apiFormat: ${provider.apiFormat}`);
  }
  if (!isValidCategory(provider.category)) {
    return fail('provider.invalidCategory', `unsupported category: ${provider.category}`);
  }
  const authRes = validateAuth(provider.auth);
  if (!authRes.ok) return authRes;
  const epRes = validateEndpoint(provider.endpoints, provider.apiFormat);
  if (!epRes.ok) return epRes;
  return ok();
}

function isValidApiFormat(s: string): boolean {
  return [
    'openai-chat',
    'openai-responses',
    'anthropic',
    'gemini',
    'ollama',
    'bedrock',
    'vertex',
  ].includes(s);
}

function isValidCategory(s: string): boolean {
  return ['official', 'aggregator', 'custom', 'local', 'managed', 'proxy'].includes(s);
}
