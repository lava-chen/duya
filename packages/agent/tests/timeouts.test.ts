import { describe, expect, it } from 'vitest';
import { getDefaultBashTimeoutMs, getMaxBashTimeoutMs } from '../src/utils/timeouts.js';

describe('timeouts', () => {
  it('returns 2 minute default when env unset', () => {
    expect(getDefaultBashTimeoutMs({})).toBe(120_000);
  });

  it('honors BASH_DEFAULT_TIMEOUT_MS env', () => {
    expect(getDefaultBashTimeoutMs({ BASH_DEFAULT_TIMEOUT_MS: '30000' })).toBe(30_000);
  });

  it('ignores invalid BASH_DEFAULT_TIMEOUT_MS env', () => {
    expect(getDefaultBashTimeoutMs({ BASH_DEFAULT_TIMEOUT_MS: 'abc' })).toBe(120_000);
    expect(getDefaultBashTimeoutMs({ BASH_DEFAULT_TIMEOUT_MS: '0' })).toBe(120_000);
    expect(getDefaultBashTimeoutMs({ BASH_DEFAULT_TIMEOUT_MS: '-1' })).toBe(120_000);
  });

  it('returns 10 minute max when env unset', () => {
    expect(getMaxBashTimeoutMs({})).toBe(600_000);
  });

  it('honors BASH_MAX_TIMEOUT_MS env', () => {
    expect(getMaxBashTimeoutMs({ BASH_MAX_TIMEOUT_MS: '1200000' })).toBe(1_200_000);
  });

  it('ensures max is at least default', () => {
    expect(getMaxBashTimeoutMs({ BASH_MAX_TIMEOUT_MS: '90000' })).toBe(120_000);
  });
});
