/**
 * canvas_fill_content tool.
 *
 * Fills or updates the content of an existing canvas element.
 * Content fields are element-kind specific:
 *   - native/sticky:    { text: string, color?: string }
 *   - native/image:     { url: string, fileName?: string }
 *   - native/file:      { fileName: string, mimeType?: string, url?: string }
 *   - native/connector: { source: string, target: string }
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
    'Fill or update the content of an existing canvas element. ' +
    'Content fields depend on element kind:\n' +
    '  - native/sticky: { text, color? }\n' +
    '  - native/image: { url, fileName? }\n' +
    '  - native/file: { fileName, mimeType?, url? }\n' +
    '  - native/connector: { source, target, routingMode?, label?, waypoints?, curveControlOffsets? }\n' +
    '  - native/link: { linkType: "url"|"session"|"canvas", url?, targetId?, title?, description?, expanded?, expandedSize? }\n' +
    '  - widget/dynamic: pass sourceCode (top-level) to revise the HTML/SVG\n\n' +
    'Only the supplied fields are overwritten; other config fields are preserved. ' +
    'Use canvas_style_element for visual style changes (color, fontSize, stroke).',
  input_schema: {
    type: 'object',
    properties: {
      elementId: {
        type: 'string',
        description: 'The ID of the element to fill. Obtain from canvas_list_elements, or use a ref from a canvas_batch_create you just made in this turn.',
      },
      ref: {
        type: 'string',
        description: 'Semantic ref name from a previous canvas_batch_create. Use this or elementId.',
      },
      content: {
        type: 'object',
        description:
          'Content fields to write into the element config. ' +
          'Only supplied fields are overwritten; other config fields are preserved. ' +
          'For native/sticky, put { text, color } HERE — not at the top level.',
        properties: {
          text: {
            type: 'string',
            description: 'native/sticky: the text content of the note.',
          },
          color: {
            type: 'string',
            description:
              'native/sticky: note color. One of: yellow, blue, green, pink, purple, gray. See packages/agent/skills/agentic/conductor-canvas-control/SKILL.md for hex mapping (pink renders as light red, .s-err).',
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
            type: 'string',
            description: 'native/connector: source element id.',
          },
          target: {
            type: 'string',
            description: 'native/connector: target element id.',
          },
        },
        additionalProperties: true,
      },
      sourceCode: {
        type: 'string',
        description:
          'New HTML/SVG source for widget/dynamic elements. Use this to revise a widget after creation ' +
          '(e.g. fix layout, change data display, add sections). Ignored for non-widget kinds.',
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
    const resolved = resolveElementId(
      { elementId: input.elementId as string | undefined, ref: input.ref as string | undefined },
      context,
    );
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
    const TOP_LEVEL_FIELDS = ['text', 'color', 'url', 'fileName', 'mimeType', 'source', 'target', 'routingMode', 'label', 'waypoints', 'curveControlOffsets', 'linkType', 'targetId', 'title', 'description', 'expanded', 'expandedSize'] as const;
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
