"use client";

import { useState, useCallback, useEffect } from "react";
import { useSettings } from "@/hooks/useSettings";
import { useTranslation } from "@/hooks/useTranslation";
import { SpinnerGapIcon } from "@/components/icons";
import {
  SettingsSection,
  SettingsCard,
  SettingsToggle,
} from "@/components/settings/ui";
import { HostToolPermissionCard } from "./HostToolPermissionCard";
import { Button } from "@/components/ui/Button";

export function SecuritySection() {
  const { settings, loading, saving, error, save } = useSettings();
  const { t } = useTranslation();
  const [sandboxEnabled, setSandboxEnabled] = useState(settings.sandboxEnabled);
  const [securityScanEnabled, setSecurityScanEnabled] = useState(settings.securityScanEnabled);
  const [isDirty, setIsDirty] = useState(false);

  useEffect(() => {
    setSandboxEnabled(settings.sandboxEnabled);
    setSecurityScanEnabled(settings.securityScanEnabled);
    setIsDirty(false);
  }, [settings]);

  const handleSandboxToggle = useCallback((checked: boolean) => {
    setSandboxEnabled(checked);
    setIsDirty(true);
  }, []);

  const handleSecurityScanToggle = useCallback((checked: boolean) => {
    setSecurityScanEnabled(checked);
    setIsDirty(true);
  }, []);

  const handleSave = useCallback(async () => {
    await save({
      sandboxEnabled,
      securityScanEnabled,
    });
    setIsDirty(false);
  }, [sandboxEnabled, securityScanEnabled, save]);

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

        {/* Plan 487: host-level standing permission switch. */}
        <div className="mt-6">
          <HostToolPermissionCard />
        </div>

        {isDirty && (
          <div className="mt-4 flex items-center justify-end gap-3">
            <span className="text-xs text-muted-foreground">{t('settings.security.unsavedChanges')}</span>
            <Button
              variant="primary"
              onClick={handleSave}
              disabled={saving}
            >
              {saving && <SpinnerGapIcon size={14} className="animate-spin" />}
              {saving ? t('settings.security.saving') : t('settings.security.saveChanges')}
            </Button>
          </div>
        )}
      </SettingsSection>
    </div>
  );
}
