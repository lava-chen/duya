"use client";

import { useState, useCallback, useEffect } from "react";
import { useSettings } from "@/hooks/useSettings";
import { useTranslation } from "@/hooks/useTranslation";
import { ShieldCheckIcon, ShieldIcon, SpinnerGapIcon, WarningIcon } from "@/components/icons";
import {
  SettingsSection,
  SettingsCard,
  SettingsCardFooter,
  SettingsToggle,
  SettingsSelectRow,
} from "@/components/settings/ui";

export function SecuritySection() {
  const { settings, loading, saving, error, save } = useSettings();
  const { t } = useTranslation();
  const [permissionMode, setPermissionMode] = useState(settings.permissionMode);
  const [sandboxEnabled, setSandboxEnabled] = useState(settings.sandboxEnabled);
  const [securityScanEnabled, setSecurityScanEnabled] = useState(settings.securityScanEnabled);
  // Gateway IM-channel (Feishu / WeChat / Telegram / QQ) permission. Falls
  // back to desktop `permissionMode` when unset, which is the historical
  // behavior — we surface that explicitly in the UI.
  const gatewayPermissionMode = settings.gatewayPermissionMode ?? settings.permissionMode;
  const [gatewayMode, setGatewayMode] = useState<NonNullable<typeof settings.gatewayPermissionMode>>(gatewayPermissionMode);
  const [isDirty, setIsDirty] = useState(false);

  const PERMISSION_MODE_OPTIONS = [
    { value: "ask", label: t('settings.security.permissionModeAsk') },
    { value: "auto", label: t('settings.security.permissionModeAuto') },
    { value: "bypass", label: t('settings.security.permissionModeBypass') },
  ];

  useEffect(() => {
    setPermissionMode(settings.permissionMode);
    setSandboxEnabled(settings.sandboxEnabled);
    setSecurityScanEnabled(settings.securityScanEnabled);
    setGatewayMode(settings.gatewayPermissionMode ?? settings.permissionMode);
    setIsDirty(false);
  }, [settings]);

  const handlePermissionModeChange = useCallback((value: typeof permissionMode) => {
    setPermissionMode(value);
    setIsDirty(true);
  }, []);

  const handleSandboxToggle = useCallback((checked: boolean) => {
    setSandboxEnabled(checked);
    setIsDirty(true);
  }, []);

  const handleSecurityScanToggle = useCallback((checked: boolean) => {
    setSecurityScanEnabled(checked);
    setIsDirty(true);
  }, []);

  const handleGatewayModeChange = useCallback((value: NonNullable<typeof settings.gatewayPermissionMode>) => {
    setGatewayMode(value);
    setIsDirty(true);
  }, []);

  const handleSave = useCallback(async () => {
    await save({
      permissionMode,
      sandboxEnabled,
      securityScanEnabled,
      gatewayPermissionMode: gatewayMode,
    });
    setIsDirty(false);
  }, [permissionMode, sandboxEnabled, securityScanEnabled, gatewayMode, save]);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-12">
        <SpinnerGapIcon size={18} className="animate-spin" />
        <span className="text-sm text-muted-foreground">{t('settings.security.loading')}</span>
      </div>
    );
  }

  return (
    <div className="settings-section">
      {error && (
        <div className="mb-4 rounded-lg border border-destructive/50 bg-destructive/10 p-3">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      <SettingsSection
        title={t('settings.security.title')}
        description={t('settings.security.description')}
      >
        <SettingsCard>
          <SettingsSelectRow
            label={t('settings.security.permissionMode')}
            description={t('settings.security.permissionModeDesc')}
            value={permissionMode}
            onValueChange={(v) => handlePermissionModeChange(v as typeof permissionMode)}
            options={PERMISSION_MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          />
          <SettingsToggle
            label={t('settings.security.sandboxMode')}
            description={t('settings.security.sandboxModeDesc')}
            checked={sandboxEnabled}
            onCheckedChange={handleSandboxToggle}
          />
          <SettingsToggle
            label={t('settings.security.skillSecurityScan')}
            description={t('settings.security.skillSecurityScanDesc')}
            checked={securityScanEnabled}
            onCheckedChange={handleSecurityScanToggle}
          />
        </SettingsCard>

        <section className="mt-6">
          <h3
            className="text-[1.15rem] font-bold tracking-tight"
            style={{ fontFamily: "'Copernicus', Georgia, 'Times New Roman', serif" }}
          >
            {t('settings.security.gatewayAgentTitle')}
          </h3>
          <p className="text-sm text-muted-foreground mt-0.5">
            {t('settings.security.gatewayAgentDescription')}
          </p>
          <SettingsCard className="mt-3">
            <SettingsSelectRow
              label={t('settings.security.permissionMode')}
              description={
                settings.gatewayPermissionMode === undefined
                  ? t('settings.security.gatewayAgentFallback')
                  : undefined
              }
              value={gatewayMode}
              onValueChange={(v) => handleGatewayModeChange(v as NonNullable<typeof settings.gatewayPermissionMode>)}
              options={PERMISSION_MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            />
          </SettingsCard>

          {(gatewayMode === "bypass" || gatewayMode === "auto") && (
            <div className="mt-4 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-4">
              <div className="flex items-start gap-3">
                <WarningIcon size={18} className="text-yellow-500 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-yellow-500">
                    {t('settings.security.gatewayAgentWarningTitle')}
                  </p>
                  <p className="text-xs text-yellow-500/80 mt-1">
                    {t('settings.security.gatewayAgentWarningDesc')}
                  </p>
                </div>
              </div>
            </div>
          )}
        </section>

        {permissionMode === "bypass" && (
          <div className="mt-4 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-4">
            <div className="flex items-start gap-3">
              <WarningIcon size={18} className="text-yellow-500 mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-medium text-yellow-500">{t('settings.security.warningTitle')}</p>
                <p className="text-xs text-yellow-500/80 mt-1">
                  {t('settings.security.warningDesc')}
                </p>
              </div>
            </div>
          </div>
        )}

        {permissionMode === "auto" && (
          <div className="mt-4 rounded-lg border border-blue-500/30 bg-blue-500/10 p-4">
            <div className="flex items-start gap-3">
              <ShieldCheckIcon size={18} className="text-blue-500 mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-medium text-blue-500">{t('permissionMode.auto')}</p>
                <p className="text-xs text-blue-500/80 mt-1">
                  {t('permissionMode.autoWarningDesc')}
                </p>
              </div>
            </div>
          </div>
        )}

        {isDirty && (
          <div className="mt-4 flex items-center justify-end gap-3">
            <span className="text-xs text-muted-foreground">{t('settings.security.unsavedChanges')}</span>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-accent text-white hover:bg-accent/90 transition-all disabled:opacity-50"
            >
              {saving && <SpinnerGapIcon size={14} className="animate-spin" />}
              {saving ? t('settings.security.saving') : t('settings.security.saveChanges')}
            </button>
          </div>
        )}
      </SettingsSection>
    </div>
  );
}
