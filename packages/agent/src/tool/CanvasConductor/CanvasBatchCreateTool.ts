/**
 * canvas_batch_create tool.
 *
 * Creates multiple elements and connectors in a single call. Use
 * bindings (ref names) to reference previously-created elements
 * within the same batch — this is the recommended way to create
 * editable workbench layouts and native-node mind maps. Each
 * operation gets its own elementId; connectors can reference either
 * a ref from this batch or an existing elementId.
 *
 * The canvasId is injected via ToolUseContext.conductorCanvasId —
 * the LLM never needs to track canvas state. Returns the list of
 * created elementIds (with their ref names) so the model can chain
 * fill/style calls.
 */

import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { getCanvasId, ipcRequest, noCanvasIdResult, noContextResult } from './ipc-request.js';
import { formatValidationErrors, validateElementInput, validateConnectorShape } from './validate.js';
import { appendWidgetStyleSignature, extractWidgetStyleSignature } from './style-signature.js';
import { trackCreatedElement } from './freshness.js';

export const TOOL_NAME = 'canvas_batch_create';

export const definition: Tool = {
  name: TOOL_NAME,
  description:
    'Create multiple independently editable elements and connectors in a single call. Use it for workbench layouts and native-node mind maps. ' +
    'For a finished explanatory flowchart or diagram meant to be viewed as one composition, create ONE widget/dynamic instead. ' +
    'Use bindings (ref names) to reference previously-created elements ' +
    'within the same batch. Each operation gets its own elementId; connectors can reference either a ref from ' +
    'this batch or an existing elementId. Call this immediately for editable multi-part workbench content; do not use it for a finished single-composition diagram. ' +
    'ALWAYS provide position.w and position.h for every create operation; do not omit sizes. ' +
    'Fractional sizes are valid. Choose based on content: compact label 2.5x1, short line 3x1, two lines 3.5x1.5, standard note 4x2. ' +
    'Use 0.5-0.75 unit gaps for related mind-map nodes and fontSize 20-24px; never spread a short-label map across the full 40x30 canvas.',
  input_schema: {
    type: 'object',
    properties: {
      operations: {
        type: 'array',
        description:
          'Ordered list of create operations. Processed top-to-bottom. ' +
          'Use ref to name an element so later operations (especially ' +
          'connectors) can reference it.',
        items: {
          type: 'object',
          properties: {
            op: {
              type: 'string',
              enum: ['create', 'connect'],
              description:
                "'create' for elements (sticky/image/file/widget), 'connect' for connectors",
            },
            ref: {
              type: 'string',
              description:
                'Optional binding name for this operation. Later operations ' +
                'can use this name in source/target fields to reference the ' +
                'element created here.',
            },
            kind: {
              type: 'string',
              description:
                'Element kind (for op=create). E.g. native/sticky, native/image, ' +
                'native/file, widget/dynamic.',
            },
            position: {
              type: 'object',
              description:
                'Element position in grid units (for op=create). 1 unit = 80px. ' +
                'Required: x, y, w, h. Always set w and h. Choose size based on content: ' +
                'compact label 2.5x1, short line 3x1, two lines 3.5x1.5, standard note 4x2. ' +
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
                'Element config (for op=create). Kind-specific. Optional — ' +
                'can be set later via canvas_fill_content.',
              additionalProperties: true,
            },
            sourceCode: {
              type: 'string',
              description: 'HTML/SVG string for widget/dynamic kind. Required when kind="widget/dynamic".',
            },
            source: {
              type: 'string',
              description:
                'Connector source (for op=connect). Can be a ref name from ' +
                'this batch or an existing elementId.',
            },
            target: {
              type: 'string',
              description:
                'Connector target (for op=connect). Can be a ref name from ' +
                'this batch or an existing elementId.',
            },
            routingMode: {
              type: 'string',
              enum: ['elbow', 'curve'],
              description: 'Connector route (for op=connect). Elbow is best for process flows; curve for associations.',
            },
            label: {
              type: 'string',
              description: 'Optional text shown on the connector.',
            },
            strokeStyle: {
              type: 'string',
              enum: ['solid', 'dashed', 'dotted'],
            },
            color: { type: 'string' },
            startMarker: { type: 'string', enum: ['none', 'arrow', 'open-arrow', 'circle', 'diamond', 'bar'] },
            endMarker: { type: 'string', enum: ['none', 'arrow', 'open-arrow', 'circle', 'diamond', 'bar'] },
          },
          required: ['op'],
        },
      },
    },
    required: ['operations'],
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

    const operations = (input.operations as unknown[]) ?? [];

    if (!Array.isArray(operations) || operations.length === 0) {
      return {
        id: crypto.randomUUID(),
        name: TOOL_NAME,
        result: JSON.stringify({
          success: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'operations must be a non-empty array',
          },
        }),
        error: true,
      };
    }

    // Fast-fail: validate each operation before paying for an IPC round-trip.
    for (const [i, raw] of operations.entries()) {
      const op = raw as Record<string, unknown>;
      const opType = op.op as string;
      if (opType === 'create') {
        const kind = op.kind as string;
        const position = (op.position as Record<string, unknown>) ?? {};
        const config = (op.config as Record<string, unknown> | undefined) ?? {};
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
        if (kind === 'widget/dynamic' && !op.sourceCode) {
          return {
            id: crypto.randomUUID(),
            name: TOOL_NAME,
            result: JSON.stringify({
              success: false,
              error: {
                code: 'INVALID_INPUT',
                message: `operation[${i}]: sourceCode required for widget/dynamic`,
              },
            }),
            error: true,
          };
        }
      } else if (opType === 'connect') {
        const config = {
          source: op.source,
          target: op.target,
          curvature: op.curvature,
          routingMode: op.routingMode ?? 'elbow',
          label: op.label,
          strokeStyle: op.strokeStyle,
          color: op.color,
          startMarker: op.startMarker,
          endMarker: op.endMarker,
          style: op.style,
        };
        const validation = validateConnectorShape(config);
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
      }
    }

    const response = await ipcRequest(context, 'element.batch_create', {
      canvasId,
      operations,
    });

    // Worker wraps the executor result as { success, data: result }. Read
    // `data` (not `result`) to access the batch diff and element refs.
    const batchResult = response.success
      ? (response as unknown as { data?: { diff?: { elements?: Array<{ ref?: string; id?: string }> } } }).data
      : undefined;

    // Populate the shared refMap so later tools can reference elements by
    // semantic ref names. Also track all created element IDs so subsequent
    // fill/style/move calls bypass the STALE_STATE check without forcing
    // another canvas_list_elements. Both writes target the stable
    // canvasFreshness container (spread-safe), NOT the context directly.
    const freshness = context?.canvasFreshness;
    if (context && freshness && batchResult?.diff?.elements) {
      for (const el of batchResult.diff.elements) {
        if (el.ref && el.id) {
          freshness.refMap.set(el.ref, el.id);
        }
        if (el.id) {
          trackCreatedElement(context, el.id);
        }
      }
    }

    // Track widget/dynamic style signatures for anti-slop diversity nudging.
    // Mutate the shared array in place (see CanvasCreateElementTool for why).
    if (response.success && context?.widgetStyleHistory) {
      for (const raw of operations) {
        const op = raw as Record<string, unknown>;
        if (op.op === 'create' && op.kind === 'widget/dynamic' && typeof op.sourceCode === 'string') {
          const signature = extractWidgetStyleSignature(op.sourceCode);
          appendWidgetStyleSignature(context.widgetStyleHistory, signature);
        }
      }
    }

    const mainResult: ToolResult = {
      id: crypto.randomUUID(),
      name: TOOL_NAME,
      result: JSON.stringify(response),
      error: !response.success,
    };

    // Only run visual self-review for successful batch creates with multiple elements
    const createdCount = Array.isArray(batchResult?.diff?.elements) ? batchResult.diff.elements.length : 0;
    if (createdCount >= 2 && context?.options?.analyzeImage) {
      mainResult.pendingExtraResult = runBatchCreateVisualReview(context, canvasId);
    }

    return mainResult;
  },
};

async function runBatchCreateVisualReview(
  context: ToolUseContext,
  canvasId: string,
): Promise<{ result: string; is_error?: boolean }> {
  try {
    // 1. Capture viewport screenshot
    const captureResponse = await ipcRequest(
      context,
      'canvas.capture',
      { canvasId, scope: 'viewport' },
      { timeout: 30000 },
    );

    if (!captureResponse.success) {
      return { result: 'Visual review skipped: capture failed.' };
    }

    // Worker wraps the executor result as { success, data: result }.
    const captureResult = (
      captureResponse as unknown as {
        data?: { filePath?: string; width?: number; height?: number };
      }
    ).data;
    const filePath = captureResult?.filePath;
    if (!filePath) {
      return { result: 'Visual review skipped: no file path in capture result.' };
    }

    // 2. Read file as base64 for vision model
    const { readFileSync } = await import('node:fs');
    const buffer = readFileSync(filePath);
    const base64 = buffer.toString('base64');
    const mimeType = filePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

    // 3. Analyze with vision model
    const analyzeImage = context.options.analyzeImage;
    if (typeof analyzeImage !== 'function') {
      return { result: 'Visual review skipped: no vision model configured.' };
    }

    const prompt = `You are reviewing a canvas layout that YOU just generated. Check for these issues:
1. Overlapping elements (critical)
2. Elements extending beyond canvas edges (critical)
3. Poor alignment or uneven spacing (warning)
4. Connectors that don't clearly link their source/target (warning)
5. Text that is too small to read at the captured viewport scale (critical)
6. Nodes with excessive empty padding or a layout spread much wider/taller than its content needs (warning)

If you find issues, describe them concisely with element IDs if visible, and suggest specific fixes (e.g. "resize elem_X to 2.5x1 and set fontSize 22" or "move elem_X 0.5 units left"). If everything looks good, say "Looks good — readable, compact, and no obvious issues."`;

    const review = await analyzeImage(base64, mimeType, prompt);

    return {
      result: `Visual review:\n${review}\n\nIf issues are reported, use canvas_move_element / canvas_resize_element to fix them.`,
    };
  } catch (err) {
    return {
      result: `Visual review skipped: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
