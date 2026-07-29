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
    'Change the VISUAL STYLE of an existing canvas element (NOT its content or position). ' +
    'This is a merge-patch: only the fields you supply are overwritten; other config fields are preserved. ' +
    'The canvasId is injected automatically — never pass it.\n\n' +
    '## PRE-FLIGHT CHECKLIST\n' +
    '1. Call canvas_list_elements (or canvas_get_context) first, OR operate on an element you created via ' +
    'canvas_create_element in THIS session. Without one of these, the call is REJECTED with STALE_STATE. ' +
    '2. Have the elementId ready — from canvas_list_elements or from a recent canvas_create_element result.\n\n' +
    '## Parameter shape\n' +
    '  - elementId: TOP-LEVEL field.\n' +
    '  - style:     NESTED object containing the visual style fields. Example: { elementId: "abc", style: { color: "pink" } }.\n' +
    'Do NOT pass `position` here — use canvas_move_element / canvas_resize_element for that.\n' +
    'Do NOT pass content fields here — use canvas_fill_content for text/markdown/url/source/target/etc.\n\n' +
    '## Style fields per element kind (placed inside `style`)\n' +
    '  - native/shape, native/sticky: { color?, fontSize? } ' +
    '— color MUST be an enum key (yellow|blue|green|pink|purple|gray); hex strings are REJECTED. ' +
    'pink renders as light red (error/warning semantic). ' +
    'fontSize: use 20-24 (compact labels render at 20px min, longer notes at 18px min; values <18 are clamped to 18).\n' +
    '  - native/connector: { color?, labelFontSize?:14..22, strokeStyle?, startMarker?, endMarker? } ' +
    '— color is a hex string here (e.g. "#3B82F6") — DIFFERENT from native/shape which uses enum keys. ' +
    'strokeStyle = solid|dashed|bold|dotted. ' +
    'markers = none|arrow|open-arrow|circle|diamond|bar. ' +
    'Call canvas_get_knowledge("connector-style") for the color → meaning table (e.g. #EF4444 = error branch).\n' +
    '  - native/image: { borderRadius?, opacity? } — opacity ∈ 0..1, borderRadius is a non-negative number.\n\n' +
    '## Common pitfalls\n' +
    '  - Putting color/fontSize at the top level of the tool input — wrap them inside `style`.\n' +
    '  - Using hex colors for native/shape color — use enum keys (yellow/blue/green/pink/purple/gray). ' +
    '  Note: native/connector color IS a hex string — different rule from native/shape.\n' +
    '  - Forgetting STALE_STATE — call canvas_list_elements (or canvas_get_context) first when in doubt.\n\n' +
    '## Worked example\n' +
    '{"elementId":"<id>","style":{"color":"pink","fontSize":22}}',
  input_schema: {
    type: 'object',
    properties: {
      elementId: {
        type: 'string',
        description: 'The ID of the element to restyle. Obtain it from canvas_list_elements or from canvas_create_element in this turn.',
      },
      style: {
        type: 'object',
        description:
          'NESTED object — visual style fields placed INSIDE this object (NOT at the top level of the tool input). ' +
          'Merge-patch: only supplied fields are overwritten; content/position fields are preserved. ' +
          'For native/shape color use enum keys (yellow/blue/green/pink/purple/gray). ' +
          'For native/connector color use hex strings ("#RRGGBB").',
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
