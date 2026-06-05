/**
 * capability-management-ipc.ts
 *
 * Plan 83b Phase 1A — typed renderer-side wrapper for the
 * `capability-management:snapshot` IPC channel.
 */

import type { CapabilityManagementSnapshot } from './capability-management-types';

interface CapabilityManagementIpcSuccess {
  success: true;
  data: CapabilityManagementSnapshot;
}

interface CapabilityManagementIpcError {
  success: false;
  error: string;
}

export type CapabilityManagementIpcResult =
  | CapabilityManagementIpcSuccess
  | CapabilityManagementIpcError;

export interface CapabilityManagementAPI {
  snapshot: () => Promise<CapabilityManagementIpcResult>;
}

function getApi(): CapabilityManagementAPI | null {
  if (typeof window === 'undefined') return null;
  const api = (window as unknown as { electronAPI?: { capabilityManagement?: CapabilityManagementAPI } })
    .electronAPI?.capabilityManagement;
  return api ?? null;
}

export async function fetchCapabilityManagementSnapshot(): Promise<CapabilityManagementSnapshot | null> {
  const api = getApi();
  if (!api) return null;
  const result = await api.snapshot();
  if (!result.success) {
    throw new Error(result.error || 'capability-management snapshot failed');
  }
  return result.data;
}

export function hasCapabilityManagementAPI(): boolean {
  return getApi() !== null;
}
