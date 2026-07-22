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
    'Element kind determines which config fields are expected:\n' +
    '  - native/shape:     { text, shape?, shapePreset? } — a diagram node; use for flowcharts and frameworks\n' +
    '  - native/document:  { title?, markdown?, filePath? } — a durable Markdown draft linked to the project\n' +
    '  - native/table:     { title?, headers?: string[], rows?: string[][], headerFill?, headerTextColor?, borderColor? } — an editable grid for comparisons, schedules, and research data\n' +
    '  - native/sticky:    legacy colored note; do not create new ones\n' +
    '  - native/image:     { url, fileName? } — image from a URL\n' +
    '  - native/file:      { fileName, mimeType?, url? } — file attachment\n' +
    '  - native/connector: { source, target, routingMode?: "elbow"|"curve", label?, curveMidpointOffset?, curveControlOffsets?, color?, strokeStyle?, startMarker?, endMarker? } — endpoints are {kind:"bound",nodeId,bindingPoint:{u,v}} with u/v in 0..1, or {kind:"free",point:{x,y}} in canvas pixels. Curve midpoint offsets are relative to the endpoint midpoint. Elbow is the default; use curve only when explicitly requested.\n' +
    '  - native/link:      { linkType: "url"|"session"|"canvas", url?, targetId?, title?, description? } — reference card\n' +
    '  - widget/dynamic:   last-resort HTML/SVG for one small secondary mini component; never use it for a whole guide, plan, diagram, or dashboard\n\n' +
    'Position is required and uses canvas grid units (1 unit = 80px). ' +
    'ALWAYS provide w and h; do not omit them. Choose size based on content — do NOT oversize: ' +
    'compact label 2.5x1, short Chinese line 3x1, two short lines 3.5x1.5, standard note 4x2. ' +
    'Fractional grid sizes are valid. Compact labels are centered automatically and render at 22px by default. ' +
    'Legacy fontSize values are clamped to 20px for compact labels and 18px for longer notes; for explicit control use 20-24px. ' +
    'Auto-fit preserves a readable zoom floor, but excess whitespace still makes the board harder to scan. ' +
    'config and vizSpec are optional and can be set later. ' +
    'Returns the new elementId in the result — use it with canvas_fill_content / ' +
    'canvas_style_element / canvas_move_element to complete the element. ' +
    'Example: { "kind": "native/sticky", "position": {"x":1,"y":1,"w":2.5,"h":1}, "config": {"text":"开始","fontSize":22,"color":"yellow"} }',
  input_schema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        description:
          'Element kind. Prefer native/shape, native/document, native/text, native/table, native/image, native/file, native/connector, or native/link. ' +
          'widget/dynamic is only for one compact secondary mini component, never the primary canvas content.',
      },
      position: {
        type: 'object',
        description:
          'Element position in canvas grid units (1 unit = 80px). ' +
          'Required fields: x, y (top-left corner). ' +
          'Required: w, h (width/height in grid units). ' +
          'Choose w/h based on content length; use 2.5x1 for a compact label and 4x2 for a standard note. ' +
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
          'Initial content config for the element (kind-specific). ' +
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
          'Required only when kind="widget/dynamic". Use only for a compact secondary mini component, never a guide, itinerary, diagram, or dashboard. ' +
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
