import { describe, expect, it } from "vitest";
import {
  columnPixelWidths,
  formatWallSeparatorLabel,
  layoutFromPanes,
  normalizeShares,
  paneIdsInColumn,
  placePane,
  removePane,
  rowPixelHeights,
  sanitizeLayout,
  setActivePane,
  setColumnRatios,
  setColumnRowRatios,
  setRowRatios,
  toggleExpandedPane,
  wallColumnsFor,
  wallShapeFor,
  type PaneIdentity,
} from "../panels/layout-model";

function identities(...ids: string[]): PaneIdentity[] {
  return ids.map((id) => ({ id, pageId: "workspace" }));
}

describe("wall shape", () => {
  it("stacks one or two cards in a single column", () => {
    expect(wallColumnsFor(0)).toBe(1);
    expect(wallColumnsFor(1)).toBe(1);
    expect(wallColumnsFor(2)).toBe(1);
  });

  it("switches to a two-column grid from the third card on", () => {
    expect(wallColumnsFor(3)).toBe(2);
    expect(wallColumnsFor(4)).toBe(2);
    expect(wallColumnsFor(5)).toBe(2);
  });

  it("derives the row count from the card count", () => {
    expect(wallShapeFor(1)).toEqual({ columns: 1, rows: 1 });
    expect(wallShapeFor(2)).toEqual({ columns: 1, rows: 2 });
    expect(wallShapeFor(3)).toEqual({ columns: 2, rows: 2 });
    expect(wallShapeFor(4)).toEqual({ columns: 2, rows: 2 });
    expect(wallShapeFor(5)).toEqual({ columns: 2, rows: 3 });
  });
});

describe("layoutFromPanes", () => {
  it("keeps the card order and splits the wall evenly", () => {
    const layout = layoutFromPanes(identities("a", "b", "c"));
    expect(layout.panes).toEqual(["a", "b", "c"]);
    expect(layout.paneColumns).toEqual([0, 0, 1]);
    expect(layout.columns).toBe(2);
    expect(layout.columnRatios).toEqual([0.5, 0.5]);
    expect(layout.columnRowRatios).toEqual([[0.5, 0.5], [1]]);
    expect(layout.expandedPaneId).toBeNull();
    expect(layout.activePaneId).toBe("a");
  });

  it("gives a single card the whole wall", () => {
    const layout = layoutFromPanes(identities("a"));
    expect(layout.columns).toBe(1);
    expect(layout.columnRatios).toEqual([1]);
    expect(layout.columnRowRatios).toEqual([[1]]);
  });
});

describe("placePane", () => {
  it("stacks two cards in each column before extending a stack", () => {
    const layout = placePane(layoutFromPanes(identities("a", "b")), "c");
    expect(layout.panes).toEqual(["a", "b", "c"]);
    expect(layout.paneColumns).toEqual([0, 0, 1]);
    expect(layout.columns).toBe(2);
    expect(layout.columnRowRatios).toEqual([[0.5, 0.5], [1]]);

    const four = placePane(layout, "d");
    expect(four.paneColumns).toEqual([0, 0, 1, 1]);
    expect(paneIdsInColumn(four, 0)).toEqual(["a", "b"]);
    expect(paneIdsInColumn(four, 1)).toEqual(["c", "d"]);
  });

  it("keeps the card where it is when it is already in the wall", () => {
    const layout = layoutFromPanes(identities("a", "b", "c"));
    expect(placePane(layout, "b")).toBe(layout);
  });
});

describe("removePane", () => {
  it("keeps remaining cards in their columns and closes the local gap", () => {
    const layout = removePane(layoutFromPanes(identities("a", "b", "c")), "b");
    expect(layout.panes).toEqual(["a", "c"]);
    expect(layout.paneColumns).toEqual([0, 1]);
    expect(layout.columns).toBe(2);
    expect(layout.columnRowRatios).toEqual([[1], [1]]);
  });

  it("removes an empty column without moving the surviving stack", () => {
    const layout = removePane(layoutFromPanes(identities("a", "b", "c", "d")), "a");
    expect(layout.paneColumns).toEqual([0, 1, 1]);
    expect(layout.columns).toBe(2);
    const oneColumn = removePane(layout, "b");
    expect(oneColumn.paneColumns).toEqual([0, 0]);
    expect(oneColumn.columns).toBe(1);
  });

  it("drops an expanded card that leaves the wall", () => {
    const expanded = toggleExpandedPane(layoutFromPanes(identities("a", "b")), "b");
    expect(expanded.expandedPaneId).toBe("b");
    expect(removePane(expanded, "b").expandedPaneId).toBeNull();
  });

  it("moves the focus to a remaining card", () => {
    const focused = setActivePane(layoutFromPanes(identities("a", "b")), "b");
    expect(removePane(focused, "b").activePaneId).toBe("a");
  });
});

describe("shares", () => {
  it("normalizes the shares to one", () => {
    expect(normalizeShares([1, 1], 2)).toEqual([0.5, 0.5]);
    expect(normalizeShares([3, 1], 2)).toEqual([0.75, 0.25]);
  });

  it("keeps every share above the floor", () => {
    const shares = normalizeShares([100, 1], 2);
    expect(shares[0]).toBeLessThan(1);
    expect(shares[1]).toBeGreaterThan(0);
    expect(shares[0] + shares[1]).toBeCloseTo(1);
  });

  it("fills missing shares evenly", () => {
    expect(normalizeShares(undefined, 3)).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  it("sets the column shares of a wall", () => {
    const layout = setColumnRatios(layoutFromPanes(identities("a", "b", "c")), [1, 3]);
    expect(layout.columnRatios[0]).toBeCloseTo(0.25, 5);
    expect(layout.columnRatios[1]).toBeCloseTo(0.75, 5);
  });

  it("sets the row shares independently for each column", () => {
    const initial = layoutFromPanes(identities("a", "b", "c", "d"));
    const left = setColumnRowRatios(initial, 0, [1, 2]);
    const layout = setColumnRowRatios(left, 1, [3, 1]);
    expect(layout.columnRowRatios[0]?.[0]).toBeCloseTo(1 / 3, 5);
    expect(layout.columnRowRatios[0]?.[1]).toBeCloseTo(2 / 3, 5);
    expect(layout.columnRowRatios[1]?.[0]).toBeCloseTo(3 / 4, 5);
    expect(layout.columnRowRatios[1]?.[1]).toBeCloseTo(1 / 4, 5);
  });

  it("sets the first column row shares through the compatibility helper", () => {
    const layout = setRowRatios(layoutFromPanes(identities("a", "b")), [1, 2]);
    expect(layout.columnRowRatios[0]?.[0]).toBeCloseTo(1 / 3, 5);
    expect(layout.columnRowRatios[0]?.[1]).toBeCloseTo(2 / 3, 5);
  });
});

describe("toggleExpandedPane", () => {
  it("expands and collapses the card", () => {
    const layout = layoutFromPanes(identities("a", "b"));
    const expanded = toggleExpandedPane(layout, "a");
    expect(expanded.expandedPaneId).toBe("a");
    expect(toggleExpandedPane(expanded, "a").expandedPaneId).toBeNull();
  });

  it("ignores a card that is not in the wall", () => {
    const layout = layoutFromPanes(identities("a"));
    expect(toggleExpandedPane(layout, "zzz")).toBe(layout);
  });
});

describe("pixel geometry", () => {
  it("splits the wall between the columns and leaves the gaps out", () => {
    const layout = layoutFromPanes(identities("a", "b", "c"));
    const widths = columnPixelWidths(layout, 404, 4);
    expect(widths).toHaveLength(2);
    expect(widths[0]).toBe(200);
    expect(widths[1]).toBe(200);
    expect(widths[0] + widths[1]).toBe(400);
  });

  it("splits the wall between the rows and leaves the gaps out", () => {
    const layout = layoutFromPanes(identities("a", "b"));
    const heights = rowPixelHeights(layout, 204, 4, 0);
    expect(heights).toEqual([100, 100]);
  });

  it("uses a separate row split for the right column", () => {
    const layout = setColumnRowRatios(layoutFromPanes(identities("a", "b", "c", "d")), 1, [3, 1]);
    expect(rowPixelHeights(layout, 204, 4, 0)).toEqual([100, 100]);
    expect(rowPixelHeights(layout, 204, 4, 1)).toEqual([150, 50]);
  });

  it("returns nothing when the wall has no size yet", () => {
    const layout = layoutFromPanes(identities("a", "b", "c"));
    expect(columnPixelWidths(layout, 0, 4)).toEqual([]);
    expect(rowPixelHeights(layout, 0, 4)).toEqual([]);
  });
});

describe("sanitizeLayout", () => {
  it("drops cards that no longer exist", () => {
    const stored = {
      panes: ["a", "gone"],
      columns: 1,
      columnRatios: [1],
      rowRatios: [0.5, 0.5],
      expandedPaneId: null,
      activePaneId: "a",
    };
    const layout = sanitizeLayout(stored, identities("a", "b"));
    expect(layout?.panes).toEqual(["a"]);
    expect(layout?.columnRowRatios).toEqual([[1]]);
  });

  it("migrates a persisted row-major grid without moving its cards", () => {
    const stored = {
      panes: ["a", "b", "c", "d"],
      columns: 2,
      columnRatios: [0.4, 0.6],
      rowRatios: [0.25, 0.75],
      expandedPaneId: null,
      activePaneId: "d",
    };
    const layout = sanitizeLayout(stored, identities("a", "b", "c", "d"));
    expect(layout?.paneColumns).toEqual([0, 1, 0, 1]);
    expect(layout?.columnRowRatios[0]).toEqual([0.25, 0.75]);
    expect(layout?.columnRowRatios[1]).toEqual([0.25, 0.75]);
    expect(layout?.columnRatios[0]).toBeCloseTo(0.4, 5);
    expect(layout?.columnRatios[1]).toBeCloseTo(0.6, 5);
  });

  it("compacts a persisted column after its only pane was removed", () => {
    const stored = {
      panes: ["gone", "b"],
      columns: 2,
      columnRatios: [0.35, 0.65],
      rowRatios: [0.4],
      expandedPaneId: null,
      activePaneId: "b",
    };
    const layout = sanitizeLayout(stored, identities("b"));
    expect(layout?.panes).toEqual(["b"]);
    expect(layout?.paneColumns).toEqual([0]);
    expect(layout?.columns).toBe(1);
    expect(layout?.columnRowRatios).toEqual([[1]]);
    expect(layout?.columnRatios).toEqual([1]);
  });

  it("drops an expanded card that no longer exists", () => {
    const stored = {
      panes: ["a"],
      columns: 1,
      columnRatios: [1],
      rowRatios: [1],
      expandedPaneId: "gone",
      activePaneId: "a",
    };
    expect(sanitizeLayout(stored, identities("a"))?.expandedPaneId).toBeNull();
  });

  it("rejects a payload that is not a wall", () => {
    expect(sanitizeLayout(null, identities("a"))).toBeNull();
    expect(sanitizeLayout({ columns: [] }, identities("a"))).toBeNull();
  });

  it("rejects the legacy column tree so it is migrated instead", () => {
    const legacy = { columns: [{ id: "c1", widthRatio: 1, panes: ["a"], ratios: [1] }], activePaneId: "a" };
    expect(sanitizeLayout(legacy, identities("a"))).toBeNull();
  });
});

describe("formatWallSeparatorLabel", () => {
  it("names both sides of the boundary", () => {
    expect(formatWallSeparatorLabel(["Files"], ["Terminal", "Browser"]))
      .toBe("调整 Files 和 Terminal 和 Browser 的大小");
  });

  it("names a boundary with only one side", () => {
    expect(formatWallSeparatorLabel([], ["Files"])).toBe("调整 Files 的大小");
    expect(formatWallSeparatorLabel(["Files"], [])).toBe("调整 Files 的大小");
  });

  it("falls back when neither side has a card", () => {
    expect(formatWallSeparatorLabel([], [])).toBe("调整面板的大小");
  });
});
