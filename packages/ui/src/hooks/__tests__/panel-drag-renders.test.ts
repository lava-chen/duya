// @vitest-environment jsdom
/**
 * A panel drag must not cost the app a re-render.
 *
 * Dragging the panel edge changes the region's width on every frame, and
 * dragging a wall separator changes the column ratios on every frame. Those
 * two values used to live in the shared panel context, so every consumer of
 * that context -- the app shell, the sidebar with its session list, the
 * chat view, every panel header -- re-rendered on every pixel of the drag.
 *
 * The contract is a COUNT, not a duration:
 *
 *   - a consumer of the shared context does not re-render when the width
 *     changes (only the panel zone, which draws the geometry, does),
 *   - the panel state is not written to localStorage while the state keeps
 *     changing (a drag writes nothing; the state is written once, when the
 *     gesture settles).
 *
 * Both are properties of the code that do not move with the machine.
 */
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PanelProvider, usePanel, usePanelGeometry } from '../usePanel';
import { useConversationStore } from '@/stores/conversation-store';

function wrapper({ children }: { children: ReactNode }) {
  return createElement(PanelProvider, null, children);
}

describe('panel drag — the width does not re-render the app', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useConversationStore.setState({ activeThreadId: null });
  });

  it('does not re-render a consumer of the shared context', () => {
    let renders = 0;
    const { result } = renderHook(
      () => {
        renders += 1;
        return usePanel();
      },
      { wrapper },
    );
    const before = renders;

    act(() => {
      result.current.setPanelWidth(520);
    });

    // The context value is unchanged, so nobody who reads it re-renders.
    expect(renders).toBe(before);
  });

  it('changes the geometry when the width changes', () => {
    // One provider for both hooks: the geometry is read through its own
    // context, and it has to be the same panel the width is set on.
    const { result } = renderHook(
      () => ({ panel: usePanel(), geometry: usePanelGeometry() }),
      { wrapper },
    );

    act(() => {
      result.current.panel.setPanelWidth(520);
    });

    expect(result.current.geometry.panelWidth).toBe(520);
  });
});

describe('panel drag — the state is written once, not once per frame', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useConversationStore.setState({ activeThreadId: null });
  });

  it('does not write the panel state while the layout keeps changing', async () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem');
    const { result } = renderHook(() => usePanel(), { wrapper });

    act(() => {
      // Every call changes the wall's layout, which is what a separator
      // drag does on every frame.
      result.current.setColumnWidths([400, 400]);
      result.current.setColumnWidths([380, 420]);
      result.current.setColumnWidths([360, 440]);
    });

    // Nothing is written while the state is in motion.
    expect(spy).not.toHaveBeenCalled();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });

    // And once the state settles, it is written exactly once.
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
