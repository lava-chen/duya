/**
 * canvas_fill_content tool.
 *
 * Fills or updates the content of an existing canvas element.
 * Content fields are element-kind specific:
 *   - native/shape:     { text: string }
 *   - native/document:  { markdown: string }
 *   - native/image:     { url: string, fileName?: string }
 *   - native/file:      { fileName: string, mimeType?: string, url?: string }
 *   - native/connector: { source: ConnectorEndpoint, target: ConnectorEndpoint }
 *   - widget/*:         { ... per-widget content }
 *
 * This tool writes into the element's `config` object. Visual style
 * fields (color, fontSize, stroke) belong to canvas_style_element.
 * The canvasId is injected via ToolUseContext.conductorCanvasId.
 */

import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { getCanvasId, ipcRequest, noCanvasIdResult, noContextResult } from './ipc-request.js';
import { resolveElementId } from './resolve-element-id.js';
import { isMutationFresh, staleStateResult } from './freshness.js';

export const TOOL_NAME = 'canvas_fill_content';

export const definition: Tool = {
  name: TOOL_NAME,
  description:
    'Fill or update the CONTENT of an existing canvas element (NOT its position or visual style). ' +
    'This is a merge-patch: only the fields you supply are overwritten; other config fields are preserved. ' +
    'The canvasId is injected automatically — never pass it.\n\n' +
    '## PRE-FLIGHT CHECKLIST\n' +
    '1. Call canvas_list_elements (or canvas_get_context) first, OR operate on an element you created via ' +
    'canvas_create_element in THIS session. Without one of these, the call is REJECTED with STALE_STATE. ' +
    '2. Have the elementId ready — from canvas_list_elements or from a recent canvas_create_element result.\n' +
    '3. Confirm which `content` fields apply to the element kind (see table below).\n\n' +
    '## Parameter shape (do NOT confuse with canvas_create_element)\n' +
    '  - elementId: TOP-LEVEL field.\n' +
    '  - content:   NESTED object containing the kind-specific fields (NOT top-level like `config` in canvas_create_element). ' +
    'Example: { elementId: "abc", content: { text: "hello" } } — do NOT pass { elementId: "abc", text: "hello" }.\n' +
    '  - sourceCode: TOP-LEVEL field, ONLY for widget/dynamic. Updates the widget HTML/SVG. Ignored for other kinds.\n' +
    'Do NOT pass `position` here — use canvas_move_element / canvas_resize_element for that.\n' +
    'Do NOT pass visual style here — use canvas_style_element for color/fontSize/stroke.\n\n' +
    '## Content fields per element kind (placed inside `content`)\n' +
    '  - native/shape:     { text?, shape?, color? } — color ∈ yellow|blue|green|pink|purple|gray (enum keys, NOT hex)\n' +
    '  - native/text:       { text }\n' +
    '  - native/document:  { markdown?, title? } — also updates the linked project Markdown file\n' +
    '  - native/sticky:     LEGACY; same fields as native/shape\n' +
    '  - native/image:      { url, fileName? }\n' +
    '  - native/file:       { fileName, mimeType?, url?, pdfPage?, pdfZoom? }\n' +
    '  - native/connector: { source, target, routingMode?, label?, waypoints?, curveMidpointOffset?, curveControlOffsets? } ' +
    '    — endpoints use the SAME shape as canvas_create_element: {kind:"bound", nodeId, bindingPoint:{u,v}} or {kind:"free", point:{x,y}}. ' +
    '    bindingPoint must land on a node edge (u or v is 0 or 1). ' +
    '    curveMidpointOffset is RELATIVE to the endpoint midpoint, in canvas pixels. ' +
    '    Keep routingMode="elbow" unless explicitly asked for a curve. ' +
    '    Before retrying a failed connector, call canvas_get_knowledge("connector-style").\n' +
    '  - native/link:      { linkType?: "url"|"session"|"canvas", url?, targetId?, title?, description?, expanded?, expandedSize?: {w, h} }\n' +
    '  - native/table:     { title?, headers?, rows?, headerFill?, headerTextColor?, borderColor? } — same constraints as create\n' +
    '  - widget/dynamic:   pass sourceCode at the top level of the tool input (NOT inside content) to revise the HTML/SVG\n\n' +
    '## Common pitfalls\n' +
    '  - Putting text/color/source/target at the top level of the tool input — wrap them inside `content`.\n' +
    '  - Treating `content` as a full replacement — it is a MERGE-PATCH; omitted fields keep their existing values.\n' +
    '  - Forgetting STALE_STATE — call canvas_list_elements (or canvas_get_context) first when in doubt.\n' +
    '  - Using hex colors for native/shape color — use enum keys (yellow/blue/green/pink/purple/gray).\n\n' +
    '## Worked example (revising a connector and a sticky)\n' +
    '{"elementId":"<id>","content":{"text":"新文本","color":"pink"}}\n' +
    '{"elementId":"<connector-id>","content":{"source":{"kind":"bound","nodeId":"<node-a>","bindingPoint":{"u":1,"v":0.5}},"target":{"kind":"bound","nodeId":"<node-b>","bindingPoint":{"u":0,"v":0.5}},"label":"new label"}}',
  input_schema: {
    type: 'object',
    properties: {
      elementId: {
        type: 'string',
        description: 'The ID of the element to fill. Obtain it from canvas_list_elements or from canvas_create_element in this turn.',
      },
      content: {
        type: 'object',
        description:
          'NESTED object — kind-specific content fields placed INSIDE this object (NOT at the top level of the tool input). ' +
          'This is a merge-patch: only supplied fields are overwritten; other config fields are preserved. ' +
          'For native/document: put { markdown } HERE. For native/shape: put { text, color? } HERE. ' +
          'For native/connector: put { source, target, ... } HERE — same endpoint shape as canvas_create_element.',
        properties: {
          text: {
            type: 'string',
            description: 'native/shape, native/sticky, native/text: the text content.',
          },
          color: {
            type: 'string',
            description:
              'native/shape, native/sticky: color enum key. One of: yellow, blue, green, pink, purple, gray. ' +
              'NOT a hex string — hex is rejected. pink renders as light red (.s-err, error/warning semantic). ' +
              'See canvas_get_knowledge("sticky-style") for full color → semantic mapping.',
            enum: ['yellow', 'blue', 'green', 'pink', 'purple', 'gray'],
          },
          url: {
            type: 'string',
            description: 'native/image: image URL.',
          },
          fileName: {
            type: 'string',
            description: 'native/image, native/file: file name.',
          },
          mimeType: {
            type: 'string',
            description: 'native/file: MIME type.',
          },
          source: {
            type: 'object',
            description:
              'native/connector: source endpoint. Same shape as canvas_create_element: ' +
              '{kind:"bound", nodeId, bindingPoint:{u, v}} (bindingPoint MUST be on a node edge: u or v is 0 or 1) ' +
              'or {kind:"free", point:{x, y}} (canvas pixels).',
            additionalProperties: true,
          },
          target: {
            type: 'object',
            description:
              'native/connector: target endpoint. Same shape as `source` above.',
            additionalProperties: true,
          },
        },
        additionalProperties: true,
      },
      sourceCode: {
        type: 'string',
        description:
          'TOP-LEVEL field (NOT inside content). New HTML/SVG source for widget/dynamic elements. ' +
          'Use this to revise a widget after creation (e.g. fix layout, change data display, add sections). ' +
          'Ignored for non-widget kinds.',
      },
    },
    required: [],
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

    // Resolve elementId first so we can check freshness against it.
    // fill_content is a merge-patch (idempotent, non-destructive), so
    // we still allow it on freshly-created elements even if list is stale.
    const resolved = resolveElementId({ elementId: input.elementId as string | undefined });
    if ('error' in resolved) {
      return {
        id: crypto.randomUUID(),
        name: TOOL_NAME,
        result: JSON.stringify({ success: false, error: { code: 'INVALID_INPUT', message: resolved.error } }),
        error: true,
      };
    }
    const elementId = resolved.elementId;

    if (!isMutationFresh(context, elementId)) {
      return staleStateResult(TOOL_NAME, elementId);
    }
    let content = (input.content as Record<string, unknown>) ?? {};

    // Fallback: if the LLM put text/color/url/etc. at the top level
    // instead of nesting under `content`, lift them in. This is a
    // common mistake because the tool description mentions these
    // fields by name. Without this fallback, the patch is empty {}
    // and the write is a silent no-op.
    const TOP_LEVEL_FIELDS = ['text', 'color', 'url', 'fileName', 'mimeType', 'source', 'target', 'routingMode', 'label', 'waypoints', 'curveMidpointOffset', 'curveControlOffsets', 'linkType', 'targetId', 'title', 'description', 'expanded', 'expandedSize'] as const;
    if (Object.keys(content).length === 0) {
      const lifted: Record<string, unknown> = {};
      for (const field of TOP_LEVEL_FIELDS) {
        if (input[field] !== undefined) {
          lifted[field] = input[field];
        }
      }
      if (Object.keys(lifted).length > 0) {
        content = lifted;
      }
    }

    const normalizeEndpoint = (value: unknown): unknown => {
      if (typeof value === 'string' && value) return { nodeId: value, anchorId: 'center' };
      if (!value || typeof value !== 'object') return value;
      const endpoint = value as Record<string, unknown>;
      if (typeof endpoint.nodeId === 'string' && !endpoint.kind && !endpoint.anchorId) {
        return { ...endpoint, anchorId: 'center' };
      }
      return endpoint;
    };
    if (content.source !== undefined || content.target !== undefined) {
      content = {
        ...content,
        ...(content.source !== undefined ? { source: normalizeEndpoint(content.source) } : {}),
        ...(content.target !== undefined ? { target: normalizeEndpoint(content.target) } : {}),
      };
    }

    // element.update_content merges the patch into the existing
    // config record — non-supplied fields are preserved. Use this
    // instead of element.update (which replaces config wholesale).
    // For widget/dynamic, sourceCode (if provided) updates the
    // widget's HTML/SVG so the agent can revise it after creation.
    const widgetSourceCode = typeof input.sourceCode === 'string' ? input.sourceCode : undefined;
    const response = await ipcRequest(context, 'element.update_content', {
      canvasId,
      elementId,
      config: content,
      ...(widgetSourceCode !== undefined ? { sourceCode: widgetSourceCode } : {}),
    });

    return {
      id: crypto.randomUUID(),
      name: TOOL_NAME,
      result: JSON.stringify(response),
      error: !response.success,
    };
  },
};
