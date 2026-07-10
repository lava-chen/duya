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

function normalizeConnectorEndpoint(value: unknown): { nodeId: string } | undefined {
  if (typeof value === 'string') {
    return value ? { nodeId: value } : undefined;
  }
  if (value && typeof value === 'object' && 'nodeId' in value) {
    const nodeId = (value as { nodeId?: string }).nodeId;
    return nodeId ? { nodeId } : undefined;
  }
  return undefined;
}

function normalizeConnectorConfig(config: Record<string, unknown>): Record<string, unknown> {
  return {
    ...config,
    source: normalizeConnectorEndpoint(config.source) ?? config.source,
    target: normalizeConnectorEndpoint(config.target) ?? config.target,
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
    '  - native/sticky:    { text, color? }  — a colored note with text\n' +
    '  - native/image:     { url, fileName? } — image from a URL\n' +
    '  - native/file:      { fileName, mimeType?, url? } — file attachment\n' +
    '  - native/connector: { source, target } — bezier connector between two elements\n' +
    '  - widget/dynamic:   HTML/SVG sourceCode for custom visual content\n\n' +
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
          'Element kind. One of: "native/sticky", "native/image", "native/file", ' +
          '"native/connector", "widget/dynamic".',
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
          'Required when kind="widget/dynamic". HTML or SVG string to render in sandboxed iframe. ' +
          'Must be self-contained (no external resources, no <script>). Inline CSS only. ' +
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
    // both store { nodeId: string } in the database.
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

    const response = await ipcRequest(context, 'element.create', {
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
