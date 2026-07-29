/**
 * Connection manifest parser — Plan 312 Phase 2.
 *
 * Plugins declare their app-connection dependencies in a standalone
 * `apps/connections.json` file inside the plugin root. This module
 * parses + validates that file leniently (mirrors the style of
 * `electron/plugins/manifest.ts:readPluginManifestLenient`):
 *   - file missing → empty array (the plugin has no connection deps)
 *   - JSON malformed → empty array + warnings (do not throw)
 *   - schema mismatch → drop the bad entry, keep the rest, warn
 *
 * The declared `provider` must be one of the supported ProviderId
 * values. Unknown providers are dropped with a warning so a stale
 * plugin can't block installation.
 */

import fs from 'fs';
import path from 'path';
import { getLogger, LogComponent } from '../../logging/logger';
import type { ProviderId } from './types.js';

const COMPONENT = 'AppConnectionManifest' as LogComponent;

const SUPPORTED_PROVIDERS: readonly ProviderId[] = ['google', 'slack', 'microsoft365'];

/**
 * Parsed connection declaration. Plugin authors write the matching
 * shape in `apps/connections.json`. All fields are required except
 * `required` (defaults to true) and `toolsets` (defaults to []).
 */
export interface ConnectionDeclaration {
  /** Plugin-local id; unique within the plugin. */
  id: string;
  /** OAuth provider to connect to. */
  provider: ProviderId;
  /** Scopes the plugin requests. Merged with the provider default set. */
  scopes: string[];
  /** Toolset identifiers the plugin wants enabled (Plan 313 owns the values). */
  toolsets: string[];
  /** Whether the connection is required for the plugin to function. */
  required: boolean;
}

/** Result of a lenient parse — never throws. */
export interface ParseConnectionsResult {
  declarations: ConnectionDeclaration[];
  warnings: string[];
  source: 'file' | 'missing' | 'error';
}

interface RawDeclaration {
  id?: unknown;
  provider?: unknown;
  scopes?: unknown;
  toolsets?: unknown;
  required?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, field: string, warnings: string[]): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    warnings.push(`field "${field}" must be a non-empty string; entry dropped`);
    return null;
  }
  return value;
}

function asStringArray(value: unknown, field: string, warnings: string[]): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    warnings.push(`field "${field}" must be a string array; defaulting to []`);
    return [];
  }
  return value as string[];
}

function isSupportedProvider(value: unknown): value is ProviderId {
  return typeof value === 'string' && (SUPPORTED_PROVIDERS as readonly string[]).includes(value);
}

/** Parse `apps/connections.json` from a plugin root, leniently. */
export function parseConnectionsJson(raw: string): ParseConnectionsResult {
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      declarations: [],
      warnings: [
        `apps/connections.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      ],
      source: 'error',
    };
  }

  if (!Array.isArray(parsed)) {
    if (parsed === null || parsed === undefined) {
      return { declarations: [], warnings: [], source: 'file' };
    }
    if (!isObject(parsed)) {
      return {
        declarations: [],
        warnings: ['apps/connections.json root must be an array'],
        source: 'error',
      };
    }
    // Accept a single-declaration object as a convenience.
    parsed = [parsed];
  }

  const declarations: ConnectionDeclaration[] = [];
  for (let i = 0; i < (parsed as RawDeclaration[]).length; i++) {
    const entry = (parsed as RawDeclaration[])[i];
    if (!isObject(entry)) {
      warnings.push(`entry [${i}] is not an object; skipped`);
      continue;
    }
    const id = asString(entry.id, 'id', warnings);
    const providerRaw = entry.provider;
    if (!isSupportedProvider(providerRaw)) {
      warnings.push(
        `entry [${i}] provider "${String(providerRaw)}" is not supported; entry dropped`,
      );
      continue;
    }
    if (!id) continue;

    declarations.push({
      id,
      provider: providerRaw,
      scopes: asStringArray(entry.scopes, 'scopes', warnings),
      toolsets: asStringArray(entry.toolsets, 'toolsets', warnings),
      required: typeof entry.required === 'boolean' ? entry.required : true,
    });
  }

  return { declarations, warnings, source: 'file' };
}

/**
 * Read + parse `apps/connections.json` from a plugin root directory.
 *
 * Lenient semantics:
 *   - file missing → `{ declarations: [], warnings: [], source: 'missing' }`
 *   - file unreadable / bad JSON → empty + warnings + `source: 'error'`
 *
 * Never throws.
 */
export function readPluginAppConnections(pluginRoot: string): ParseConnectionsResult {
  const filePath = path.join(pluginRoot, 'apps', 'connections.json');
  const logger = getLogger();
  if (!fs.existsSync(filePath)) {
    return { declarations: [], warnings: [], source: 'missing' };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    logger.warn(
      'App Connection: failed to read apps/connections.json',
      err instanceof Error ? err : new Error(String(err)),
      COMPONENT,
    );
    return {
      declarations: [],
      warnings: [`apps/connections.json read failed: ${err instanceof Error ? err.message : String(err)}`],
      source: 'error',
    };
  }
  const result = parseConnectionsJson(raw);
  if (result.warnings.length > 0) {
    logger.warn(
      'App Connection: apps/connections.json parsed with warnings',
      { warnings: result.warnings, pluginRoot },
      COMPONENT,
    );
  }
  return result;
}
