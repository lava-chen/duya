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
  PluginSetupLoadResult,
} from './plugin-types';
import type { WorkflowTemplate } from '@duya/plugin-core';

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
    // Plan 311 — fetch the full workflow template (including prompt
    // body) for a given plugin + workflow id. The capability index
    // only ships summaries; the renderer calls this when the user
    // opens the launch dialog.
    workflowGet: async (payload: {
      pluginId: string;
      workflowId: string;
    }): Promise<{ success: boolean; data?: WorkflowTemplate; error?: string }> => {
      return api.plugin.workflowGet(payload) as unknown as Promise<{
        success: boolean;
        data?: WorkflowTemplate;
        error?: string;
      }>;
    },
    mcpTools: async (_serverId: string): Promise<{ success: boolean; data?: Array<{ name: string; description?: string }>; error?: string }> => {
      // The old `mcp:inventory:tools` IPC was removed with the MCP
      // inventory service. Per-server tool listing now lives on the
      // worker side (the connected MCP client); surfacing it through
      // a new worker command is tracked separately. Until then return
      // an empty tool list so the Connectors section renders the
      // server name without error chips.
      return { success: true, data: [] };
    },
    // Plugin setup — load returns field defs + stored values (secrets masked
    // to empty string). Save accepts only the changed fields; the main
    // process merges them on top of existing stored values so unchanged
    // secrets are preserved.
    setupLoad: async (pluginId: string): Promise<{ success: boolean; data?: PluginSetupLoadResult | null; error?: string }> => {
      return api.plugin.setupLoad(pluginId) as Promise<{ success: boolean; data?: PluginSetupLoadResult | null; error?: string }>;
    },
    setupSave: async (payload: { pluginId: string; values: Record<string, string> }): Promise<{ success: boolean; data?: { ok: boolean }; error?: string }> => {
      return api.plugin.setupSave(payload) as Promise<{ success: boolean; data?: { ok: boolean }; error?: string }>;
    },
  };
}