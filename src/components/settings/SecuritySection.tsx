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
  const [isDirty, setIsDirty] = useState(false);

  const PERMISSION_MODE_OPTIONS = [
    { value: "ask", label: t('settings.security.permissionModeAsk') },
    { value: "bypass", label: t('settings.security.permissionModeBypass') },
  ];

  useEffect(() => {
    setPermissionMode(settings.permissionMode);
    setSandboxEnabled(settings.sandboxEnabled);
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

  const handleSave = useCallback(async () => {
    await save({
      permissionMode,
      sandboxEnabled,
    });
    setIsDirty(false);
  }, [permissionMode, sandboxEnabled, save]);

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
        </SettingsCard>

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
