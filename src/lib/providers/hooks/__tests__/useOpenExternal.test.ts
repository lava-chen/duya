/**
 * src/lib/providers/hooks/__tests__/useOpenExternal.test.ts
 *
 * Plan 203 Phase 5.1 tests for `useOpenExternal`. The hook is a
 * `useCallback` over a closure that wraps `window.open` with a
 * conservative `https:`-only filter (Plan 203 D203.6).
 *
 * The tests verify:
 *   -1- A safe `https:` URL opens via `window.open`.
 *   -2- An `http:` URL is rejected.
 *   -3- A `javascript:` URL is rejected.
 *   -4- A `data:` URL is rejected.
 *   -5- An empty / whitespace-only URL is rejected.
 *   -6- The hook returns a stable function reference across renders.
 */

// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useOpenExternal } from '../useOpenExternal';

describe('useOpenExternal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('opens a safe https URL via window.open', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { result } = renderHook(() => useOpenExternal());
    result.current('https://example.com');
    expect(openSpy).toHaveBeenCalledWith(
      'https://example.com',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('rejects an http URL', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { result } = renderHook(() => useOpenExternal());
    result.current('http://example.com');
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('rejects a javascript URL', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { result } = renderHook(() => useOpenExternal());
    result.current('javascript:alert(1)');
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('rejects a data URL', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { result } = renderHook(() => useOpenExternal());
    result.current('data:text/html,<h1>x</h1>');
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('rejects an empty URL', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { result } = renderHook(() => useOpenExternal());
    result.current('');
    result.current('   ');
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('is case-insensitive on the scheme check', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { result } = renderHook(() => useOpenExternal());
    result.current('HTTPS://Example.com');
    expect(openSpy).toHaveBeenCalled();
  });

  it('trims whitespace before checking the scheme', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { result } = renderHook(() => useOpenExternal());
    result.current('  https://example.com  ');
    expect(openSpy).toHaveBeenCalledWith(
      '  https://example.com  ',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('returns a stable function reference across renders', () => {
    const { result, rerender } = renderHook(() => useOpenExternal());
    const ref1 = result.current;
    rerender();
    expect(result.current).toBe(ref1);
  });
});
