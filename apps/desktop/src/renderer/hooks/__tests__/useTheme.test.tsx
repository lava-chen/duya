/**
 * @vitest-environment jsdom
 *
 * useTheme.test.tsx — Unit tests for the single shared theme hook
 * (Plan 583 ISS-41: WidgetRenderer's private copy was collapsed into this).
 *
 * The contract pinned here is that `data-theme` on <html> is the ONLY
 * input. localStorage `duya-theme` is a boot-time hint that index.html
 * turns into `data-theme` before React mounts, so the hook must never
 * read it directly — otherwise it can answer with a theme the stylesheet
 * is not rendering.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTheme, type Theme } from '../useTheme';

function setDataTheme(value: string | null): void {
  if (value === null) {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', value);
  }
}

/**
 * Flip the attribute the way the app does and let the MutationObserver
 * callback land. MutationObserver delivers as a microtask, so the async
 * form of act is what actually flushes the resulting state update.
 */
async function flipDataTheme(value: string): Promise<void> {
  await act(async () => {
    setDataTheme(value);
  });
}

describe('useTheme', () => {
  beforeEach(() => {
    // Unmount first: writing the attribute while a previous hook is still
    // mounted drives a MutationObserver setState outside act().
    cleanup();
    setDataTheme('dark');
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    setDataTheme(null);
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('reports the live data-theme on the very first render, not one frame late', () => {
    setDataTheme('light');

    // Record every committed render instead of reading a value back after
    // mount. renderHook/render wrap in act(), which flushes the old
    // hook's effect-driven setState before returning — so a plain
    // "result.current.theme" assertion passes against the buggy version
    // too. The recorded sequence is the only honest witness.
    const renders: Theme[] = [];
    function Probe(): null {
      renders.push(useTheme().theme);
      return null;
    }
    render(<Probe />);

    expect(renders[0]).toBe('light');
    expect(renders).not.toContain('dark');
  });

  it('follows data-theme changes made after mount', async () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('dark');

    await flipDataTheme('light');
    await waitFor(() => {
      expect(result.current.theme).toBe('light');
    });
  });

  it('ignores the localStorage boot hint', async () => {
    // Divergence is the whole point: the attribute is what CSS renders,
    // so the hook must follow the attribute even when the cached hint
    // disagrees.
    setDataTheme('dark');
    window.localStorage.setItem('duya-theme', 'light');

    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('dark');

    // And a later change to the attribute still wins over the hint.
    await flipDataTheme('light');
    await waitFor(() => {
      expect(result.current.theme).toBe('light');
    });
  });

  it('falls back to dark when data-theme is absent', () => {
    setDataTheme(null);
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('dark');
  });

  it('disconnects its observer on unmount', () => {
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    const { unmount } = renderHook(() => useTheme());
    expect(disconnect).not.toHaveBeenCalled();

    unmount();
    expect(disconnect).toHaveBeenCalled();
  });
});

describe('ISS-41 — the theme hook has a single source', () => {
  it('WidgetRenderer no longer declares a private useTheme', () => {
    const source = readFileSync(
      join(process.cwd(), 'apps/desktop/src/renderer/components/chat/WidgetRenderer.tsx'),
      'utf8',
    );
    expect(source).toContain("import { useTheme } from '@/hooks/useTheme';");
    expect(source).not.toMatch(/^\s*(?:export\s+)?function useTheme\b/m);
    expect(source).not.toMatch(/^\s*(?:export\s+)?const useTheme\s*=/m);
  });
});
