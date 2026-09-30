import { describe, expect, it, vi } from 'vitest';
import {
  isRecoverableSessionInvalidation,
  retryOnceAfterSessionInvalidation,
  SESSION_SELF_HEAL_FAILED_MSG,
} from '../../src/tool/BrowserTool/selfHealing.js';

describe('isRecoverableSessionInvalidation', () => {
  it.each([
    'Tab 5 does not belong to session "session_123"',
    'Cannot perform operation: not attached to a tab',
    'Failed to attach tab to session',
    'No active tab. Navigate to a URL first.',
    'page detached from session',
  ])('recognizes recoverable session invalidation: %s', (message) => {
    expect(isRecoverableSessionInvalidation(message)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isRecoverableSessionInvalidation('TAB 1 DOES NOT BELONG TO SESSION "S"')).toBe(true);
  });

  it.each([
    'Timeout: navigation to https://example.com exceeded 30s',
    'Navigation blocked: example.com is in the domain blocklist',
    'Element [3] not found in snapshot',
    '',
  ])('ignores ordinary business failures: %s', (message) => {
    expect(isRecoverableSessionInvalidation(message)).toBe(false);
  });

  it('ignores empty / nullish input', () => {
    expect(isRecoverableSessionInvalidation('')).toBe(false);
  });
});

describe('retryOnceAfterSessionInvalidation', () => {
  it('resolves immediately without rebuilding when the attempt succeeds', async () => {
    const rebuild = vi.fn(async () => {});
    const result = await retryOnceAfterSessionInvalidation(async () => 'ok', {
      isRecoverable: isRecoverableSessionInvalidation,
      rebuild,
    });
    expect(result).toBe('ok');
    expect(rebuild).not.toHaveBeenCalled();
  });

  it('rebuilds once and retries when a recoverable invalidation is thrown', async () => {
    const rebuild = vi.fn(async () => {});
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new Error('Tab 1 does not belong to session "s"'))
      .mockResolvedValueOnce('recovered');

    const result = await retryOnceAfterSessionInvalidation(attempt, {
      isRecoverable: isRecoverableSessionInvalidation,
      rebuild,
    });

    expect(result).toBe('recovered');
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it('does not rebuild when the failure is not a session invalidation', async () => {
    const rebuild = vi.fn(async () => {});
    const error = new Error('Element [3] not found');
    await expect(
      retryOnceAfterSessionInvalidation(
        () => Promise.reject(error),
        { isRecoverable: isRecoverableSessionInvalidation, rebuild }
      )
    ).rejects.toBe(error);
    expect(rebuild).not.toHaveBeenCalled();
  });

  it('bounds to a single rebuild (no infinite retry loop)', async () => {
    const rebuild = vi.fn(async () => {});
    const attempt = vi.fn(() =>
      Promise.reject(new Error('Tab 1 does not belong to session "s"'))
    );

    await expect(
      retryOnceAfterSessionInvalidation(attempt, {
        isRecoverable: isRecoverableSessionInvalidation,
        rebuild,
        alwaysSurfaceFailureMessage: true,
      })
    ).rejects.toThrow(SESSION_SELF_HEAL_FAILED_MSG);

    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('surfaces a guided failure when the rebuild itself fails', async () => {
    const rebuild = vi.fn(async () => {
      throw new Error('Daemon unreachable');
    });
    await expect(
      retryOnceAfterSessionInvalidation(
        () => Promise.reject(new Error('Tab 1 does not belong to session "s"')),
        { isRecoverable: isRecoverableSessionInvalidation, rebuild }
      )
    ).rejects.toThrow(SESSION_SELF_HEAL_FAILED_MSG);
  });

  it('surfaces a guided failure when the retry fails (alwaysSurfaceFailureMessage)', async () => {
    const rebuild = vi.fn(async () => {});
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new Error('Tab 1 does not belong to session "s"'))
      .mockRejectedValueOnce(new Error('Navigation timeout: https://example.com'));

    await expect(
      retryOnceAfterSessionInvalidation(attempt, {
        isRecoverable: isRecoverableSessionInvalidation,
        rebuild,
        alwaysSurfaceFailureMessage: true,
      })
    ).rejects.toThrow(SESSION_SELF_HEAL_FAILED_MSG);
  });

  it('re-throws the retry error when alwaysSurfaceFailureMessage is false', async () => {
    const rebuild = vi.fn(async () => {});
    const retryError = new Error('Navigation timeout: https://example.com');
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new Error('Tab 1 does not belong to session "s"'))
      .mockRejectedValueOnce(retryError);

    await expect(
      retryOnceAfterSessionInvalidation(attempt, {
        isRecoverable: isRecoverableSessionInvalidation,
        rebuild,
      })
    ).rejects.toBe(retryError);
  });
});