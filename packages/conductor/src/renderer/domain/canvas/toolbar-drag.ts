export const DRAGGABLE_CREATE_TOOL_IDS = new Set([
  "document",
  "shape",
  "text",
  "table",
  "link",
]);

export interface CanvasToolDragPayload {
  type: "document" | "shape" | "text" | "table" | "link";
  extra: Record<string, unknown>;
}

export function getCanvasToolDragPayload(toolId: string): CanvasToolDragPayload | null {
  if (!DRAGGABLE_CREATE_TOOL_IDS.has(toolId)) return null;

  switch (toolId) {
    case "shape":
      return {
        type: "shape",
        extra: {
          presentation: "shape",
          shape: "rect",
          shapePreset: "filled",
          color: "yellow",
          bgColor: "#F4B566",
          borderStyle: { color: "#E98436", width: 1, style: "solid" },
        },
      };
    case "link":
      return { type: "link", extra: { linkType: "url", title: "Link", url: "" } };
    case "document":
    case "text":
    case "table":
      return { type: toolId, extra: {} };
    default:
      return null;
  }
}
