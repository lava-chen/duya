import type { MCPInventorySnapshotDTO } from './mcp-inventory-types';

interface MCPInventoryIpcSuccess {
  success: true;
  data: MCPInventorySnapshotDTO;
}

interface MCPInventoryIpcError {
  success: false;
  error: string;
}

export type MCPInventoryIpcResult = MCPInventoryIpcSuccess | MCPInventoryIpcError;

export interface MCPInventoryAPI {
  snapshot: () => Promise<MCPInventoryIpcResult>;
}

function getApi(): MCPInventoryAPI | null {
  if (typeof window === 'undefined') return null;
  const api = (window as unknown as {
    electronAPI?: {
      mcpInventory?: MCPInventoryAPI;
    };
  }).electronAPI?.mcpInventory;
  return api ?? null;
}

export async function fetchMCPInventorySnapshot(): Promise<MCPInventorySnapshotDTO | null> {
  const api = getApi();
  if (!api) return null;
  const result = await api.snapshot();
  if (!result.success) {
    throw new Error(result.error || 'mcp inventory snapshot failed');
  }
  return result.data;
}

export function hasMCPInventoryAPI(): boolean {
  return getApi() !== null;
}
