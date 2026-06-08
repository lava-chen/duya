/**
 * file-parser config test
 * Verifies env var precedence, defaults, and reset behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getFileParserConfig, _resetFileParserConfig } from '../config.js';

const ENV_VARS = [
  'DUYA_FILE_PARSER_DISABLED',
  'DUYA_FILE_PARSER_MAX_TOKENS',
  'DUYA_FILE_PARSER_CACHE_TTL_MS',
  'DUYA_FILE_PARSER_MAX_CONCURRENT',
] as const;

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const name of ENV_VARS) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  _resetFileParserConfig();
});

afterEach(() => {
  for (const name of ENV_VARS) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  _resetFileParserConfig();
});

describe('getFileParserConfig', () => {
  it('returns sensible defaults when no env is set', () => {
    const config = getFileParserConfig();
    expect(config.disabled).toBe(false);
    expect(config.maxTokens).toBe(25_000);
    expect(config.cacheTtlMs).toBe(30 * 60 * 1000);
    expect(config.maxConcurrent).toBe(2);
    expect(config.maxFileSize).toBe(50 * 1024 * 1024);
    expect(config.parseTimeoutMs).toBe(30_000);
  });

  it('honors DUYA_FILE_PARSER_DISABLED=1', () => {
    process.env.DUYA_FILE_PARSER_DISABLED = '1';
    expect(getFileParserConfig().disabled).toBe(true);
  });

  it('treats "true" as truthy for the kill switch', () => {
    process.env.DUYA_FILE_PARSER_DISABLED = 'true';
    expect(getFileParserConfig().disabled).toBe(true);
  });

  it('falls back to default when env value is non-numeric', () => {
    process.env.DUYA_FILE_PARSER_MAX_TOKENS = 'not-a-number';
    expect(getFileParserConfig().maxTokens).toBe(25_000);
  });

  it('parses positive integers from env', () => {
    process.env.DUYA_FILE_PARSER_MAX_TOKENS = '5000';
    process.env.DUYA_FILE_PARSER_CACHE_TTL_MS = '60000';
    process.env.DUYA_FILE_PARSER_MAX_CONCURRENT = '4';
    const c = getFileParserConfig();
    expect(c.maxTokens).toBe(5000);
    expect(c.cacheTtlMs).toBe(60_000);
    expect(c.maxConcurrent).toBe(4);
  });

  it('falls back to default when env value is zero or negative', () => {
    process.env.DUYA_FILE_PARSER_MAX_TOKENS = '0';
    process.env.DUYA_FILE_PARSER_MAX_CONCURRENT = '-1';
    const c = getFileParserConfig();
    expect(c.maxTokens).toBe(25_000);
    expect(c.maxConcurrent).toBe(2);
  });

  it('memoizes the config within a process', () => {
    const a = getFileParserConfig();
    const b = getFileParserConfig();
    expect(a).toBe(b);
  });

  it('reset re-reads env on next call', () => {
    process.env.DUYA_FILE_PARSER_MAX_TOKENS = '1000';
    expect(getFileParserConfig().maxTokens).toBe(1000);
    delete process.env.DUYA_FILE_PARSER_MAX_TOKENS;
    _resetFileParserConfig();
    expect(getFileParserConfig().maxTokens).toBe(25_000);
  });
});
