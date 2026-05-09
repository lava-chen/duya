"use client";

import { useSettings } from "@/hooks/useSettings";
import { useIPC } from "@/hooks/useIPC";
import {
  SpinnerGapIcon,
  FolderIcon,
  XIcon,
  ArrowLeftIcon,
  DatabaseIcon,
  EyeIcon,
  CheckCircleIcon,
  LightningIcon,
  GlobeIcon,
  KeyIcon,
  CpuIcon,
  InfoIcon,
} from "@/components/icons";
import { useTranslation } from "@/hooks/useTranslation";
import { SUPPORTED_LOCALES, type Locale, type TranslationKey } from "@/i18n";
import { useState, useEffect, useCallback } from "react";
import { checkMigrationNeededIPC, migrateDatabaseIPC } from "@/lib/ipc-client";
import { testNotification } from "@/lib/notification";
import type { VisionLLMConfig } from "@/types";
import {
  SettingsSection,
  SettingsCard,
  SettingsCardFooter,
  SettingsRow,
  SettingsToggle,
  SettingsSelectRow,
  SettingsInput,
} from "@/components/settings/ui";

const VISION_PRESETS = [
  { provider: "openai", model: "gpt-4o", baseURL: "https://api.openai.com/v1" },
  { provider: "openai", model: "gpt-4o-mini", baseURL: "https://api.openai.com/v1" },
  { provider: "anthropic", model: "claude-sonnet-4-20250514", baseURL: "https://api.anthropic.com" },
  { provider: "openrouter", model: "google/gemini-2.5-flash", baseURL: "https://openrouter.ai/api/v1" },
  { provider: "ollama", model: "llava", baseURL: "http://localhost:11434" },
];



interface MigrationInfo {
  needed: boolean;
  sourcePath: string | null;
  targetExists: boolean;
  sourceSize: string | null;
}

export function GeneralSection() {
  const { t, locale, setLocale } = useTranslation();
  const { settings, loading, error, save, saving } = useSettings();
  const { listProviders } = useIPC();

  const [autoStart, setAutoStart] = useState(false);
  const [autoStartCanChange, setAutoStartCanChange] = useState(true);
  const [autoStartSupported, setAutoStartSupported] = useState(true);
  const [autoStartLoading, setAutoStartLoading] = useState(true);

  const [showRestartPrompt, setShowRestartPrompt] = useState(false);
  const [originalDbPath, setOriginalDbPath] = useState("");
  const [migrationInfo, setMigrationInfo] = useState<MigrationInfo | null>(null);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [isMigrating, setIsMigrating] = useState(false);
  const [migrationError, setMigrationError] = useState<string | null>(null);

  const [visionEnabled, setVisionEnabled] = useState(false);
  const [visionProvider, setVisionProvider] = useState("");
  const [visionModel, setVisionModel] = useState("");
  const [visionBaseURL, setVisionBaseURL] = useState("");
  const [visionApiKey, setVisionApiKey] = useState("");
  const [visionTestStatus, setVisionTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [notificationTestStatus, setNotificationTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");

  // Gateway models from providers
  const [gatewayModels, setGatewayModels] = useState<{ value: string; label: string }[]>([]);

  useEffect(() => {
    async function loadAutoStartStatus() {
      if (typeof window !== "undefined" && window.electronAPI?.settings) {
        try {
          const status = await window.electronAPI.settings.getAutoStartStatus();
          setAutoStart(status.enabled);
          setAutoStartCanChange(status.canChange);
          setAutoStartSupported(status.supported ?? true);
        } catch (err) {
          console.error("Failed to load auto-start status:", err);
        } finally {
          setAutoStartLoading(false);
        }
      } else {
        setAutoStartLoading(false);
      }
    }
    loadAutoStartStatus();
  }, []);

  useEffect(() => {
    if (settings?.databasePath !== undefined && !originalDbPath) {
      setOriginalDbPath(settings.databasePath);
    }
  }, [settings?.databasePath, originalDbPath]);

  // Load gateway models from providers
  useEffect(() => {
    async function loadGatewayModels() {
      try {
        const providers = await listProviders();
        const models: { value: string; label: string }[] = [];

        for (const provider of providers) {
          if (!provider.isActive) continue;

          // Parse options to get enabled_models
          let enabledModels: string[] = [];
          try {
            const opts = JSON.parse(provider.options || "{}");
            enabledModels = opts.enabled_models || [];
          } catch {
            // Ignore parse errors
          }

          // Add models from enabled_models
          for (const modelId of enabledModels) {
            // Avoid duplicates
            if (!models.some(m => m.value === modelId)) {
              models.push({
                value: modelId,
                label: `${provider.name} - ${modelId}`,
              });
            }
          }

          // Also add default model if configured
          try {
            const roleModels = JSON.parse(provider.extraEnv || "{}");
            const defaultModel = roleModels.default;
            if (defaultModel && !models.some(m => m.value === defaultModel)) {
              models.push({
                value: defaultModel,
                label: `${provider.name} - ${defaultModel}`,
              });
            }
          } catch {
            // Ignore parse errors
          }
        }

        setGatewayModels(models);
      } catch (err) {
        console.error("Failed to load gateway models:", err);
        setGatewayModels([]);
      }
    }

    loadGatewayModels();
  }, [listProviders]);

  useEffect(() => {
    if (settings.visionLLMConfig) {
      setVisionEnabled(settings.visionLLMEnabled);
      setVisionProvider(settings.visionLLMConfig.provider);
      setVisionModel(settings.visionLLMConfig.model);
      setVisionBaseURL(settings.visionLLMConfig.baseURL);
      setVisionApiKey(settings.visionLLMConfig.apiKey);
    }
  }, [settings.visionLLMConfig, settings.visionLLMEnabled]);

  const handleAutoStartChange = async (enabled: boolean) => {
    if (!window.electronAPI?.settings) return;
    try {
      const result = await window.electronAPI.settings.setAutoStart(enabled);
      if (result.success) {
        setAutoStart(enabled);
      } else if (result.supported === false) {
        console.warn("Auto-start is not supported on this platform");
      }
    } catch (err) {
      console.error("Failed to set auto-start:", err);
    }
  };

  const checkMigration = async (newPath: string): Promise<MigrationInfo> => {
    try {
      const result = await checkMigrationNeededIPC(newPath);
      return {
        needed: result.needed,
        sourcePath: result.sourcePath,
        targetExists: result.targetExists,
        sourceSize: null,
      };
    } catch {
      throw new Error("Failed to check migration status");
    }
  };

  const executeMigration = async (sourcePath: string, targetPath: string) => {
    setIsMigrating(true);
    setMigrationError(null);
    try {
      await migrateDatabaseIPC(sourcePath, targetPath);
      return true;
    } catch (err) {
      setMigrationError(err instanceof Error ? err.message : "Migration failed");
      return false;
    } finally {
      setIsMigrating(false);
    }
  };

  const selectDatabaseFolder = async () => {
    if (typeof window !== "undefined" && window.electronAPI?.dialog) {
      try {
        const result = await window.electronAPI.dialog.openFolder({
          title: "Select Database Directory",
          defaultPath: settings?.databasePath || undefined,
        });
        if (result && !result.canceled && result.filePaths.length > 0) {
          const newPath = result.filePaths[0];
          const info = await checkMigration(newPath);
          if (info.needed) {
            setMigrationInfo(info);
            setPendingPath(newPath);
          } else if (info.targetExists) {
            await save({ databasePath: newPath });
            setShowRestartPrompt(true);
          } else {
            await save({ databasePath: newPath });
            if (originalDbPath && originalDbPath !== newPath) {
              setShowRestartPrompt(true);
            }
          }
        }
      } catch (err) {
        console.error("Failed to open folder dialog:", err);
      }
    }
  };

  const handleMigrateConfirm = async () => {
    if (!migrationInfo?.sourcePath || !pendingPath) return;
    const success = await executeMigration(migrationInfo.sourcePath, pendingPath);
    if (success) {
      await save({ databasePath: pendingPath });
      setMigrationInfo(null);
      setPendingPath(null);
      setShowRestartPrompt(true);
    }
  };

  const handleMigrateCancel = async () => {
    if (!pendingPath) return;
    await save({ databasePath: pendingPath });
    setMigrationInfo(null);
    setPendingPath(null);
    setShowRestartPrompt(true);
  };

  const closeMigrationDialog = () => {
    setMigrationInfo(null);
    setPendingPath(null);
    setMigrationError(null);
  };

  const resetDatabasePath = async () => {
    await save({ databasePath: "" });
    if (originalDbPath) {
      setShowRestartPrompt(true);
    }
  };

  const handleVisionSave = useCallback(async () => {
    const config: VisionLLMConfig = {
      provider: visionProvider,
      model: visionModel,
      baseURL: visionBaseURL,
      apiKey: visionApiKey,
      enabled: visionEnabled,
    };
    await save({
      visionLLMConfig: config,
      visionLLMEnabled: visionEnabled,
    });
  }, [visionProvider, visionModel, visionBaseURL, visionApiKey, visionEnabled, save]);

  const handleVisionPresetSelect = useCallback((preset: (typeof VISION_PRESETS)[0]) => {
    setVisionProvider(preset.provider);
    setVisionModel(preset.model);
    setVisionBaseURL(preset.baseURL);
  }, []);

  const handleVisionTestConnection = useCallback(async () => {
    setVisionTestStatus("testing");
    try {
      if (!visionProvider || !visionModel) {
        setVisionTestStatus("error");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      setVisionTestStatus("success");
    } catch {
      setVisionTestStatus("error");
    }
  }, [visionProvider, visionModel]);

  const handleTestNotification = useCallback(async () => {
    setNotificationTestStatus("testing");
    try {
      const success = await testNotification();
      setNotificationTestStatus(success ? "success" : "error");
    } catch {
      setNotificationTestStatus("error");
    }
  }, []);

  const visionHasChanges =
    visionEnabled !== settings.visionLLMEnabled ||
    visionProvider !== (settings.visionLLMConfig?.provider || "") ||
    visionModel !== (settings.visionLLMConfig?.model || "") ||
    visionBaseURL !== (settings.visionLLMConfig?.baseURL || "") ||
    visionApiKey !== (settings.visionLLMConfig?.apiKey || "");

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-12">
        <SpinnerGapIcon size={18} className="animate-spin" />
        <span className="text-sm text-muted-foreground">{t("common.loading")}</span>
      </div>
    );
  }

  return (
    <div className="settings-section">
      {/* Error Banner */}
      {error && (
        <div className="mb-4 rounded-lg border border-destructive/50 bg-destructive/10 p-3">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {/* Restart Prompt */}
      {showRestartPrompt && (
        <div className="mb-4 rounded-lg border border-blue-500/30 bg-blue-500/10 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-start gap-3">
              <InfoIcon size={18} className="text-blue-500 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium text-sm">{t("settings.general.databasePathChanged")}</p>
                <p className="text-sm text-muted-foreground">{t("settings.general.restartRequired")}</p>
              </div>
            </div>
            <button onClick={() => setShowRestartPrompt(false)} className="p-1 hover:bg-muted rounded shrink-0">
              <XIcon size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Migration Dialog */}
      {migrationInfo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={closeMigrationDialog} />
          <div className="relative z-10 w-full max-w-md mx-4 bg-surface border border-border/50 rounded-xl shadow-xl p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center">
                <DatabaseIcon size={20} className="text-accent" />
              </div>
              <h3 className="text-lg font-semibold">{t("settings.general.migrateDatabase")}</h3>
            </div>
            <p className="text-sm text-muted-foreground mb-4">
              {t("settings.general.migrateDatabaseDesc")}
            </p>
            <div className="space-y-2 mb-4 p-3 rounded-lg bg-muted/50">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">{t("settings.general.from")}</span>
                <span className="font-mono text-xs truncate">{migrationInfo.sourcePath}</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">{t("settings.general.to")}</span>
                <span className="font-mono text-xs truncate">{pendingPath}</span>
              </div>
            </div>
            {migrationError && (
              <div className="mb-4 rounded-lg border border-destructive/50 bg-destructive/10 p-3">
                <p className="text-sm text-destructive">{migrationError}</p>
              </div>
            )}
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={closeMigrationDialog}
                className="px-4 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground transition-colors"
                disabled={isMigrating}
              >
                {t("settings.general.cancel")}
              </button>
              <button
                onClick={handleMigrateCancel}
                className="px-4 py-2 rounded-lg text-sm border border-border/50 hover:bg-muted transition-colors"
                disabled={isMigrating}
              >
                {t("settings.general.useNewLocation")}
              </button>
              <button
                onClick={handleMigrateConfirm}
                className="px-4 py-2 rounded-lg text-sm bg-accent text-white hover:bg-accent/90 transition-colors flex items-center gap-2"
                disabled={isMigrating}
              >
                {isMigrating && <SpinnerGapIcon size={14} className="animate-spin" />}
                {isMigrating ? t("settings.general.migrating") : t("settings.general.migrateData")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Application Section */}
      <SettingsSection title={t("settings.general.application")} description={t("settings.general.applicationDesc")}>
        <SettingsCard>
          <SettingsSelectRow
            label={t("settings.general.language")}
            description={t("settings.general.languageDesc")}
            value={locale}
            onValueChange={(v) => {
              const newLocale = v as Locale;
              setLocale(newLocale);
              save({ locale: newLocale });
            }}
            options={SUPPORTED_LOCALES.map((l) => ({ value: l.value, label: l.label }))}
          />
          <SettingsRow
            label={t("settings.general.autoStart")}
            description={
              autoStartSupported
                ? t("settings.general.autoStartDesc")
                : t("settings.general.autoStartUnsupported")
            }
          >
            {autoStartLoading ? (
              <SpinnerGapIcon size={16} className="animate-spin text-muted-foreground" />
            ) : (
              <SettingsToggle
                label=""
                checked={autoStart}
                onCheckedChange={handleAutoStartChange}
                disabled={!autoStartCanChange || !autoStartSupported}
              />
            )}
          </SettingsRow>
          <SettingsRow
            label={t("settings.general.databaseLocation")}
            description={settings?.databasePath || t("settings.general.databaseLocationDesc")}
            action={
              <div className="flex items-center gap-2">
                <button
                  onClick={selectDatabaseFolder}
                  className="p-2 rounded-lg border border-border/50 hover:bg-muted transition-colors"
                  title={t("common.select")}
                >
                  <FolderIcon size={16} />
                </button>
                {settings?.databasePath && (
                  <button
                    onClick={resetDatabasePath}
                    className="p-2 rounded-lg border border-border/50 hover:bg-muted transition-colors"
                    title={t("common.reset")}
                  >
                    <XIcon size={16} />
                  </button>
                )}
              </div>
            }
          />
          <SettingsSelectRow
            label={t("settings.general.gatewayModel")}
            description={t("settings.general.gatewayModelDesc")}
            value={settings?.gatewayModel || gatewayModels[0]?.value || "claude-sonnet-4-20250514"}
            onValueChange={(v) => save({ gatewayModel: v })}
            options={gatewayModels}
          />
        </SettingsCard>
      </SettingsSection>

      {/* Notifications Section */}
      <SettingsSection title={t("settings.general.notifications")} description={t("settings.general.notificationsDesc")}>
        <SettingsCard>
          <SettingsToggle
            label={t("settings.general.enableNotifications")}
            description={t("settings.general.enableNotificationsDesc")}
            checked={settings?.notificationsEnabled ?? true}
            onCheckedChange={(checked) => save({ notificationsEnabled: checked })}
          />
          <SettingsToggle
            label={t("settings.general.soundEffects")}
            description={t("settings.general.soundEffectsDesc")}
            checked={settings?.soundEffectsEnabled ?? true}
            onCheckedChange={(checked) => save({ soundEffectsEnabled: checked })}
          />
          <SettingsCardFooter>
            <button
              type="button"
              onClick={handleTestNotification}
              disabled={notificationTestStatus === "testing" || !settings?.notificationsEnabled}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border border-border/50 hover:bg-muted transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {notificationTestStatus === "testing" ? (
                <SpinnerGapIcon size={14} className="animate-spin" />
              ) : notificationTestStatus === "success" ? (
                <CheckCircleIcon size={14} className="text-green-500" />
              ) : notificationTestStatus === "error" ? (
                <XIcon size={14} className="text-destructive" />
              ) : (
                <LightningIcon size={14} />
              )}
              {notificationTestStatus === "testing"
                ? t("settings.general.testing")
                : notificationTestStatus === "success"
                ? t("settings.general.connected")
                : notificationTestStatus === "error"
                ? t("settings.general.failed")
                : t("settings.general.testNotification")}
            </button>
          </SettingsCardFooter>
        </SettingsCard>
      </SettingsSection>

      {/* Vision Model Section */}
      <SettingsSection
        title={t("settings.general.visionModel")}
        description={t("settings.general.visionModelDesc")}
      >
        <SettingsCard>
          <SettingsToggle
            label={t("settings.general.enableVisionModel")}
            description={t("settings.general.enableVisionModelDesc")}
            checked={visionEnabled}
            onCheckedChange={setVisionEnabled}
          />

          {visionEnabled && (
            <>
              {/* Quick Presets */}
              <div className="px-4 py-3.5">
                <label className="text-sm font-medium text-foreground block mb-3">{t("settings.general.quickPresets")}</label>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {VISION_PRESETS.map((preset) => (
                    <button
                      key={`${preset.provider}-${preset.model}`}
                      type="button"
                      onClick={() => handleVisionPresetSelect(preset)}
                      className={`p-3 text-left rounded-lg border transition-all duration-200 hover:scale-[1.02] ${
                        visionProvider === preset.provider && visionModel === preset.model
                          ? "border-accent ring-1 ring-accent bg-accent/5"
                          : "border-border/50 bg-surface/50 hover:border-accent/30"
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1.5">
                        <CpuIcon size={14} className="text-accent" />
                        <span className="text-xs font-medium capitalize text-foreground">{preset.provider}</span>
                      </div>
                      <span className="text-xs text-muted-foreground">{preset.model}</span>
                    </button>
                  ))}
                </div>
              </div>

              <SettingsInput
                label={t("settings.general.provider")}
                value={visionProvider}
                onChange={setVisionProvider}
                placeholder={t("settings.general.providerPlaceholder")}
              />
              <SettingsInput
                label={t("settings.general.model")}
                value={visionModel}
                onChange={setVisionModel}
                placeholder={t("settings.general.modelPlaceholder")}
              />
              <SettingsInput
                label={t("settings.general.baseUrl")}
                value={visionBaseURL}
                onChange={setVisionBaseURL}
                placeholder={t("settings.general.baseUrlPlaceholder")}
              />
              <SettingsInput
                label={t("settings.general.apiKey")}
                type="password"
                value={visionApiKey}
                onChange={setVisionApiKey}
                placeholder={t("settings.general.apiKeyPlaceholder")}
              />

              <SettingsCardFooter>
                <button
                  type="button"
                  onClick={handleVisionTestConnection}
                  disabled={visionTestStatus === "testing"}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border border-border/50 hover:bg-muted transition-all"
                >
                  {visionTestStatus === "testing" ? (
                    <SpinnerGapIcon size={14} className="animate-spin" />
                  ) : visionTestStatus === "success" ? (
                    <CheckCircleIcon size={14} className="text-green-500" />
                  ) : visionTestStatus === "error" ? (
                    <XIcon size={14} className="text-destructive" />
                  ) : (
                    <LightningIcon size={14} />
                  )}
                  {visionTestStatus === "testing"
                    ? t("settings.general.testing")
                    : visionTestStatus === "success"
                    ? t("settings.general.connected")
                    : visionTestStatus === "error"
                    ? t("settings.general.failed")
                    : t("settings.general.testConnection")}
                </button>
                <button
                  type="button"
                  onClick={handleVisionSave}
                  disabled={!visionHasChanges || saving}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-accent text-white hover:bg-accent/90 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {saving ? <SpinnerGapIcon size={14} className="animate-spin" /> : <CheckCircleIcon size={14} />}
                  {saving ? t("settings.general.saving") : t("settings.general.save")}
                </button>
              </SettingsCardFooter>
            </>
          )}
        </SettingsCard>
      </SettingsSection>

    </div>
  );
}
