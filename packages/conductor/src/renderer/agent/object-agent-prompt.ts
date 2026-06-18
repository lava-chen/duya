import type { CanvasElement, ConductorSnapshot } from "../types/conductor";

const MAX_JSON_CHARS = 5000;

function compactJson(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  if (json.length <= MAX_JSON_CHARS) return json;
  return `${json.slice(0, MAX_JSON_CHARS)}\n... truncated ...`;
}

function inferObjectCapability(element: CanvasElement): string {
  const kind = element.elementKind;
  const nativeKind = element.native_kind ?? kind.replace(/^native\//, "");

  if (kind.startsWith("widget/")) {
    return "Use widget.update_data for data-only changes. For dynamic HTML/SVG edits, propose a sanitized preview-oriented update and avoid scripts, event handlers, network access, localStorage, or Electron APIs.";
  }
  if (nativeKind === "sticky" || kind === "widget/note-pad") {
    return "Prefer element.update_content or widget.update_data to rewrite note text. Split into new sticky notes only when the user asks for decomposition.";
  }
  if (nativeKind === "mindmap") {
    return "Use mindmap_create for new maps, or element.update_content for updates to the selected mind map tree.";
  }
  if (nativeKind === "connector" || kind.endsWith("/connector")) {
    return "Use connector.create only for new connections. For selected connector styling, use element.update_content or element.update as available.";
  }
  if (nativeKind === "text" || nativeKind === "shape" || nativeKind === "frame" || nativeKind === "section") {
    return "Prefer element.update_content for content or styling. Use element.arrange only when layout changes are explicitly requested.";
  }
  return "Choose the lowest-risk canvas tool that satisfies the request. Avoid deleting or restructuring unless explicitly requested.";
}

export function buildObjectAgentPrompt(args: {
  userRequest: string;
  selectedElements: CanvasElement[];
  allElements: CanvasElement[];
  snapshot: ConductorSnapshot | null;
}): string {
  const primary = args.selectedElements[0];
  const selectedSummary = args.selectedElements.map((element) => ({
    id: element.id,
    elementKind: element.elementKind,
    nativeKind: element.native_kind ?? null,
    label: element.metadata?.label ?? "",
    position: element.position,
    state: element.state,
    permissions: element.permissions,
    config: element.config,
    vizSpec: element.vizSpec,
    sourceCode: element.sourceCode,
  }));

  const canvasSummary = {
    canvasId: primary?.canvasId ?? args.snapshot?.canvas.id,
    canvasName: args.snapshot?.canvas.name ?? "Canvas",
    selectedElementIds: args.selectedElements.map((element) => element.id),
    nearbyElements: args.allElements
      .filter((element) => !args.selectedElements.some((selected) => selected.id === element.id))
      .slice(0, 30)
      .map((element) => ({
        id: element.id,
        elementKind: element.elementKind,
        nativeKind: element.native_kind ?? null,
        label: element.metadata?.label ?? "",
        position: element.position,
      })),
  };

  return [
    "The user is invoking the object-level Conductor agent prompt on the currently selected canvas object.",
    "",
    `User request: ${args.userRequest.trim()}`,
    "",
    "Selected object context:",
    "```json",
    compactJson(selectedSummary),
    "```",
    "",
    "Canvas context:",
    "```json",
    compactJson(canvasSummary),
    "```",
    "",
    "Object-specific guidance:",
    primary ? inferObjectCapability(primary) : "No primary object is selected.",
    "",
    "Execution rules:",
    "- Use existing Conductor canvas tools to produce structured patches/actions.",
    "- Prefer the smallest reversible change that satisfies the request.",
    "- For text-only edits, update content/data rather than recreating the object.",
    "- For widget HTML or SVG changes, preserve safe markup and do not introduce scripts, inline event handlers, or network dependencies.",
    "- For mind maps, preserve existing node ids where possible and only add or reorganize branches needed by the request.",
    "- Do not delete objects unless the user explicitly asks for deletion.",
  ].join("\n");
}

