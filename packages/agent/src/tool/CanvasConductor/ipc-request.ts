/**
 * Shared IPC request helper for canvas conductor tools.
 *
 * Routes tool calls through the `conductor:executor:rpc` channel
 * (handled by ConductorExecutorProxy in the main process). The
 * canvasId is injected via ToolUseContext.conductorCanvasId and
 * never appears in the LLM-facing tool input schema.
 */

import type { ToolUseContext } from '../../types.js';

interface IpcRequestOptions {
  timeout?: number;
  /** Number of retry attempts for transient failures. Default: 2. */
  retries?: number;
}

/** Transient error codes that warrant a retry. */
const RETRYABLE_ERRORS = new Set([
  'IPC_TIMEOUT',
  'INTERNAL',
  'CAPTURE_NOT_READY',
  'NO_IPC',
]);

const RETRY_DELAY_MS = 200;

export interface IpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

export async function ipcRequest<T = unknown>(
  context: ToolUseContext,
  action: string,
  payload: unknown,
  options?: IpcRequestOptions,
): Promise<IpcResponse<T>> {
  if (!context?.ipcRequest) {
    return { success: false, error: { code: 'NO_IPC', message: 'IPC not available' } };
  }

  const maxRetries = options?.retries ?? 2;
  let lastError: { code: string; message: string } | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await context.ipcRequest<T>(
        'conductor:executor:rpc',
        { action, payload },
        options,
      );

      if (response.success) {
        return response;
      }

      const errorCode = response.error?.code || 'UNKNOWN';
      if (!RETRYABLE_ERRORS.has(errorCode)) {
        return response;
      }

      lastError = response.error ?? { code: errorCode, message: 'Unknown error' };

      if (attempt === maxRetries) {
        return response;
      }

      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * Math.pow(2, attempt)));
    } catch (err) {
      lastError = {
        code: 'IPC_EXCEPTION',
        message: err instanceof Error ? err.message : String(err),
      };

      if (attempt === maxRetries) {
        return { success: false, error: lastError };
      }

      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * Math.pow(2, attempt)));
    }
  }

  return {
    success: false,
    error: lastError ?? { code: 'EXHAUSTED', message: 'Retries exhausted' },
  };
}

/**
 * Resolve the bound canvas ID from the tool execution context.
 * Throws if conductor mode is not active (canvasId missing).
 */
export function getCanvasId(context: ToolUseContext): string {
  const id = context.conductorCanvasId;
  if (!id) {
    throw new Error(
      'Canvas conductor tool invoked without a bound canvasId. ' +
        'Ensure conductorMode=true and conductorCanvasId are set in ChatOptions.',
    );
  }
  return id;
}

/** Standard "no context" tool result used when context is missing. */
export function noContextResult(toolName: string): { id: string; name: string; result: string; error: true } {
  return {
    id: crypto.randomUUID(),
    name: toolName,
    result: JSON.stringify({
      success: false,
      error: { code: 'NO_CONTEXT', message: 'Tool execution context not available' },
    }),
    error: true,
  };
}

/** Standard "canvasId missing" tool result. */
export function noCanvasIdResult(toolName: string): { id: string; name: string; result: string; error: true } {
  return {
    id: crypto.randomUUID(),
    name: toolName,
    result: JSON.stringify({
      success: false,
      error: {
        code: 'NO_CANVAS_ID',
        message: 'Canvas ID not bound to this session. Enable conductor mode first.',
      },
    }),
    error: true,
  };
}
