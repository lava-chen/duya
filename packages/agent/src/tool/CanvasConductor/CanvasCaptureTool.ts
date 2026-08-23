/**
 * canvas_capture tool.
 *
 * Captures a screenshot of the current canvas state and saves it to
 * a file. Returns the file path (a short string) instead of an inline
 * base64 data URL, so the agent can pass the path to `vision_analyze`
 * without burning tokens on the encoded image. The canvasId is
 * injected via ToolUseContext.conductorCanvasId.
 */

import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { getCanvasId, ipcRequest, noCanvasIdResult, noContextResult } from './ipc-request.js';

export const TOOL_NAME = 'canvas_capture';

export const definition: Tool = {
  name: TOOL_NAME,
  description:
    'Capture a screenshot of a canvas area and save it to a file.\n\n' +
    'Returns: { filePath, width, height, scope, capturedAt }\n\n' +
    'To analyze the screenshot visually, pass the `filePath` to the `vision_analyze` tool:\n' +
    '  vision_analyze({ image_path: "<filePath>", question: "check layout/overlap/alignment" })\n\n' +
    'Use ONLY when visual judgment is needed:\n' +
    '  - Verifying alignment, spacing, or overlap after layout changes\n' +
    '  - When the user asks "how does it look"\n' +
    '  - After major rearrangement\n\n' +
    'Do NOT use to read text content (use canvas_list_elements instead).\n' +
    'Token cost is significant — limit to once per 5 turns.\n\n' +
    'The `region` parameter (scope="region") uses the SAME canvas ' +
    'coordinates you use when creating elements: grid units by default ' +
    '(1 unit = 80px; the canvas is 40 x 30 grid units), matching the ' +
    '`position.x/y/w/h` of canvas_create_element. If you know where you ' +
    'placed an element, capture exactly that place — e.g. an element at ' +
    'position {x: 26, y: 22, w: 6, h: 4} can be captured with region ' +
    '{x: 26, y: 22, w: 6, h: 4}.\n\n' +
    'You do NOT need the area to be currently visible on screen: the ' +
    'renderer temporarily pans/zooms the view to frame the requested ' +
    'rectangle, captures it, then restores the previous view. Regions ' +
    'larger than what fits on screen are captured down to their visible ' +
    'intersection — check the returned width/height to know what you got.\n\n' +
    'If the canvas is still loading (the StartupLanding boot overlay is ' +
    'still visible, or the renderer has not yet mounted `.canvas-area`), ' +
    'the tool returns an error rather than a file. Retry after the canvas ' +
    'is visibly rendered.',
  input_schema: {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        enum: ['viewport', 'element', 'region'],
        description:
          'Capture scope: viewport (what is visible now), element (single ' +
          'element by ID), or region (rectangle in canvas coordinates). ' +
          'Default: viewport.',
        default: 'viewport',
      },
      elementId: {
        type: 'string',
        description: 'When scope is "element", the element ID to capture.',
      },
      region: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          w: { type: 'number' },
          h: { type: 'number' },
          unit: {
            type: 'string',
            enum: ['grid', 'px'],
            description:
              "Coordinate unit for x/y/w/h. Default 'grid': the same " +
              'canvas grid units canvas_create_element uses for position ' +
              "(1 unit = 80px). Use 'px' only when you have raw canvas " +
              'pixel coordinates.',
            default: 'grid',
          },
        },
        required: ['x', 'y', 'w', 'h'],
        description:
          'When scope is "region", the rectangle in CANVAS coordinates ' +
          '(grid units unless unit="px") — the same coordinate space as ' +
          'element positions. The rectangle does not need to be inside ' +
          'the currently visible viewport; the view is reframed ' +
          'automatically. w/h must be positive.',
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

    const scope = (input.scope as string) || 'viewport';
    const elementId = input.elementId as string | undefined;
    const region = input.region as
      | { x: number; y: number; w: number; h: number; unit?: 'grid' | 'px' }
      | undefined;

    // html2canvas can be slow on large canvases — extend the timeout.
    const response = await ipcRequest(
      context,
      'canvas.capture',
      { canvasId, scope, elementId, region },
      { timeout: 30000 },
    );

    // Worker wraps the executor result as { success, data: result }. Read
    // `data` (not `result`). The main process saves the screenshot to a
    // file and returns { filePath, width, height, scope, capturedAt }.
    const capturePayload = response.success
      ? (response as unknown as {
          data?: {
            filePath: string;
            width: number;
            height: number;
            scope: string;
            capturedAt: string;
          };
        }).data
      : undefined;

    const trimmedResult = capturePayload
      ? {
          filePath: capturePayload.filePath,
          width: capturePayload.width,
          height: capturePayload.height,
          scope: capturePayload.scope,
          capturedAt: capturePayload.capturedAt,
        }
      : null;

    return {
      id: crypto.randomUUID(),
      name: TOOL_NAME,
      result: JSON.stringify({
        success: response.success,
        ...(trimmedResult ? { result: trimmedResult } : {}),
        ...(!response.success ? { error: response.error } : {}),
      }),
      error: !response.success,
    };
  },
};
