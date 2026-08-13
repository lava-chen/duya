/**
 * packages/cli/src/commands/doctor-config.ts
 *
 * Offline config diagnostics for `duya doctor`. Reads `~/.duya/config.toml`
 * and `~/.duya/secrets.json` directly from disk so the checks run even when
 * the desktop app is not running.
 *
 * Coverage (read-only, no writes):
 *  - file presence + TOML/JSON parse
 *  - file permissions (POSIX 0600)
 *  - top-level schema structure vs. DuyaConfig
 *  - model/provider consistency (default provider, model, api keys)
 *  - MCP server transport consistency
 *  - channel adapter required credentials
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { parse as parseToml } from '@iarna/toml';
import type { CheckResult } from './doctor.js';

/** Config root: `~/.duya` (mirrors electron/config/compass.ts). */
function resolveConfigRoot(): string {
  return path.join(os.homedir(), '.duya');
}

interface LoadedConfig {
  configPath: string;
  secretsPath: string;
  configExists: boolean;
  secretsExists: boolean;
  configDoc: Record<string, unknown> | null;
  secretsDoc: Record<string, unknown> | null;
  configParseError?: string;
  secretsParseError?: string;
}

function loadConfigFiles(): LoadedConfig {
  const root = resolveConfigRoot();
  const configPath = path.join(root, 'config.toml');
  const secretsPath = path.join(root, 'secrets.json');
  const result: LoadedConfig = {
    configPath,
    secretsPath,
    configExists: fs.existsSync(configPath),
    secretsExists: fs.existsSync(secretsPath),
    configDoc: null,
    secretsDoc: null,
  };
  if (result.configExists) {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      result.configDoc = parseToml(raw) as Record<string, unknown>;
    } catch (err) {
      result.configParseError = err instanceof Error ? err.message : String(err);
    }
  }
  if (result.secretsExists) {
    try {
      const raw = fs.readFileSync(secretsPath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      result.secretsDoc = isPlainObject(parsed) ? parsed : null;
      if (!result.secretsDoc) {
        result.secretsParseError = 'secrets.json root is not an object';
      }
    } catch (err) {
      result.secretsParseError = err instanceof Error ? err.message : String(err);
    }
  }
  return result;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Resolve a dotted path (e.g. `providers.openai.apiKey`) inside a secrets doc. */
function getSecret(secrets: Record<string, unknown> | null, dotted: string): unknown {
  if (!secrets) return undefined;
  if (Object.prototype.hasOwnProperty.call(secrets, dotted)) return secrets[dotted];
  let cur: unknown = secrets;
  for (const part of dotted.split('.')) {
    if (!isPlainObject(cur)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** POSIX permission bits that would make the file group/other readable/writable. */
function checkPermission(
  checks: CheckResult[],
  idSuffix: string,
  filePath: string,
  label: string,
): void {
  if (os.platform() === 'win32') {
    checks.push({
      id: `config_${idSuffix}_permissions`,
      category: 'config',
      status: 'skipped',
      message: 'File permission check is skipped on Windows',
    });
    return;
  }
  let mode: number;
  try {
    mode = fs.statSync(filePath).mode & 0o777;
  } catch {
    checks.push({
      id: `config_${idSuffix}_permissions`,
      category: 'config',
      status: 'skipped',
      message: `Cannot stat ${label}`,
    });
    return;
  }
  if ((mode & 0o077) !== 0) {
    checks.push({
      id: `config_${idSuffix}_permissions`,
      category: 'config',
      status: 'warning',
      message: `${label} permissions are ${mode.toString(8)} (expected 600)`,
      hint: `Run: chmod 600 "${filePath}"`,
    });
  } else {
    checks.push({
      id: `config_${idSuffix}_permissions`,
      category: 'config',
      status: 'ok',
      message: `${label} permissions are ${mode.toString(8)}`,
    });
  }
}

/** Required top-level sections and their expected shape (subset of DuyaConfig). */
const REQUIRED_TOP: Array<[string, 'number' | 'object']> = [
  ['_config_version', 'number'],
  ['storage', 'object'],
  ['model', 'object'],
  ['providers', 'object'],
  ['memory', 'object'],
  ['agent', 'object'],
  ['channels', 'object'],
  ['mcp_servers', 'object'],
  ['plugins', 'object'],
  ['security', 'object'],
];

function checkSchema(checks: CheckResult[], ctx: LoadedConfig): void {
  const doc = ctx.configDoc;
  if (!doc) return;
  for (const [key, kind] of REQUIRED_TOP) {
    const v = doc[key];
    if (v === undefined) {
      checks.push({
        id: 'config_schema_missing',
        category: 'config',
        status: 'warning',
        message: `Missing top-level section [${key}] (app will use its default)`,
      });
      continue;
    }
    const typeOk = kind === 'object' ? isPlainObject(v) : typeof v === kind;
    if (!typeOk) {
      checks.push({
        id: 'config_schema_type',
        category: 'config',
        status: 'error',
        message: `"[${key}]" should be ${kind}`,
      });
    }
  }
}

function checkModelProviderConsistency(checks: CheckResult[], ctx: LoadedConfig): void {
  const doc = ctx.configDoc;
  if (!doc) return;
  const model = doc.model;
  const providers = doc.providers;
  const memory = doc.memory;
  const providerMap = isPlainObject(providers) ? providers : {};
  const providerNames = new Set(Object.keys(providerMap));

  if (isPlainObject(model)) {
    const providerId = model.provider;
    if (typeof providerId === 'string' && providerId !== '') {
      if (!providerNames.has(providerId)) {
        checks.push({
          id: 'config_default_provider_defined',
          category: 'config',
          status: 'warning',
          message: `Default provider "${providerId}" is not defined in [providers]`,
        });
      }
      const def = model.default;
      if (typeof def !== 'string' || def === '') {
        checks.push({
          id: 'config_default_model_set',
          category: 'config',
          status: 'warning',
          message: 'Default model is not set',
        });
      }
    } else {
      checks.push({
        id: 'config_default_provider_set',
        category: 'config',
        status: 'warning',
        message: 'No default provider is set',
      });
    }
  }

  for (const id of providerNames) {
    const entry = providerMap[id];
    if (!isPlainObject(entry)) {
      checks.push({
        id: 'config_provider_entry_shape',
        category: 'config',
        status: 'error',
        message: `providers.${id} is not an object`,
      });
      continue;
    }
    const baseUrl = entry.baseUrl;
    if (typeof baseUrl !== 'string' || baseUrl === '') {
      checks.push({
        id: 'config_provider_base_url',
        category: 'config',
        status: 'warning',
        message: `Provider "${id}" has no baseUrl`,
      });
    }
    const apiKey = getSecret(ctx.secretsDoc, `providers.${id}.apiKey`);
    if (typeof apiKey !== 'string' || apiKey === '') {
      checks.push({
        id: 'config_provider_api_key',
        category: 'config',
        status: 'warning',
        message: `Provider "${id}" has no apiKey in secrets.json`,
      });
    }
  }

  if (isPlainObject(memory)) {
    const memProvider = memory.provider;
    if (typeof memProvider === 'string' && memProvider !== '' && !providerNames.has(memProvider)) {
      checks.push({
        id: 'config_memory_provider_defined',
        category: 'config',
        status: 'warning',
        message: `Memory provider "${memProvider}" is not defined in [providers]`,
      });
    }
  }
}

function checkMcpServers(checks: CheckResult[], ctx: LoadedConfig): void {
  const doc = ctx.configDoc;
  if (!doc) return;
  const servers = doc.mcp_servers;
  if (!isPlainObject(servers)) return;
  for (const [id, entry] of Object.entries(servers)) {
    if (!isPlainObject(entry)) {
      checks.push({
        id: 'config_mcp_server_shape',
        category: 'config',
        status: 'error',
        message: `mcp_servers.${id} is not an object`,
      });
      continue;
    }
    if (entry.enabled === false) continue;
    const transport = entry.transport === 'streamable-http' ? 'streamable-http' : 'stdio';
    if (transport === 'stdio') {
      if (typeof entry.command !== 'string' || entry.command === '') {
        checks.push({
          id: 'config_mcp_command',
          category: 'config',
          status: 'warning',
          message: `MCP server "${id}" (stdio) has no command`,
        });
      }
    } else {
      if (typeof entry.url !== 'string' || entry.url === '') {
        checks.push({
          id: 'config_mcp_url',
          category: 'config',
          status: 'warning',
          message: `MCP server "${id}" (streamable-http) has no url`,
        });
      }
    }
  }
}

function checkChannels(checks: CheckResult[], ctx: LoadedConfig): void {
  const doc = ctx.configDoc;
  if (!doc) return;
  const channels = doc.channels;
  if (!isPlainObject(channels)) return;
  const adapters = channels.adapters;
  if (!isPlainObject(adapters)) return;
  for (const [id, entry] of Object.entries(adapters)) {
    if (!isPlainObject(entry)) {
      checks.push({
        id: 'config_channel_shape',
        category: 'config',
        status: 'error',
        message: `channels.adapters.${id} is not an object`,
      });
      continue;
    }
    if (entry.enabled !== true) continue;
    const token = getSecret(ctx.secretsDoc, `channels.adapters.${id}.credentials.token`);
    if (typeof token !== 'string' || token === '') {
      checks.push({
        id: 'config_channel_credential',
        category: 'config',
        status: 'warning',
        message: `Channel adapter "${id}" is enabled but has no token in secrets.json`,
      });
    }
  }
}

/**
 * Run all offline config checks and append them to `checks`.
 * Runs even when the desktop app is down because it reads files directly.
 */
export function runConfigChecks(checks: CheckResult[]): void {
  const ctx = loadConfigFiles();

  // config.toml presence + parse
  if (!ctx.configExists) {
    checks.push({
      id: 'config_file_exists',
      category: 'config',
      status: 'warning',
      message: 'config.toml not found',
      hint: 'Launch the DUYA app once to generate a default config.',
    });
    return;
  }
  checks.push({
    id: 'config_file_exists',
    category: 'config',
    status: 'ok',
    message: 'config.toml exists',
  });

  if (ctx.configParseError) {
    checks.push({
      id: 'config_file_parses',
      category: 'config',
      status: 'error',
      message: 'config.toml failed to parse',
      hint: ctx.configParseError,
    });
    return;
  }
  checks.push({
    id: 'config_file_parses',
    category: 'config',
    status: 'ok',
    message: 'config.toml parses successfully',
  });

  checkPermission(checks, 'file', ctx.configPath, 'config.toml');

  // secrets.json presence + parse
  if (!ctx.secretsExists) {
    checks.push({
      id: 'config_secrets_parses',
      category: 'config',
      status: 'warning',
      message: 'secrets.json not found',
      hint: 'Secrets are split from config.toml; create it by saving a provider API key.',
    });
  } else if (ctx.secretsParseError) {
    checks.push({
      id: 'config_secrets_parses',
      category: 'config',
      status: 'error',
      message: 'secrets.json failed to parse',
      hint: ctx.secretsParseError,
    });
  } else {
    checks.push({
      id: 'config_secrets_parses',
      category: 'config',
      status: 'ok',
      message: 'secrets.json parses successfully',
    });
    checkPermission(checks, 'secrets', ctx.secretsPath, 'secrets.json');
  }

  checkSchema(checks, ctx);
  checkModelProviderConsistency(checks, ctx);
  checkMcpServers(checks, ctx);
  checkChannels(checks, ctx);
}