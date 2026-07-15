/**
 * canvas_style_element tool.
 *
 * Changes the visual style of an existing canvas element. Style fields
 * are element-kind specific and live inside the element's `config`:
 *   - native/sticky:    { color: 'yellow'|'blue'|'green'|'pink'|'purple'|'gray', fontSize?: number }
 *   - native/connector: { color, strokeStyle, startMarker, endMarker }
 *   - native/image:     { borderRadius?: number, opacity?: number }
 *
 * This tool writes into the element's `config` via the merge-patch
 * action `element.update_content`, so non-supplied fields are
 * preserved. The canvasId is injected via ToolUseContext.conductorCanvasId.
 */

import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { getCanvasId, ipcRequest, noCanvasIdResult, noContextResult } from './ipc-request.js';
import { resolveElementId } from './resolve-element-id.js';
import { isMutationFresh, staleStateResult } from './freshness.js';

export const TOOL_NAME = 'canvas_style_element';

export const definition: Tool = {
  name: TOOL_NAME,
  description:
    'Change the visual style of an existing canvas element. ' +
    'Style fields are element-kind specific:\n' +
    '  - native/sticky: { color, fontSize? } — color ∈ yellow|blue|green|pink|purple|gray; use 20-24px (compact labels render at 20px minimum, longer notes at 18px minimum)\n' +
    '  - native/connector: { color?, strokeStyle?, startMarker?, endMarker? } — strokeStyle = solid|dashed|dotted; markers = none|arrow|open-arrow|circle|diamond|bar\n' +
    '  - native/image: { borderRadius?, opacity? }\n\n' +
    'Only the supplied fields are overwritten; other config fields (text, url, etc.) are preserved. ' +
    'Use canvas_fill_content for content changes (sticky text, image url, file name).',
  input_schema: {
    type: 'object',
    properties: {
      elementId: {
        type: 'string',
        description: 'The ID of the element to restyle. Obtain from canvas_list_elements, or use a ref from a canvas_batch_create you just made in this turn.',
      },
      ref: {
        type: 'string',
        description: 'Semantic ref name from a previous canvas_batch_create. Use this or elementId.',
      },
      style: {
        type: 'object',
        description:
          'Visual style fields to write into the element config. ' +
          'Only supplied fields are overwritten; other config fields are preserved.',
        additionalProperties: true,
      },
    },
    required: ['style'],
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
    const style = (input.style as Record<string, unknown>) ?? {};

    // element.update_content merges the patch into the existing
    // config record — content fields (text, url, etc.) are preserved.
    const response = await ipcRequest(context, 'element.update_content', {
      canvasId,
      elementId,
      config: style,
    });

    return {
      id: crypto.randomUUID(),
      name: TOOL_NAME,
      result: JSON.stringify(response),
      error: !response.success,
    };
  },
};
