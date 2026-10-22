// The column tree behind the side panel.
//
// These cases pin the rules the plan's findings describe: a column is a FIXED
// slot, closing a pane reflows its own column only, and no pane is ever
// migrated into another column.

import { describe, expect, it } from "vitest";

import {
  columnPixelWidths,
  createLayout,
  familyResolver,
  formatPaneTreeLabel,
  isPaneVisible,
  layoutFromPanes,
  placePane,
  removePane,
  resolveTargetColumn,
  sanitizeLayout,
  setActivePane,
  setColumnRatios,
  setPaneRatio,
  type WorkspaceLayout,
} from "../panels/layout-model";

interface ColumnSpec {
  panes: string[];
  ratios?: number[];
  widthRatio: number;
}

function build(columns: ColumnSpec[], activePaneId: string | null = null): WorkspaceLayout {
  return {
    columns: columns.map((column, index) => ({
      id: `column-${index + 1}`,
      widthRatio: column.widthRatio,
      panes: [...column.panes],
      ratios: column.ratios ?? column.panes.map(() => 1 / column.panes.length),
    })),
    activePaneId,
  };
}

describe("layout model: closing a pane", () => {
  const layout = build([
    { panes: ["files", "files-2"], ratios: [0.5, 0.5], widthRatio: 0.4 },
    { panes: ["terminal"], widthRatio: 0.6 },
  ]);

  it("lets the remaining pane of the column fill it", () => {
    const result = removePane(layout, "files");
    expect(result.removedColumnId).toBeNull();
    expect(result.layout.columns[0].panes).toEqual(["files-2"]);
    expect(result.layout.columns[0].ratios).toEqual([1]);
  });

  it("leaves the other columns untouched", () => {
    const result = removePane(layout, "files");
    expect(result.layout.columns[1]).toEqual(layout.columns[1]);
  });

  it("keeps the width ratio of the column it reflowed", () => {
    const result = removePane(layout, "files");
    expect(result.layout.columns[0].widthRatio).toBe(0.4);
  });

  it("removes a column that runs empty and keeps the other columns' ratios", () => {
    const result = removePane(layout, "terminal");
    expect(result.removedColumnId).toBe("column-2");
    expect(result.layout.columns).toHaveLength(1);
    expect(result.layout.columns[0].widthRatio).toBe(0.4);
    expect(result.layout.columns[0].panes).toEqual(["files", "files-2"]);
  });

  it("hands the focus to the pane below the closed one", () => {
    const withFocus = setActivePane(layout, "files");
    const result = removePane(withFocus, "files");
    expect(result.layout.activePaneId).toBe("files-2");
  });

  it("hands the focus to the column on the left when the last pane goes", () => {
    const withFocus = setActivePane(layout, "terminal");
    const result = removePane(withFocus, "terminal");
    expect(result.layout.activePaneId).toBe("files-2");
  });

  it("is a no-op for a pane it does not know", () => {
    const result = removePane(layout, "nope");
    expect(result.layout).toBe(layout);
    expect(result.removedColumnId).toBeNull();
  });
});

describe("layout model: where a new pane lands", () => {
  const terminalFamily = familyResolver([
    { id: "term-1", pageId: "terminal" },
    { id: "term-2", pageId: "terminal" },
  ]);
  const mixedFamily = familyResolver([
    { id: "term-1", pageId: "terminal" },
    { id: "files-1", pageId: "files" },
  ]);

  it("puts a pane of another family into a column of its own", () => {
    const layout = build([{ panes: ["term-1"], widthRatio: 1 }], "term-1");
    expect(resolveTargetColumn(layout, "files", mixedFamily)).toBeNull();
  });

  it("puts a pane of the active pane's family into the active column", () => {
    const layout = build([{ panes: ["term-1"], widthRatio: 1 }], "term-1");
    expect(resolveTargetColumn(layout, "terminal", terminalFamily)).toBe("column-1");
  });

  it("opens a new column when the active column is full", () => {
    const layout = build([{ panes: ["term-1", "term-2"], widthRatio: 1 }], "term-1");
    expect(resolveTargetColumn(layout, "terminal", terminalFamily)).toBeNull();
  });

  it("appends the new pane at the bottom of its column and splits the height", () => {
    const layout = build([{ panes: ["term-1"], widthRatio: 1 }], "term-1");
    const result = placePane(layout, "term-2", "column-1");
    expect(result.createdColumn).toBe(false);
    expect(result.layout.columns[0].panes).toEqual(["term-1", "term-2"]);
    expect(result.layout.columns[0].ratios).toEqual([0.5, 0.5]);
  });

  it("appends a new column at the right end", () => {
    const layout = build([{ panes: ["term-1"], widthRatio: 1 }], "term-1");
    const result = placePane(layout, "files-1", null);
    expect(result.createdColumn).toBe(true);
    expect(result.layout.columns).toHaveLength(2);
    expect(result.layout.columns[1].panes).toEqual(["files-1"]);
  });
});

describe("layout model: column widths", () => {
  it("turns the ratios into pixels of the region", () => {
    const layout = build([
      { panes: ["a"], widthRatio: 0.25 },
      { panes: ["b"], widthRatio: 0.75 },
    ]);
    expect(columnPixelWidths(layout, 1000)).toEqual([250, 750]);
  });

  it("normalizes the ratios it is given", () => {
    const layout = build([
      { panes: ["a"], widthRatio: 0.5 },
      { panes: ["b"], widthRatio: 0.5 },
    ]);
    const resized = setColumnRatios(layout, [300, 100]);
    expect(resized.columns[0].widthRatio).toBeCloseTo(0.75);
    expect(resized.columns[1].widthRatio).toBeCloseTo(0.25);
  });

  it("keeps a column's width when a pane of another column is closed", () => {
    const layout = build([
      { panes: ["a", "b"], ratios: [0.5, 0.5], widthRatio: 0.4 },
      { panes: ["c"], widthRatio: 0.6 },
    ]);
    const result = removePane(layout, "a");
    const widths = columnPixelWidths(result.layout, 1000);
    expect(widths[0]).toBeCloseTo(400);
    expect(widths[1]).toBeCloseTo(600);
  });
});

describe("layout model: vertical split inside a column", () => {
  it("gives the other panes the rest of the column", () => {
    const layout = build([{ panes: ["a", "b"], ratios: [0.5, 0.5], widthRatio: 1 }]);
    const resized = setPaneRatio(layout, "column-1", "a", 0.3);
    expect(resized.columns[0].ratios[0]).toBeCloseTo(0.3);
    expect(resized.columns[0].ratios[1]).toBeCloseTo(0.7);
  });

  it("keeps a pane from being squeezed out of the column", () => {
    const layout = build([{ panes: ["a", "b"], ratios: [0.5, 0.5], widthRatio: 1 }]);
    const resized = setPaneRatio(layout, "column-1", "a", 0);
    expect(resized.columns[0].ratios[0]).toBeGreaterThan(0);
    expect(resized.columns[0].ratios[0] + resized.columns[0].ratios[1]).toBeCloseTo(1);
  });
});

describe("layout model: pane visibility", () => {
  const familyOf = familyResolver([
    { id: "term-1", pageId: "terminal" },
    { id: "term-2", pageId: "terminal" },
    { id: "files-1", pageId: "files" },
  ]);

  it("shows the focused pane of a family and hides its siblings", () => {
    const layout = build([{ panes: ["term-1", "term-2"], widthRatio: 1 }], "term-1");
    expect(isPaneVisible(layout, "column-1", "term-1", familyOf)).toBe(true);
    expect(isPaneVisible(layout, "column-1", "term-2", familyOf)).toBe(false);
  });

  it("stacks panes of different families", () => {
    const layout = build([{ panes: ["term-1", "files-1"], widthRatio: 1 }], "term-1");
    expect(isPaneVisible(layout, "column-1", "term-1", familyOf)).toBe(true);
    expect(isPaneVisible(layout, "column-1", "files-1", familyOf)).toBe(true);
  });

  it("keeps a column's own focus when the active pane lives elsewhere", () => {
    const layout = build([
      { panes: ["term-1", "term-2"], widthRatio: 0.5 },
      { panes: ["files-1"], widthRatio: 0.5 },
    ], "files-1");
    expect(isPaneVisible(layout, "column-1", "term-1", familyOf)).toBe(true);
    expect(isPaneVisible(layout, "column-1", "term-2", familyOf)).toBe(false);
  });
});

describe("layout model: migration and validation", () => {
  it("migrates a flat tab list into columns, one per family", () => {
    const layout = layoutFromPanes([
      { id: "t1", pageId: "terminal" },
      { id: "t2", pageId: "terminal" },
      { id: "f1", pageId: "files" },
    ]);
    expect(layout.columns).toHaveLength(2);
    expect(layout.columns[0].panes).toEqual(["t1", "t2"]);
    expect(layout.columns[1].panes).toEqual(["f1"]);
  });

  it("drops panes whose tab is gone and adds tabs the layout never saw", () => {
    const raw = {
      columns: [{ id: "column-1", widthRatio: 1, panes: ["t1", "ghost"], ratios: [0.5, 0.5] }],
      activePaneId: "t1",
    };
    const layout = sanitizeLayout(raw, [
      { id: "t1", pageId: "terminal" },
      { id: "f1", pageId: "files" },
    ]);
    expect(layout).not.toBeNull();
    expect(layout!.columns[0].panes).toEqual(["t1"]);
    expect(layout!.columns.some((column) => column.panes.includes("f1"))).toBe(true);
    expect(layout!.activePaneId).toBe("t1");
  });

  it("rejects a payload that is not a layout", () => {
    expect(sanitizeLayout(null, [])).toBeNull();
    expect(sanitizeLayout({ columns: "nope" }, [])).toBeNull();
  });
});

describe("layout model: separator names", () => {
  it("spells out the panes on both sides of the separator", () => {
    expect(formatPaneTreeLabel(["文件", "终端"], ["浏览器"]))
      .toBe("调整 文件，终端 和 浏览器 的大小");
  });

  it("keeps the order of the panes", () => {
    expect(formatPaneTreeLabel(["a", "b", "c"], ["d"]))
      .toBe("调整 a，b，c 和 d 的大小");
  });
});

describe("layout model: empty layout", () => {
  it("starts without columns", () => {
    expect(createLayout()).toEqual({ columns: [], activePaneId: null });
  });
});
