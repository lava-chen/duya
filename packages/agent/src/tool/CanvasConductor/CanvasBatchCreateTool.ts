/**
 * canvas_batch_create tool.
 *
 * Creates multiple elements and connectors in a single call. Use
 * bindings (ref names) to reference previously-created elements
 * within the same batch — this is the recommended way to create
 * flowcharts, mind maps, and any multi-element layout. Each
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

export const TOOL_NAME = 'canvas_batch_create';

export const definition: Tool = {
  name: TOOL_NAME,
  description:
    'Create multiple elements and connectors in a single call. This is the PREFERRED tool for flowcharts, mind maps, and any multi-element layout. ' +
    'Use bindings (ref names) to reference previously-created elements ' +
    'within the same batch. Each operation gets its own elementId; connectors can reference either a ref from ' +
    'this batch or an existing elementId. When the user asks to draw anything with multiple parts, call this tool immediately. ' +
    'ALWAYS provide position.w and position.h for every create operation; do not omit sizes. ' +
    'Choose based on content: short label 3x2, standard sticky 4x3, detailed card 5x4 (grid units, 1 unit = 80px).',
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
                'short label 3x2, standard sticky 4x3, detailed card 5x4. ' +
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
          routingMode: 'bezier',
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

    // Populate refMap so later tools can reference elements by semantic ref names.
    if (context && batchResult?.diff?.elements) {
      if (!context.refMap) {
        context.refMap = new Map<string, string>();
      }
      for (const el of batchResult.diff.elements) {
        if (el.ref && el.id) {
          context.refMap.set(el.ref, el.id);
        }
      }
    }

    // Track widget/dynamic style signatures for anti-slop diversity nudging.
    if (response.success && context) {
      for (const raw of operations) {
        const op = raw as Record<string, unknown>;
        if (op.op === 'create' && op.kind === 'widget/dynamic' && typeof op.sourceCode === 'string') {
          const signature = extractWidgetStyleSignature(op.sourceCode);
          context.widgetStyleHistory = appendWidgetStyleSignature(context.widgetStyleHistory, signature);
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

If you find issues, describe them concisely with element IDs if visible, and suggest specific fixes (e.g. "move elem_X 2 units right"). If everything looks good, say "Looks good — no obvious issues."`;

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
