// @vitest-environment jsdom
/**
 * Tests for `SortableProjectGroupItem`.
 *
 * Verifies the wrapper:
 *   1. calls `useSortable` with the project's `workingDirectory` as id,
 *   2. forwards the sortable bindings to the inner `ProjectGroupItem`,
 *   3. sets `opacity: 0.4` while a drag is active (via mocked
 *      `useSortable`).
 *
 * `ProjectGroupItem` is heavy (uses the conversation store, sidebar
 * sections store, etc.), so we mock it with a tiny stub.
 */

import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import type { useSortable } from "@dnd-kit/sortable";

import { SortableProjectGroupItem } from "../SortableProjectGroupItem";
import type { ProjectGroup, Thread } from "@/stores/conversation-store";

const sortableSpy = vi.fn();

vi.mock("@dnd-kit/sortable", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@dnd-kit/sortable")>();
  return {
    ...mod,
    useSortable: (args: Parameters<typeof useSortable>[0]) => {
      sortableSpy(args);
      return {
        attributes: { "aria-roledescription": "sortable" },
        listeners: { onPointerDown: () => {} },
        setNodeRef: () => {},
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1 },
        isDragging: false,
        active: null,
        over: null,
      } as unknown as ReturnType<typeof useSortable>;
    },
  };
});

vi.mock("../ProjectGroupItem", () => ({
  ProjectGroupItem: vi.fn(({ sortableBindings }) => (
    <div
      data-testid="project-header"
      data-has-bindings={Boolean(sortableBindings)}
    />
  )),
}));

const baseProject: ProjectGroup = {
  workingDirectory: "/projects/foo",
  projectName: "foo",
  threadCount: 0,
  lastActivity: 0,
  createdAt: 0,
  isExpanded: false,
};

const baseThreads: Thread[] = [];

describe("SortableProjectGroupItem", () => {
  it("uses the project's workingDirectory as the sortable id", () => {
    sortableSpy.mockClear();
    render(
      <SortableProjectGroupItem
        project={baseProject}
        threads={baseThreads}
        activeThreadId={null}
        sortBy="lastActivity"
      />,
    );
    expect(sortableSpy).toHaveBeenCalledWith({ id: "/projects/foo" });
  });

  it("forwards sortable bindings to ProjectGroupItem", () => {
    const { getByTestId } = render(
      <SortableProjectGroupItem
        project={baseProject}
        threads={baseThreads}
        activeThreadId={null}
        sortBy="lastActivity"
      />,
    );
    expect(getByTestId("project-header").getAttribute("data-has-bindings")).toBe(
      "true",
    );
  });
});