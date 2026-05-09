"use client";

import { useSettings } from "@/hooks/useSettings";
import { useTranslation } from "@/hooks/useTranslation";
import { SunIcon, MoonIcon, MonitorIcon, SpinnerGapIcon } from "@/components/icons";
import { useState, useEffect } from "react";
import {
  SettingsSection,
  SettingsCard,
  SettingsToggle,
  SettingsSelectRow,
  SettingsSegmented,
} from "@/components/settings/ui";
import { type TranslationKey } from "@/i18n";

const FONT_KEYS = [
  { value: "system", key: 'settings.appearance.fontSystem' },
  { value: "geist", key: 'settings.appearance.fontGeist' },
  { value: "inter", key: 'settings.appearance.fontInter' },
  { value: "jetbrains", key: 'settings.appearance.fontJetbrains' },
];

export function AppearanceSection() {
  const { t } = useTranslation();
  const { settings, loading, save } = useSettings();
  const [isApplying, setIsApplying] = useState(false);

  const [theme, setTheme] = useState<"light" | "dark" | "system">("system");
  const [font, setFont] = useState("system");

  const fonts = FONT_KEYS.map(f => ({ value: f.value, label: t(f.key as TranslationKey) }));
  const [compactMode, setCompactMode] = useState(false);
  const [showTimestamps, setShowTimestamps] = useState(true);
  const [showAvatars, setShowAvatars] = useState(true);

  useEffect(() => {
    if (settings) {
      setTheme((settings.theme as "light" | "dark" | "system") || "system");
      setFont(settings.font || "system");
      setCompactMode(settings.compactMode ?? false);
      setShowTimestamps(settings.showTimestamps ?? true);
      setShowAvatars(settings.showAvatars ?? true);
    }
  }, [settings]);

  const applyTheme = async (newTheme: "light" | "dark" | "system") => {
    setIsApplying(true);
    setTheme(newTheme);

    const root = document.documentElement;
    root.classList.remove("light", "dark");

    if (newTheme === "system") {
      const systemPrefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      root.classList.add(systemPrefersDark ? "dark" : "light");
      root.setAttribute("data-theme", systemPrefersDark ? "dark" : "light");
    } else {
      root.classList.add(newTheme);
      root.setAttribute("data-theme", newTheme);
    }

    await save({ theme: newTheme });
    setIsApplying(false);
  };

  const applyFont = async (newFont: string) => {
    setFont(newFont);
    const root = document.documentElement;
    root.setAttribute("data-font", newFont);
    await save({ font: newFont });
  };

  const applyCompactMode = async (enabled: boolean) => {
    setCompactMode(enabled);
    const root = document.documentElement;
    if (enabled) {
      root.classList.add("compact");
    } else {
      root.classList.remove("compact");
    }
    await save({ compactMode: enabled });
  };

  const applyShowTimestamps = async (enabled: boolean) => {
    setShowTimestamps(enabled);
    await save({ showTimestamps: enabled });
  };

  const applyShowAvatars = async (enabled: boolean) => {
    setShowAvatars(enabled);
    await save({ showAvatars: enabled });
  };

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
      {/* Theme Section */}
      <SettingsSection title={t('settings.appearance.themeTitle')} description={t('settings.appearance.themeDesc')}>
        <SettingsCard>
          <div className="px-4 py-3.5">
            <label className="text-sm font-medium text-foreground block mb-3">{t('settings.appearance.colorTheme')}</label>
            <SettingsSegmented
              value={theme}
              onValueChange={(v) => applyTheme(v as "light" | "dark" | "system")}
              options={[
                { value: "light", label: t('settings.appearance.themeLight'), icon: <SunIcon size={16} /> },
                { value: "dark", label: t('settings.appearance.themeDark'), icon: <MoonIcon size={16} /> },
                { value: "system", label: t('settings.appearance.themeSystem'), icon: <MonitorIcon size={16} /> },
              ]}
            />
          </div>
          <SettingsToggle
            label={t('settings.appearance.compactMode')}
            description={t('settings.appearance.compactModeDesc')}
            checked={compactMode}
            onCheckedChange={applyCompactMode}
          />
        </SettingsCard>
      </SettingsSection>

      {/* Typography Section */}
      <SettingsSection title={t('settings.appearance.typographyTitle')} description={t('settings.appearance.typographyDesc')}>
        <SettingsCard>
          <SettingsSelectRow
            label={t('settings.appearance.fontFamily')}
            description={t('settings.appearance.fontFamilyDesc')}
            value={font}
            onValueChange={applyFont}
            options={fonts}
          />
        </SettingsCard>
      </SettingsSection>

      {/* Chat Display Section */}
      <SettingsSection title={t('settings.appearance.chatDisplayTitle')} description={t('settings.appearance.chatDisplayDesc')}>
        <SettingsCard>
          <SettingsToggle
            label={t('settings.appearance.showTimestamps')}
            description={t('settings.appearance.showTimestampsDesc')}
            checked={showTimestamps}
            onCheckedChange={applyShowTimestamps}
          />
          <SettingsToggle
            label={t('settings.appearance.showAvatars')}
            description={t('settings.appearance.showAvatarsDesc')}
            checked={showAvatars}
            onCheckedChange={applyShowAvatars}
          />
        </SettingsCard>
      </SettingsSection>

      {/* Preview Section */}
      <SettingsSection title={t('settings.appearance.previewTitle')} description={t('settings.appearance.previewDesc')}>
        <SettingsCard className="p-4">
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-full bg-accent/10 flex items-center justify-center shrink-0">
                <span className="text-xs font-medium text-accent">AI</span>
              </div>
              <div className="flex-1 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{t('settings.appearance.previewAssistant')}</span>
                  {showTimestamps && (
                    <span className="text-xs text-muted-foreground">12:34 PM</span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">
                  {t('settings.appearance.previewMessageAi')}
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center shrink-0">
                <span className="text-xs font-medium">{t('settings.appearance.previewYou')}</span>
              </div>
              <div className="flex-1 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{t('settings.appearance.previewYou')}</span>
                  {showTimestamps && (
                    <span className="text-xs text-muted-foreground">12:35 PM</span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">
                  {t('settings.appearance.previewMessageUser')}
                </p>
              </div>
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
