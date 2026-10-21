// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasElement } from "../../../../types/conductor";

const mocks = vi.hoisted(() => ({
  state: {
    editingElementId: "element-1" as string | null,
    setEditingElementId: vi.fn(),
    activeCanvasId: "canvas-1" as string | null,
    elements: [] as CanvasElement[],
    updateElement: vi.fn(),
    setUiError: vi.fn(),
  },
  executeAction: vi.fn(),
  updateElementContent: vi.fn(),
}));

vi.mock("../../../../stores/conductor-store", () => {
  const useConductorStore = (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state);
  useConductorStore.getState = () => mocks.state;
  return { useConductorStore };
});

vi.mock("../../../../ipc/conductor-ipc", () => ({
  executeAction: mocks.executeAction,
  updateElementContent: mocks.updateElementContent,
}));

import { useElementEditSession } from "../useElementEditSession";
import { useElementPersistence } from "../useElementPersistence";

function element(): CanvasElement {
  return {
    id: "element-1",
    canvasId: "canvas-1",
    elementKind: "native/text",
    position: { x: 0, y: 0, w: 3, h: 1, zIndex: 0, rotation: 0 },
    config: { content: "before" },
    state: "idle",
    dataVersion: 0,
    createdAt: 0,
    updatedAt: 0,
    vizSpec: null,
    sourceCode: null,
    permissions: { agentCanRead: true, agentCanWrite: true, agentCanDelete: true },
    metadata: { label: "", tags: [], createdBy: "user" },
  };
}

describe("useElementEditSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.editingElementId = "element-1";
    mocks.state.setEditingElementId.mockImplementation((id: string | null) => {
      mocks.state.editingElementId = id;
    });
    mocks.state.elements = [element()];
    mocks.state.updateElement.mockImplementation((id: string, patch: Partial<CanvasElement>) => {
      mocks.state.elements = mocks.state.elements.map((current) => current.id === id
        ? {
            ...current,
            ...patch,
            ...(patch.position ? { position: { ...current.position, ...patch.position } } : {}),
          }
        : current);
    });
    mocks.executeAction.mockResolvedValue({ success: true });
    mocks.updateElementContent.mockResolvedValue({ success: true });
  });

  it("uses the same save contract for explicit and external editing exits", async () => {
    const onCommit = vi.fn();
    const { result, rerender } = renderHook(() => useElementEditSession({
      elementId: "element-1",
      source: "before",
      createDraft: (source: string) => source,
      onCommit,
    }));

    act(() => result.current.setDraft("after"));
    mocks.state.editingElementId = null;
    rerender();

    await waitFor(() => expect(onCommit).toHaveBeenCalledWith("after"));
  });

  it("cancels without committing and restores the source draft", () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const { result } = renderHook(() => useElementEditSession({
      elementId: "element-1",
      source: "before",
      createDraft: (source: string) => source,
      onCommit,
      onCancel,
    }));

    act(() => result.current.setDraft("after"));
    act(() => result.current.cancel());

    expect(result.current.draft).toBe("before");
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(mocks.state.setEditingElementId).toHaveBeenCalledWith(null);
  });
});

describe("useElementPersistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.activeCanvasId = "canvas-1";
    mocks.state.elements = [element()];
    mocks.state.updateElement.mockImplementation((id: string, patch: Partial<CanvasElement>) => {
      mocks.state.elements = mocks.state.elements.map((current) => current.id === id
        ? {
            ...current,
            ...patch,
            ...(patch.position ? { position: { ...current.position, ...patch.position } } : {}),
          }
        : current);
    });
  });

  it("rolls back normalized optimistic geometry when persistence fails", async () => {
    mocks.executeAction.mockRejectedValue(new Error("offline"));
    const original = mocks.state.elements[0];
    const { result } = renderHook(() => useElementPersistence(original));

    act(() => result.current({
      position: { ...original.position, x: 4, w: 6 },
    }, "Save text failed"));

    await waitFor(() => expect(mocks.state.setUiError).toHaveBeenCalledWith("Save text failed: offline"));
    expect(mocks.state.elements[0].position).toEqual(original.position);
  });
});
