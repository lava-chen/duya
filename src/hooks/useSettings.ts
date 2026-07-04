import { useState, useCallback, useEffect } from "react";
import type { AppSettings, MCPServerConfig, VisionLLMConfig } from "@/types";
import { getAllSettingsIPC } from "@/lib/ipc-client";
import { uiPermissionModeToSettings } from "@/lib/permission-mode";

/**
 * Convert raw settings (Record<string, string>) to AppSettings format
 */
function parseAppSettings(raw: Record<string, string>): AppSettings {
  const defaults: AppSettings = {
    apiKey: "",
    baseURL: "",
    defaultModel: "",
    lastSelectedModel: "",
    mcpServers: [],
    permissionMode: "auto",
    sandboxEnabled: true,
    theme: "dark",
    locale: "en",
    provider: "",
    messageFont: "serif",
    skillAdditionalPaths: [],
    skillNudgeInterval: 10,
    summaryLLMConfig: null,
    summaryLLMEnabled: false,
    databasePath: "",
    // Code display settings
    showLineNumbers: true,
    wordWrap: true,
    // Notification settings
    notificationsEnabled: true,
    soundEffectsEnabled: true,
    // Vision model settings
    visionLLMConfig: null,
    visionLLMEnabled: false,
    // Gateway model settings
    gatewayModel: "",
    // Wiki Agent model settings
    wikiAgentModel: undefined,
    // Wiki Agent feature toggle (experimental)
    wikiAgentEnabled: false,
    // Title generation model
    titleGenerationModel: undefined,
    // Appearance settings
    font: undefined,
    compactMode: false,
    messageFontSize: 'medium',
    // Browser security settings
    blockedDomains: [],
    // Favorite agent profiles for quick access (max 3)
    favoriteAgentIds: ['general-purpose', 'code-expert', 'plan'],
    // Agent prompt language preference
    agentLanguage: undefined,
    // Security settings
    securityScanEnabled: true,
    cronPermissionMode: "auto",
    gatewayPermissionMode: "auto",
    // Default workspace directory for creating new projects
    workspaceDir: undefined,
  };

  try {
    // Parse modelSelection as fallback for gateway/title models
    let modelSelection: { gatewayModel?: string; wikiAgentModel?: string; titleGenerationModel?: string; embeddingModel?: string } | null = null;
    if (raw.modelSelection) {
      try {
        modelSelection = JSON.parse(raw.modelSelection);
      } catch {
        modelSelection = null;
      }
    }

    return {
      apiKey: raw.apiKey ?? defaults.apiKey,
      baseURL: raw.baseURL ?? defaults.baseURL,
      defaultModel: raw.defaultModel ?? defaults.defaultModel,
      lastSelectedModel: raw.lastSelectedModel ?? defaults.lastSelectedModel,
      mcpServers: raw.mcpServers ? JSON.parse(raw.mcpServers) : defaults.mcpServers,
      permissionMode: (raw.permissionMode as AppSettings["permissionMode"]) ?? defaults.permissionMode,
      sandboxEnabled: raw.sandboxEnabled === "true",
      theme: (raw.theme as AppSettings["theme"]) ?? defaults.theme,
      locale: (() => {
        const val = raw.locale;
        if (!val) return defaults.locale;
        try { return JSON.parse(val); } catch { return val; }
      })(),
      provider: raw.provider ?? defaults.provider,
      messageFont: (raw.messageFont as AppSettings["messageFont"]) ?? defaults.messageFont,
      skillAdditionalPaths: raw.skillAdditionalPaths
        ? JSON.parse(raw.skillAdditionalPaths)
        : defaults.skillAdditionalPaths,
      skillNudgeInterval: raw.skillNudgeInterval ? parseInt(raw.skillNudgeInterval, 10) : defaults.skillNudgeInterval,
      summaryLLMConfig: raw.summaryLLMConfig && raw.summaryLLMConfig !== "null"
        ? JSON.parse(raw.summaryLLMConfig)
        : defaults.summaryLLMConfig,
      summaryLLMEnabled: raw.summaryLLMEnabled === "true",
      databasePath: raw.databasePath ?? defaults.databasePath,
      // Code display settings
      showLineNumbers: raw.showLineNumbers !== "false",
      wordWrap: raw.wordWrap !== "false",
      // Notification settings
      notificationsEnabled: raw.notificationsEnabled !== "false",
      soundEffectsEnabled: raw.soundEffectsEnabled !== "false",
      // Vision model settings - always loaded from ConfigManager via refresh()
      visionLLMConfig: defaults.visionLLMConfig,
      visionLLMEnabled: defaults.visionLLMEnabled,
      // Gateway model settings - handle both plain string and JSON-stringified string, with modelSelection fallback
      gatewayModel: (() => {
        const val = raw.gatewayModel ?? modelSelection?.gatewayModel;
        if (!val) return defaults.gatewayModel;
        // If it looks like a JSON string (starts and ends with quote), try to parse it
        if (typeof val === 'string' && val.startsWith('"') && val.endsWith('"')) {
          try {
            return JSON.parse(val);
          } catch {
            return val;
          }
        }
        return val;
      })(),
      // Wiki Agent model - handle both plain string and JSON-stringified string, with modelSelection fallback
      wikiAgentModel: (() => {
        const val = raw.wikiAgentModel ?? modelSelection?.wikiAgentModel;
        if (!val) return undefined;
        if (typeof val === 'string' && val.startsWith('"') && val.endsWith('"')) {
          try {
            return JSON.parse(val);
          } catch {
            return val;
          }
        }
        return val;
      })(),
      wikiAgentEnabled: raw.wikiAgentEnabled === "true",
      // Title generation model - handle both plain string and JSON-stringified string, with modelSelection fallback
      titleGenerationModel: (() => {
        const val = raw.titleGenerationModel ?? modelSelection?.titleGenerationModel;
        if (!val) return undefined;
        // If it looks like a JSON string (starts and ends with quote), try to parse it
        if (typeof val === 'string' && val.startsWith('"') && val.endsWith('"')) {
          try {
            return JSON.parse(val);
          } catch {
            return val;
          }
        }
        return val;
      })(),
      // Appearance settings
      font: raw.font ?? defaults.font,
      compactMode: raw.compactMode === "true",
      messageFontSize: (raw.messageFontSize as AppSettings['messageFontSize']) || defaults.messageFontSize,
      // Browser security settings
      blockedDomains: raw.blockedDomains ? JSON.parse(raw.blockedDomains) : defaults.blockedDomains,
      // Favorite agent profiles for quick access (max 3)
      favoriteAgentIds: raw.favoriteAgentIds ? JSON.parse(raw.favoriteAgentIds) : defaults.favoriteAgentIds,
      // Agent prompt language preference
      agentLanguage: (() => {
        const val = raw.agentLanguage;
        if (!val) return undefined;
        if (typeof val === 'string' && val.startsWith('"') && val.endsWith('"')) {
          try {
            return JSON.parse(val);
          } catch {
            return val;
          }
        }
        return val;
      })(),
      // Security settings
      securityScanEnabled: raw.securityScanEnabled !== "false",
      cronPermissionMode: (raw.cronPermissionMode as AppSettings["cronPermissionMode"]) ?? defaults.cronPermissionMode,
      gatewayPermissionMode: (raw.gatewayPermissionMode as AppSettings["gatewayPermissionMode"]) ?? defaults.gatewayPermissionMode,
      // Default workspace directory for creating new projects
      workspaceDir: raw.workspaceDir || undefined,
    };
  } catch {
    return defaults;
  }
}

/**
 * Hook for fetching and saving settings from the duya settings API.
 * Handles loading/saving states and provides a clean CRUD interface.
 *
 * Uses IPC in Electron environment, falls back to API routes otherwise.
 */
export function useSettings(): {
  settings: AppSettings;
  loading: boolean;
  saving: boolean;
  error: string | null;
  save: (updates: Partial<AppSettings>) => Promise<void>;
  refresh: () => Promise<void>;
} {
  const [settings, setSettings] = useState<AppSettings>({
    apiKey: "",
    baseURL: "",
    defaultModel: "",
    lastSelectedModel: "",
    mcpServers: [],
    permissionMode: "auto",
    sandboxEnabled: true,
    theme: "dark",
    locale: "en",
    provider: "",
    messageFont: "serif",
    skillAdditionalPaths: [],
    skillNudgeInterval: 10,
    summaryLLMConfig: null,
    summaryLLMEnabled: false,
    databasePath: "",
    // Code display settings
    showLineNumbers: true,
    wordWrap: true,
    // Notification settings
    notificationsEnabled: true,
    soundEffectsEnabled: true,
    // Vision model settings
    visionLLMConfig: null,
    visionLLMEnabled: false,
    // Gateway model settings
    gatewayModel: "",
    // Wiki Agent model settings
    wikiAgentModel: undefined,
    // Wiki Agent feature toggle (experimental)
    wikiAgentEnabled: false,
    // Title generation model
    titleGenerationModel: undefined,
    // Appearance settings
    font: undefined,
    compactMode: false,
    messageFontSize: 'medium',
    // Browser security settings
    blockedDomains: [],
    // Favorite agent profiles for quick access (max 3)
    favoriteAgentIds: ['general-purpose', 'code-expert', 'plan'],
    // Agent prompt language preference
    agentLanguage: undefined,
    // Security settings
    securityScanEnabled: true,
    cronPermissionMode: "auto",
    gatewayPermissionMode: "auto",
    // Default workspace directory for creating new projects
    workspaceDir: undefined,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const raw = await getAllSettingsIPC();
      const parsed = parseAppSettings(raw);

      // 使用 ConfigManager API 读取 vision 设置（统一存储）
      if (typeof window !== 'undefined' && window.electronAPI?.vision?.get) {
        try {
          const visionConfig = await window.electronAPI.vision.get() as {
            provider?: string;
            model?: string;
            baseUrl?: string;
            apiKey?: string;
            enabled?: boolean;
          } | null;
          if (visionConfig) {
            parsed.visionLLMConfig = {
              provider: visionConfig.provider || '',
              model: visionConfig.model || '',
              baseURL: visionConfig.baseUrl || '',
              apiKey: visionConfig.apiKey || '',
              enabled: visionConfig.enabled ?? false,
            };
            parsed.visionLLMEnabled = visionConfig.enabled ?? false;
          }
        } catch {
          // 读取失败，使用 SQLite 中的数据作为 fallback
        }
      }

      if (typeof window !== 'undefined' && window.electronAPI?.settings?.getMcpServers) {
        try {
          const mcpResult = await window.electronAPI.settings.getMcpServers();
          if (mcpResult?.success && Array.isArray(mcpResult.data)) {
            parsed.mcpServers = mcpResult.data as MCPServerConfig[];
          }
        } catch {
          // Keep SQLite mcpServers as fallback.
        }
      }

      setSettings(parsed);
    } catch {
      setError("Failed to load settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const save = useCallback(async (updates: Partial<AppSettings>) => {
    setSaving(true);
    setError(null);
    try {
      if (typeof window !== 'undefined' && window.electronAPI?.settingsDb?.setJson) {
        for (const [key, value] of Object.entries(updates)) {
          if (key === 'visionLLMConfig' && value) {
            const config = value as VisionLLMConfig;
            await window.electronAPI.vision?.set({
              provider: config.provider,
              model: config.model,
              baseUrl: config.baseURL,
              apiKey: config.apiKey,
              enabled: config.enabled,
            });
          } else if (key === 'visionLLMEnabled') {
            await window.electronAPI.vision?.set({ enabled: value as boolean });
          } else if (key === 'mcpServers') {
            const mcpServers = Array.isArray(value) ? value as MCPServerConfig[] : [];
            await window.electronAPI.settingsDb.setJson('mcpServers', mcpServers);
            if (window.electronAPI.settings?.setMcpServers) {
              await window.electronAPI.settings.setMcpServers(mcpServers);
            }
        } else if (key === 'permissionMode' && typeof value === 'string') {
          await window.electronAPI.settingsDb.set(key, uiPermissionModeToSettings(value as Parameters<typeof uiPermissionModeToSettings>[0]));
        } else if (key === 'cronPermissionMode' && typeof value === 'string') {
          await window.electronAPI.settingsDb.set(key, uiPermissionModeToSettings(value as Parameters<typeof uiPermissionModeToSettings>[0]));
        } else if (key === 'gatewayPermissionMode' && typeof value === 'string') {
          await window.electronAPI.settingsDb.set(key, uiPermissionModeToSettings(value as Parameters<typeof uiPermissionModeToSettings>[0]));
        } else if (typeof value === 'string') {
          await window.electronAPI.settingsDb.set(key, value);
        } else {
          await window.electronAPI.settingsDb.setJson(key, value);
          }
        }
        const raw = await getAllSettingsIPC();
      setSettings(parseAppSettings(raw));
      } else {
        setError('Settings storage not available');
      }
    } catch {
      setError('Failed to save settings');
    } finally {
      setSaving(false);
    }
  }, []);

  return { settings, loading, saving, error, save, refresh };
}
