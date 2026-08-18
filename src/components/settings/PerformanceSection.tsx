"use client";

import { useTranslation } from "@/hooks/useTranslation";
import { useLowPower, useLowPowerMode, setLowPowerMode } from "@/stores/low-power-store";
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsCardFooter,
} from "@/components/settings/ui";
import { SettingsSegmented } from "@/components/settings/ui/SettingsSegmented";
import { LightningIcon, CheckCircleIcon } from "@/components/icons";

/**
 * Performance settings (plan 426 Phase 3.4).
 *
 * Three-state low-power switch: auto / on / off. Writes
 * `performance.lowPower` via the config port; main process services and
 * the agent server pick the new value up (services live, agent server
 * on next restart).
 */
export function PerformanceSection() {
  const { t } = useTranslation();
  const mode = useLowPowerMode();
  const enabled = useLowPower();

  return (
    <div className="space-y-6">
      <SettingsSection
        title={t("settings.performance.title")}
        description={t("settings.performance.description")}
        icon={<LightningIcon size={18} />}
      >
        <SettingsCard>
          <SettingsRow
            label={t("settings.performance.lowPower")}
            description={t("settings.performance.lowPowerDesc")}
          >
            <SettingsSegmented
              options={[
                { value: "auto", label: t("settings.performance.lowPower.auto") },
                { value: "on", label: t("settings.performance.lowPower.on") },
                { value: "off", label: t("settings.performance.lowPower.off") },
              ]}
              value={mode}
              onValueChange={(v) => setLowPowerMode(v as "auto" | "on" | "off")}
            />
          </SettingsRow>
          <SettingsCardFooter>
            <span className="inline-flex items-center gap-1.5 text-xs text-[var(--muted)]">
              <CheckCircleIcon
                size={14}
                className={enabled ? "text-emerald-500" : "text-[var(--muted)]"}
              />
              {enabled
                ? t("settings.performance.lowPowerActive")
                : t("settings.performance.lowPowerInactive")}
            </span>
          </SettingsCardFooter>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
