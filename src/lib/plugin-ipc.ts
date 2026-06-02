/**
 * Plugin IPC client — Renderer-side wrapper for plugin IPC handlers.
 */

import type {
  PluginCatalogEntry,
  PluginRegistryEntry,
  PluginHealthReport,
  PluginIpcListResponse,
  PluginIpcDetailResponse,
  CapabilityIndexItem,
} from './plugin-types';

interface PluginCatalogFilters {
  search?: string;
  category?: string;
  source?: string;
  installed?: boolean;
}

export function getPluginAPI() {
  const api = window.electronAPI;
  if (!api) {
    return null;
  }

  return {
    catalog: {
      list: async (filters?: PluginCatalogFilters): Promise<PluginIpcListResponse<PluginCatalogEntry>> => {
        return api.plugin.catalog.list(filters) as Promise<PluginIpcListResponse<PluginCatalogEntry>>;
      },
    },
    registry: {
      list: async (): Promise<PluginIpcListResponse<PluginRegistryEntry>> => {
        return api.plugin.registry.list() as Promise<PluginIpcListResponse<PluginRegistryEntry>>;
      },
      install: async (payload: { pluginId: string }): Promise<{ success: boolean; data?: PluginRegistryEntry; error?: string }> => {
        return api.plugin.install(payload) as unknown as Promise<{ success: boolean; data?: PluginRegistryEntry; error?: string }>;
      },
      installLocal: async (payload: { pluginPath: string; scope?: string; autoUpdate?: boolean }): Promise<{ success: boolean; data?: PluginRegistryEntry; error?: string }> => {
        return (api.plugin as any).installLocal(payload) as Promise<{ success: boolean; data?: PluginRegistryEntry; error?: string }>;
      },
      mcpList: async (): Promise<{ success: boolean; data: Array<{ pluginId: string; pluginName: string; name: string; command: string; args?: string[]; env?: Record<string, string> }>; error?: string }> => {
        return (api.plugin as any).mcpList() as Promise<{ success: boolean; data: Array<{ pluginId: string; pluginName: string; name: string; command: string; args?: string[]; env?: Record<string, string> }>; error?: string }>;
      },
      enable: async (pluginId: string): Promise<{ success: boolean; data?: PluginRegistryEntry; error?: string }> => {
        return api.plugin.enable(pluginId) as unknown as Promise<{ success: boolean; data?: PluginRegistryEntry; error?: string }>;
      },
      disable: async (pluginId: string): Promise<{ success: boolean; data?: PluginRegistryEntry; error?: string }> => {
        return api.plugin.disable(pluginId) as unknown as Promise<{ success: boolean; data?: PluginRegistryEntry; error?: string }>;
      },
      remove: async (payload: { pluginId: string; deleteData?: boolean }): Promise<{ success: boolean; data?: { removed: boolean }; error?: string }> => {
        return api.plugin.remove(payload) as unknown as Promise<{ success: boolean; data?: { removed: boolean }; error?: string }>;
      },
    },
    detail: {
      get: async (pluginId: string): Promise<PluginIpcDetailResponse<PluginCatalogEntry>> => {
        return api.plugin.detail.get(pluginId) as Promise<PluginIpcDetailResponse<PluginCatalogEntry>>;
      },
    },
    health: {
      list: async (): Promise<PluginIpcListResponse<PluginHealthReport>> => {
        return api.plugin.health.list() as unknown as Promise<PluginIpcListResponse<PluginHealthReport>>;
      },
    },
    doctor: async (pluginId?: string): Promise<PluginIpcListResponse<PluginHealthReport>> => {
      return api.plugin.doctor(pluginId) as unknown as Promise<PluginIpcListResponse<PluginHealthReport>>;
    },
    capabilityIndex: async (): Promise<PluginIpcListResponse<CapabilityIndexItem>> => {
      return api.plugin.capabilityIndex() as unknown as Promise<PluginIpcListResponse<CapabilityIndexItem>>;
    },
  };
}