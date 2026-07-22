import { describe, expect, it } from "vitest";
import { getNativeElementCapabilities, shouldStartEditingOnCreate } from "../native-element-capabilities";

function element(elementKind: `native/${string}`, config: Record<string, unknown> = {}) {
  return { elementKind, config };
}

describe("native element capabilities", () => {
  it("only exposes edit mode for elements with a real editor", () => {
    expect(getNativeElementCapabilities(element("native/text")).editMode).toBe("rich-text");
    expect(getNativeElementCapabilities(element("native/document")).editMode).toBe("markdown");
    expect(getNativeElementCapabilities(element("native/table")).editMode).toBe("table");
    expect(getNativeElementCapabilities(element("native/database")).editMode).toBe("database");
    expect(getNativeElementCapabilities(element("native/image")).editMode).toBe("none");
    expect(getNativeElementCapabilities(element("native/file")).editMode).toBe("none");
    expect(getNativeElementCapabilities(element("native/link")).editMode).toBe("none");
  });

  it("resolves a sticky presented as a diagram shape to the shape toolbar", () => {
    expect(getNativeElementCapabilities(element("native/sticky")).selectionToolbar).toBe("sticky");
    expect(getNativeElementCapabilities(element("native/sticky", { presentation: "shape" })).selectionToolbar).toBe("shape");
    expect(getNativeElementCapabilities(element("native/sticky", { shapePreset: "outline" })).selectionToolbar).toBe("shape");
  });

  it("keeps creation-time editing in the registry instead of CanvasArea branches", () => {
    expect(shouldStartEditingOnCreate("text")).toBe(true);
    expect(shouldStartEditingOnCreate("sticky")).toBe(true);
    expect(shouldStartEditingOnCreate("document")).toBe(true);
    expect(shouldStartEditingOnCreate("table")).toBe(true);
    expect(shouldStartEditingOnCreate("shape")).toBe(false);
    expect(shouldStartEditingOnCreate("image")).toBe(false);
  });

  it("declares table geometry and non-chrome elements explicitly", () => {
    expect(getNativeElementCapabilities(element("native/table")).resizeHandles).toBe("horizontal");
    expect(getNativeElementCapabilities(element("native/database")).resizeHandles).toBe("all");
    expect(getNativeElementCapabilities(element("native/group")).usesChrome).toBe(false);
    expect(getNativeElementCapabilities(element("native/connector")).selectionToolbar).toBe("none");
  });
});
