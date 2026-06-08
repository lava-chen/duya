/**
 * file-parser configuration
 *
 * Reads runtime knobs from environment variables so operators can
 * disable / tune the Node file parser without code changes. Falls
 * back to hard-coded defaults.
 *
 * Env var precedence: env var > hardcoded default.
 *
 *   DUYA_FILE_PARSER_DISABLED=1
 *     When truthy, parse() throws immediately. Used as a kill switch
 *     when a regression is detected in production.
 *
 *   DUYA_FILE_PARSER_MAX_TOKENS=25000
 *     Token cap for document content (default 25_000).
 *
 *   DUYA_FILE_PARSER_CACHE_TTL_MS=1800000
 *     In-memory parse cache TTL in milliseconds (default 30 min).
 *
 *   DUYA_FILE_PARSER_MAX_CONCURRENT=2
 *     Worker pool concurrency cap (default 2). Increase only if
 *     the host has spare CPU; PDF parsing is CPU-bound.
 *
 *   DUYA_POPPLER_PATH=/path/to/poppler
 *     Directory containing pdftoppm + pdfinfo binaries. Used by the
 *     PDF vision fallback. Mirrors the legacy Python sidecar env var.
 */

import { MAX_FILE_SIZE, PARSE_TIMEOUT_MS } from './types.js';

const ENV_DISABLED = 'DUYA_FILE_PARSER_DISABLED';
const ENV_MAX_TOKENS = 'DUYA_FILE_PARSER_MAX_TOKENS';
const ENV_CACHE_TTL_MS = 'DUYA_FILE_PARSER_CACHE_TTL_MS';
const ENV_MAX_CONCURRENT = 'DUYA_FILE_PARSER_MAX_CONCURRENT';

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

export interface FileParserConfig {
  disabled: boolean;
  maxTokens: number;
  cacheTtlMs: number;
  maxConcurrent: number;
  maxFileSize: number;
  parseTimeoutMs: number;
}

const DEFAULT_MAX_TOKENS = 25_000;

let cached: FileParserConfig | null = null;

export function getFileParserConfig(): FileParserConfig {
  if (cached) return cached;

  const maxTokens = readInt(ENV_MAX_TOKENS, DEFAULT_MAX_TOKENS);
  const cacheTtlMs = readInt(ENV_CACHE_TTL_MS, 30 * 60 * 1000);
  const maxConcurrent = readInt(ENV_MAX_CONCURRENT, 2);
  const disabled = readBool(ENV_DISABLED, false);

  cached = {
    disabled,
    maxTokens,
    cacheTtlMs,
    maxConcurrent,
    maxFileSize: MAX_FILE_SIZE,
    parseTimeoutMs: PARSE_TIMEOUT_MS,
  };
  return cached;
}

/** Test helper: reset the cached config between tests. */
export function _resetFileParserConfig(): void {
  cached = null;
}
