import { useState, useCallback, useEffect } from "react";
import type { AppSettings, VisionLLMConfig } from "@/types";
import { getAllSettingsIPC } from "@/lib/ipc-client";

/**
 * Convert raw settings (Record<string, string>) to AppSettings format
 */
function parseAppSettings(raw: Record<string, string>): AppSettings {
  const defaults: AppSettings = {
    apiKey: "",
    baseURL: "https://api.anthropic.com",
    defaultModel: "claude-3-5-sonnet-latest",
    lastSelectedModel: "", // Default to empty, meaning use defaultModel
    mcpServers: [],
    permissionMode: "default",
    sandboxEnabled: true,
    theme: "dark",
    locale: "en",
    provider: "anthropic",
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
    gatewayModel: "claude-sonnet-4-20250514",
    // Title generation model
    titleGenerationModel: undefined,
    // Appearance settings
    font: undefined,
    compactMode: false,
    showTimestamps: true,
    showAvatars: true,
    // Browser security settings
    blockedDomains: [],
    // Favorite agent profiles for quick access (max 3)
    favoriteAgentIds: ['general-purpose', 'code-expert', 'research'],
    // Agent prompt language preference
    agentLanguage: undefined,
  };

  try {
    // Parse modelSelection as fallback for gateway/title models
    let modelSelection: { gatewayModel?: string; titleGenerationModel?: string; embeddingModel?: string } | null = null;
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
      locale: raw.locale ?? defaults.locale,
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
      // Vision model settings - read from visionSettings for backend compatibility
      visionLLMConfig: (() => {
        // Try visionSettings first (backend format), then fall back to visionLLMConfig
        const rawConfig = raw.visionSettings || raw.visionLLMConfig;
        if (rawConfig && rawConfig !== "null") {
          try {
            const parsed = JSON.parse(rawConfig);
            return {
              provider: parsed.provider || '',
              model: parsed.model || '',
              baseURL: parsed.baseUrl || parsed.baseURL || '', // Handle both formats
              apiKey: parsed.apiKey || '',
              enabled: parsed.enabled ?? false,
            };
          } catch {
            return defaults.visionLLMConfig;
          }
        }
        return defaults.visionLLMConfig;
      })(),
      visionLLMEnabled: raw.visionSettings
        ? (() => {
          try {
            return JSON.parse(raw.visionSettings).enabled ?? false;
          } catch {
            return false;
          }
        })()
        : raw.visionLLMEnabled === "true",
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
      showTimestamps: raw.showTimestamps !== "false",
      showAvatars: raw.showAvatars !== "false",
      // Browser security settings
      blockedDomains: raw.blockedDomains ? JSON.parse(raw.blockedDomains) : defaults.blockedDomains,
      // Favorite agent profiles for quick access (max 3)
      favoriteAgentIds: raw.favoriteAgentIds ? JSON.parse(raw.favoriteAgentIds) : defaults.favoriteAgentIds,
      // Agent prompt language preference
      agentLanguage: raw.agentLanguage || undefined,
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
    baseURL: "https://api.anthropic.com",
    defaultModel: "claude-3-5-sonnet-latest",
    lastSelectedModel: "",
    mcpServers: [],
    permissionMode: "default",
    sandboxEnabled: true,
    theme: "dark",
    locale: "en",
    provider: "anthropic",
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
    gatewayModel: "claude-sonnet-4-20250514",
    // Title generation model
    titleGenerationModel: undefined,
    // Appearance settings
    font: undefined,
    compactMode: false,
    showTimestamps: true,
    showAvatars: true,
    // Browser security settings
    blockedDomains: [],
    // Favorite agent profiles for quick access (max 3)
    favoriteAgentIds: ['general-purpose', 'code-expert', 'plan'],
    // Agent prompt language preference
    agentLanguage: undefined,
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
          // Use ConfigManager-backed API for vision settings (统一存储)
          if (key === 'visionLLMConfig' && value) {
            const config = value as VisionLLMConfig;
            if (window.electronAPI.vision?.set) {
              await window.electronAPI.vision.set({
                provider: config.provider,
                model: config.model,
                baseUrl: config.baseURL,
                apiKey: config.apiKey,
                enabled: config.enabled,
              });
            } else {
              // Fallback: 直接写入 SQLite
              await window.electronAPI.settingsDb.setJson('visionSettings', {
                provider: config.provider,
                model: config.model,
                baseUrl: config.baseURL,
                apiKey: config.apiKey,
                enabled: config.enabled,
              });
            }
          } else if (key === 'visionLLMEnabled') {
            if (window.electronAPI.vision?.set) {
              await window.electronAPI.vision.set({ enabled: value as boolean });
            } else {
              // Fallback
              const currentSettings = await window.electronAPI.settingsDb.get('visionSettings');
              if (currentSettings) {
                const parsed = typeof currentSettings === 'string' ? JSON.parse(currentSettings) : currentSettings;
                await window.electronAPI.settingsDb.setJson('visionSettings', {
                  ...parsed,
                  enabled: value,
                });
              }
            }
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
