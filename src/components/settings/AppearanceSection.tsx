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

// Two functional font presets. Anything other than "system" renders as the
// Duya-loaded font stack (Styrene) via globals.css defaults.
const FONT_KEYS = [
  { value: "duya", key: 'settings.appearance.fontDuya' },
  { value: "system", key: 'settings.appearance.fontSystem' },
];

// Normalize any persisted font value to a valid preset. Legacy values
// ("geist"/"inter"/"jetbrains") were no-ops that fell back to Styrene, so
// they map to "duya" here.
function normalizeFont(value: string | undefined): string {
  return value === "system" ? "system" : "duya";
}

export function AppearanceSection() {
  const { t } = useTranslation();
  const { settings, loading, save } = useSettings();
  const [isApplying, setIsApplying] = useState(false);

  const [theme, setTheme] = useState<"light" | "dark" | "system">("system");
  const [font, setFont] = useState("system");

  const fonts = FONT_KEYS.map(f => ({ value: f.value, label: t(f.key as TranslationKey) }));
  const [compactMode, setCompactMode] = useState(false);
  const [messageFontSize, setMessageFontSize] = useState<"small" | "medium" | "large">("medium");

  useEffect(() => {
    if (settings) {
      setTheme((settings.theme as "light" | "dark" | "system") || "system");
      const normalizedFont = normalizeFont(settings.font);
      setFont(normalizedFont);
      document.documentElement.setAttribute("data-font", normalizedFont);
      setCompactMode(settings.compactMode ?? false);
      const size = (settings.messageFontSize as "small" | "medium" | "large") || "medium";
      setMessageFontSize(size);
      document.documentElement.setAttribute("data-message-font-size", size);
    }
  }, [settings]);

  const applyTheme = async (newTheme: "light" | "dark" | "system") => {
    setIsApplying(true);
    setTheme(newTheme);

    const root = document.documentElement;
    root.classList.remove("light", "dark");

    let resolvedTheme: "light" | "dark";
    if (newTheme === "system") {
      const systemPrefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      resolvedTheme = systemPrefersDark ? "dark" : "light";
      root.classList.add(resolvedTheme);
      root.setAttribute("data-theme", resolvedTheme);
    } else {
      resolvedTheme = newTheme;
      root.classList.add(newTheme);
      root.setAttribute("data-theme", newTheme);
    }

    try {
      window.localStorage.setItem("duya-theme", resolvedTheme);
    } catch {
      // localStorage may be unavailable; the boot script will fall back to system preference.
    }

    await save({ theme: newTheme });
    setIsApplying(false);
  };

  const applyFont = async (newFont: string) => {
    const normalized = normalizeFont(newFont);
    setFont(normalized);
    const root = document.documentElement;
    root.setAttribute("data-font", normalized);
    try {
      window.localStorage.setItem("duya-font", normalized);
    } catch {
      // localStorage may be unavailable; the boot script will fall back to Duya.
    }
    await save({ font: normalized });
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

  const applyMessageFontSize = async (newSize: "small" | "medium" | "large") => {
    setMessageFontSize(newSize);
    const root = document.documentElement;
    root.setAttribute("data-message-font-size", newSize);
    await save({ messageFontSize: newSize });
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
          <div className="px-4 py-3.5 border-t border-border">
            <label className="text-sm font-medium text-foreground block mb-3">
              {t('settings.appearance.fontSize')}
            </label>
            <SettingsSegmented
              value={messageFontSize}
              onValueChange={(v) => applyMessageFontSize(v as "small" | "medium" | "large")}
              options={[
                { value: "small", label: t('settings.appearance.fontSizeSmall') },
                { value: "medium", label: t('settings.appearance.fontSizeMedium') },
                { value: "large", label: t('settings.appearance.fontSizeLarge') },
              ]}
            />
          </div>
        </SettingsCard>
      </SettingsSection>


    </div>
  );
}
