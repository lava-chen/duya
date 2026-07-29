/**
 * canvas_create_element tool.
 *
 * Creates a new element on the bound canvas. The element kind dictates
 * which config fields are expected (see canvas_fill_content for the
 * per-kind schema). Position is required; config and vizSpec are
 * optional and can be filled later via canvas_fill_content /
 * canvas_style_element.
 *
 * The canvasId is injected via ToolUseContext.conductorCanvasId —
 * the LLM never needs to track canvas state. Returns the new
 * elementId in the result so the model can chain fill/style calls.
 */

import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { getCanvasId, ipcRequest, noCanvasIdResult, noContextResult } from './ipc-request.js';
import { formatValidationErrors, validateElementInput } from './validate.js';
import { appendWidgetStyleSignature, extractWidgetStyleSignature } from './style-signature.js';
import { trackCreatedElement } from './freshness.js';

export const TOOL_NAME = 'canvas_create_element';

function normalizeConnectorEndpoint(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    return value ? { nodeId: value, anchorId: 'center' } : undefined;
  }
  if (value && typeof value === 'object' && (value as Record<string, unknown>).kind === 'free') {
    return { ...(value as Record<string, unknown>) };
  }
  if (value && typeof value === 'object' && 'nodeId' in value) {
    const endpoint = value as Record<string, unknown>;
    const nodeId = endpoint.nodeId;
    if (typeof nodeId !== 'string' || !nodeId) return undefined;
    return endpoint.kind === 'bound'
      ? { ...endpoint, nodeId }
      : { anchorId: 'center', ...endpoint, nodeId };
  }
  return undefined;
}

function normalizeConnectorConfig(config: Record<string, unknown>): Record<string, unknown> {
  return {
    ...config,
    source: normalizeConnectorEndpoint(config.source) ?? config.source,
    target: normalizeConnectorEndpoint(config.target) ?? config.target,
    routingMode: config.routingMode ?? 'elbow',
  };
}

function normalizeCreateElementInput(input: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...input };

  // Fix: LLM sometimes puts position.x/y/w/h as top-level fields
  if (!normalized.position || typeof normalized.position !== 'object') {
    const pos: Record<string, unknown> = {};
    for (const key of ['x', 'y', 'w', 'h', 'zIndex', 'rotation']) {
      if (key in normalized) {
        pos[key] = normalized[key];
        delete normalized[key];
      }
    }
    if (Object.keys(pos).length > 0) {
      normalized.position = pos;
    }
  }

  // Fix: LLM sometimes puts config.text/color at top-level instead of inside config
  if (!normalized.config || typeof normalized.config !== 'object') {
    const cfg: Record<string, unknown> = {};
    for (const key of ['text', 'color', 'fontSize', 'url', 'fileName', 'mimeType']) {
      if (key in normalized) {
        cfg[key] = normalized[key];
        delete normalized[key];
      }
    }
    if (Object.keys(cfg).length > 0) {
      normalized.config = cfg;
    }
  }

  return normalized;
}

export const definition: Tool = {
  name: TOOL_NAME,
  description:
    'Create a new element on the bound canvas. Call this tool directly when the user asks for any canvas element. ' +
    'The canvasId is injected automatically — never pass it.\n\n' +
    '## Coordinate system (READ THIS FIRST)\n' +
    'position uses canvas GRID units, NOT pixels. 1 grid unit = 80px. Canvas is 40 x 30 grid units. ' +
    'Example: a 4x2 element occupies 320x160px; placing it near canvas center means x≈18, y≈14. ' +
    'ALWAYS provide x, y, w, h. Fractional sizes (e.g. 2.5) are valid. Size to content — do NOT oversize.\n\n' +
    '## Element kinds and their `config` fields (passed at TOP LEVEL of `config`, not in `position`)\n' +
    '  - native/shape:     { text, shape?: "rect"|"rounded"|"ellipse"|"diamond"|"parallelogram"|"triangle"|"hexagon", color?, fontSize? } — preferred diagram node\n' +
    '  - native/text:       { text } — free text, label, caption\n' +
    '  - native/document:   { title?, markdown?, filePath? } — durable Markdown draft linked to the project\n' +
    '  - native/table:      { title?, headers?: string[1..12], rows?: string[][<=50], headerFill?: "#RRGGBB", headerTextColor?, borderColor? } — editable grid\n' +
    '  - native/database:   { sourceId, viewId, sourceTitle?, displayMode:"embedded", showTitle?, previewLimit?:1..200, interactionMode?:"canvas"|"database" } — call database_manage first to get sourceId/viewId\n' +
    '  - native/image:      { url, fileName? }\n' +
    '  - native/file:       { fileName, mimeType?, url?, pdfPage?, pdfZoom? }\n' +
    '  - native/link:       { linkType: "url"|"session"|"canvas", url?, targetId?, title?, description? }\n' +
    '  - native/connector:  { source, target, routingMode?: "elbow"|"curve", label?, labelFontSize?:14..22, color?, strokeStyle?, startMarker?, endMarker? } — see CONNECTOR PREREQUISITES below\n' +
    '  - native/sticky:     LEGACY — do not create; use native/shape instead\n' +
    '  - widget/dynamic:    LAST RESORT only — one compact secondary mini component; never for a whole guide/plan/diagram/dashboard. Requires top-level `sourceCode` field (NOT in config).\n\n' +
    '## COLOR CONSTRAINTS (apply to native/shape and native/sticky)\n' +
    'config.color MUST be one of these 6 enum keys (NOT hex): ' +
    'yellow, blue, green, pink, purple, gray. ' +
    'pink renders as light red (error/warning semantic). ' +
    'For full color → semantic mapping see canvas_get_knowledge("sticky-style").\n\n' +
    '## CONNECTOR PREREQUISITES (read before creating native/connector)\n' +
    '1. Create source and target nodes FIRST via canvas_create_element — connectors require existing nodeIds. ' +
    '2. Call canvas_get_knowledge("connector-style") once before your first connector in a session — it covers routing, colors, markers, and shared-trunk patterns.\n' +
    '3. Each endpoint is one of:\n' +
    '     { kind: "bound", nodeId: "<id>", bindingPoint: { u: 0|1, v: 0..1 } }  // u=0 left edge, u=1 right edge\n' +
    '     { kind: "bound", nodeId: "<id>", bindingPoint: { u: 0..1, v: 0|1 } }  // v=0 top edge, v=1 bottom edge\n' +
    '     { kind: "free",  point: { x, y } }                                    // canvas pixels (NOT grid units)\n' +
    '   CRITICAL: a bound bindingPoint MUST land on the node edge — at least one of u/v must be exactly 0 or 1. ' +
    'Interior points like {u:0.5, v:0.5} are REJECTED even though they satisfy 0..1.\n' +
    '4. routingMode defaults to "elbow" — use "curve" only when the user explicitly asks for an organic curved relation.\n' +
    '5. curveMidpointOffset and curveControlOffsets are RELATIVE to the endpoint midpoint, in canvas pixels.\n\n' +
    '## Parameter shape recap (do NOT mix these up)\n' +
    '  - position: { x, y, w, h } at top level of the tool input.\n' +
    '  - config:   kind-specific content fields, at top level of the tool input (separate from position).\n' +
    '  - sourceCode: top-level field ONLY for widget/dynamic; not used by any other kind.\n\n' +
    '## Common pitfalls\n' +
    '  - Do NOT put text/color/url/source/target at the top level of the tool input — wrap them inside `config`.\n' +
    '  - Do NOT pass `position` inside `config`.\n' +
    '  - Do NOT use hex colors (e.g. "#3B82F6") for native/shape color — use enum keys (yellow/blue/green/pink/purple/gray).\n' +
    '  - Do NOT skip w and h — omission forces the renderer to guess and produces oversized boxes.\n' +
    '  - For native/connector, source and target live INSIDE config (config.source, config.target), not at the tool input top level.\n\n' +
    '## Sizing guide (grid units, w x h)\n' +
    '  compact label 2.5x1     (1-2 Chinese chars, fontSize 22-24, auto-centered)\n' +
    '  short Chinese line 3x1   (3-6 chars, fontSize 20-22)\n' +
    '  two short lines 3.5x1.5  (fontSize 20)\n' +
    '  standard note 4x2        (1-2 sentences, fontSize 20)\n' +
    '  detailed note 5x2.5      (fontSize 20)\n' +
    '  section title 3.5x1.25   (root, fontSize 24)\n' +
    'Compact labels render at 22px by default; legacy fontSize <18 is clamped to 18. Use 20-24px for explicit control.\n\n' +
    'Returns the new elementId — use it with canvas_fill_content / canvas_style_element / canvas_move_element to complete the element. ' +
    'Elements created in THIS session bypass the STALE_STATE check for subsequent mutations.\n\n' +
    '## Worked example (a small flowchart)\n' +
    '{"kind":"native/shape","position":{"x":1,"y":1,"w":2.5,"h":1},"config":{"text":"开始","color":"green","fontSize":22}}\n' +
    '{"kind":"native/shape","position":{"x":5,"y":1,"w":2.5,"h":1},"config":{"text":"处理","color":"blue"}}\n' +
    '{"kind":"native/connector","position":{"x":0,"y":0,"w":1,"h":1},"config":{"source":{"kind":"bound","nodeId":"<id-of-开始>","bindingPoint":{"u":1,"v":0.5}},"target":{"kind":"bound","nodeId":"<id-of-处理>","bindingPoint":{"u":0,"v":0.5}},"routingMode":"elbow","endMarker":"arrow"}}',
  input_schema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        description:
          'Element kind. Prefer native/shape, native/document, native/text, native/table, native/database, native/image, native/file, native/connector, or native/link. ' +
          'native/sticky is LEGACY — use native/shape. ' +
          'widget/dynamic is only for one compact secondary mini component, never the primary canvas content.',
      },
      position: {
        type: 'object',
        description:
          'Element position in canvas GRID units (1 unit = 80px; canvas is 40 x 30 units). ' +
          'Required: x, y (top-left corner), w, h (width/height). ' +
          'Choose w/h based on content length — see sizing guide in tool description. ' +
          'Optional: zIndex, rotation.',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          w: { type: 'number' },
          h: { type: 'number' },
          zIndex: { type: 'number' },
          rotation: { type: 'number' },
        },
        required: ['x', 'y', 'w', 'h'],
      },
      config: {
        type: 'object',
        description:
          'Initial content config for the element (kind-specific fields at top level of this object). ' +
          'For native/shape: { text, color?: "yellow"|"blue"|"green"|"pink"|"purple"|"gray", fontSize?, shape? }. ' +
          'For native/connector: { source, target, routingMode?, ... } where source/target are endpoint objects. ' +
          'Optional — can be set later via canvas_fill_content.',
        additionalProperties: true,
      },
      vizSpec: {
        type: 'object',
        description:
          'Optional visual spec (render hints). Leave undefined unless you ' +
          'need a non-default renderer.',
        additionalProperties: true,
      },
      sourceCode: {
        type: 'string',
        description:
          'Required ONLY when kind="widget/dynamic". TOP-LEVEL field (NOT inside config). ' +
          'Use only for a compact secondary mini component, never a guide, itinerary, diagram, or dashboard. ' +
          'HTML or SVG renders in a sandboxed iframe and is not node-by-node editable. Must be self-contained (no external resources, no <script>). Inline CSS only. ' +
          'SVG must have explicit width/height.',
      },
    },
    required: ['kind', 'position'],
  },
};

export const executor: ToolExecutor = {
  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    if (!context) {
      return noContextResult(TOOL_NAME);
    }

    let canvasId: string;
    try {
      canvasId = getCanvasId(context);
    } catch {
      return noCanvasIdResult(TOOL_NAME);
    }

    const normalizedInput = normalizeCreateElementInput(input);

    const { kind, position, config: rawConfig = {}, vizSpec, sourceCode } = normalizedInput as {
      kind: string;
      position: Record<string, unknown>;
      config?: Record<string, unknown>;
      vizSpec?: Record<string, unknown>;
      sourceCode?: string;
    };

    // Normalize connector endpoints so single-create and batch-create
    // both persist the same bound/free endpoint contract.
    const config = kind === 'native/connector'
      ? normalizeConnectorConfig(rawConfig)
      : rawConfig;

    const validation = validateElementInput(kind, position, config);
    if (!validation.valid) {
      return {
        id: crypto.randomUUID(),
        name: TOOL_NAME,
        result: JSON.stringify({
          success: false,
          error: {
            code: 'INVALID_INPUT',
            message: formatValidationErrors(validation),
          },
        }),
        error: true,
      };
    }

    if (kind === 'widget/dynamic' && !sourceCode) {
      return {
        id: crypto.randomUUID(),
        name: TOOL_NAME,
        result: JSON.stringify({
          success: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'sourceCode is required when kind="widget/dynamic"',
          },
        }),
        error: true,
      };
    }

    // Native canvas elements use the V2 creation path. Besides keeping the
    // renderer contract consistent, this lets native/document create its
    // project-relative Markdown file before the element is persisted.
    const response = kind.startsWith('native/') && kind !== 'native/connector'
      ? await ipcRequest(context, 'element.create_native', {
          canvasId,
          nodeType: kind.slice('native/'.length),
          position,
          content: config,
        })
      : await ipcRequest(context, 'element.create', {
          canvasId,
          kind,
          position,
          config,
          vizSpec,
          ...(sourceCode ? { sourceCode } : {}),
        });

    if (response.success && kind === 'widget/dynamic' && sourceCode && context) {
      const signature = extractWidgetStyleSignature(sourceCode);
      // widgetStyleHistory is a stable array reference injected by DuyaAgent,
      // so mutating it in place survives StreamingToolExecutor's per-call
      // shallow spread of the context.
      if (context.widgetStyleHistory) {
        appendWidgetStyleSignature(context.widgetStyleHistory, signature);
      }
    }

    // Track the newly created element so subsequent fill/style/move calls
    // bypass the STALE_STATE check without forcing another canvas_list_elements.
    if (response.success && context) {
      const createdId = (response as unknown as { data?: { diff?: { targetId?: string } } }).data?.diff?.targetId;
      if (createdId) {
        trackCreatedElement(context, createdId);
      }
    }

    return {
      id: crypto.randomUUID(),
      name: TOOL_NAME,
      result: JSON.stringify(response),
      error: !response.success,
    };
  },
};
