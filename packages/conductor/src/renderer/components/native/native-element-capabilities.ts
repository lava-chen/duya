import type { CanvasElement } from "../../types/conductor";

export type NativeEditMode = "rich-text" | "markdown" | "table" | "database" | "none";
export type NativeSelectionToolbar = "shape" | "sticky" | "text" | "utility" | "none";
export type NativeResizeHandles = "all" | "horizontal" | "none";

export interface NativeElementCapabilities {
  editMode: NativeEditMode;
  selectionToolbar: NativeSelectionToolbar;
  resizeHandles: NativeResizeHandles;
  startEditingOnCreate: boolean;
  usesChrome: boolean;
}

const DEFAULT_CAPABILITIES: NativeElementCapabilities = {
  editMode: "none",
  selectionToolbar: "utility",
  resizeHandles: "all",
  startEditingOnCreate: false,
  usesChrome: true,
};

const NATIVE_CAPABILITIES: Record<string, NativeElementCapabilities> = {
  sticky: {
    editMode: "rich-text",
    selectionToolbar: "sticky",
    resizeHandles: "all",
    startEditingOnCreate: true,
    usesChrome: true,
  },
  shape: {
    editMode: "rich-text",
    selectionToolbar: "shape",
    resizeHandles: "all",
    startEditingOnCreate: false,
    usesChrome: true,
  },
  text: {
    editMode: "rich-text",
    selectionToolbar: "text",
    resizeHandles: "all",
    startEditingOnCreate: true,
    usesChrome: true,
  },
  document: {
    editMode: "markdown",
    selectionToolbar: "utility",
    resizeHandles: "all",
    startEditingOnCreate: true,
    usesChrome: true,
  },
  table: {
    editMode: "table",
    selectionToolbar: "utility",
    resizeHandles: "horizontal",
    startEditingOnCreate: true,
    usesChrome: true,
  },
  database: {
    editMode: "database",
    selectionToolbar: "utility",
    resizeHandles: "all",
    startEditingOnCreate: true,
    usesChrome: true,
  },
  image: DEFAULT_CAPABILITIES,
  file: DEFAULT_CAPABILITIES,
  link: DEFAULT_CAPABILITIES,
  group: {
    ...DEFAULT_CAPABILITIES,
    usesChrome: false,
  },
  connector: {
    ...DEFAULT_CAPABILITIES,
    selectionToolbar: "none",
    resizeHandles: "none",
    usesChrome: false,
  },
};

function nativeType(elementKind: string): string {
  return elementKind.replace(/^native\//, "");
}

function isShapePresentation(element: Pick<CanvasElement, "elementKind" | "config">): boolean {
  return element.elementKind === "native/shape"
    || element.config.presentation === "shape"
    || ["filled", "outline", "dashed"].includes(element.config.shapePreset as string);
}

export function getNativeElementCapabilities(
  element: Pick<CanvasElement, "elementKind" | "config">,
): NativeElementCapabilities {
  const base = NATIVE_CAPABILITIES[nativeType(element.elementKind)] ?? DEFAULT_CAPABILITIES;
  if (base.selectionToolbar === "sticky" && isShapePresentation(element)) {
    return { ...base, selectionToolbar: "shape" };
  }
  return base;
}

export function getNativeTypeCapabilities(nodeType: string): NativeElementCapabilities {
  return NATIVE_CAPABILITIES[nodeType] ?? DEFAULT_CAPABILITIES;
}

export function shouldStartEditingOnCreate(nodeType: string): boolean {
  return getNativeTypeCapabilities(nodeType).startEditingOnCreate;
}
