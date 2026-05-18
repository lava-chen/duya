import {
  type SidecarMessage,
  type CapabilityMessage,
  type JsonRpcRequest,
} from './types';

export function createParseRequest(id: number, filePath: string): JsonRpcRequest {
  return {
    jsonrpc: '2.0' as const,
    id,
    method: 'parse',
    params: { path: filePath },
  };
}

export function isCapabilityMessage(msg: Record<string, unknown>): boolean {
  return 'type' in msg && msg.type === 'capabilities';
}

export function hasId(msg: Record<string, unknown>): boolean {
  return 'id' in msg && typeof msg.id === 'number';
}

export function isJsonRpcError(msg: Record<string, unknown>): msg is Record<string, unknown> & { error: { code: number; message: string } } {
  return 'error' in msg;
}

export function isJsonRpcDone(msg: Record<string, unknown>): boolean {
  return 'result' in msg && msg.result !== null && typeof msg.result === 'object' && 'status' in msg.result;
}

export interface StdoutHandlers {
  onCapability: (msg: CapabilityMessage) => void;
  onResponse: (msg: SidecarMessage) => void;
  onParseError: (raw: string) => void;
  onLog: (message: string, level: 'warn' | 'error') => void;
}

export function processSidecarData(data: string, buffer: string, handlers: StdoutHandlers): string {
  const combined = buffer + data;
  const lines = combined.split('\n');
  const remaining = lines.pop() || '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const msg: Record<string, unknown> = JSON.parse(trimmed);

      if (isCapabilityMessage(msg)) {
        handlers.onCapability(msg as unknown as CapabilityMessage);
      } else if (hasId(msg)) {
        handlers.onResponse(msg as unknown as SidecarMessage);
      }
    } catch {
      handlers.onParseError(trimmed.substring(0, 200));
    }
  }

  return remaining;
}
