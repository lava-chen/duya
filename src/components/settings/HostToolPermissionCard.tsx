"use client";

/**
 * Plan 487 — host-level standing permission switch (UI).
 *
 * 3-state segmented control wired directly to the electron settings IPC.
 * Persists immediately on click; triggers `agent:reinit-provider` under the
 * hood so running sessions pick up the change without an app restart.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import {
  SettingsCard,
  SettingsCardFooter,
  SettingsRow,
  SettingsSegmented,
} from "@/components/settings/ui";
import { AlertIcon } from "@/components/icons";

export type LocalToolPermission = "ask" | "always" | "never";

interface HostToolPermissionCardProps {
  value?: LocalToolPermission;
  onChange?: (value: LocalToolPermission) => void;
}

export function HostToolPermissionCard({
  value: controlledValue,
  onChange: controlledOnChange,
}: HostToolPermissionCardProps = {}) {
  const { t } = useTranslation();
  const [internalValue, setInternalValue] = useState<LocalToolPermission>("ask");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isControlled = controlledValue !== undefined;
  const value = isControlled ? controlledValue : internalValue;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (typeof window === "undefined" || !window.electronAPI?.settings?.getHostToolPermission) {
        setLoading(false);
        return;
      }
      try {
        const result = await window.electronAPI.settings.getHostToolPermission();
        if (cancelled) return;
        if (result.success) {
          if (!isControlled) setInternalValue(result.value);
        } else {
          setError(result.error ?? "Failed to load");
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [isControlled]);

  const handleChange = useCallback(
    async (next: string) => {
      if (next !== "ask" && next !== "always" && next !== "never") return;
      const previous = value;
      if (!isControlled) setInternalValue(next);
      controlledOnChange?.(next);
      setError(null);
      setSaving(true);
      try {
        if (typeof window !== "undefined" && window.electronAPI?.settings?.setHostToolPermission) {
          const result = await window.electronAPI.settings.setHostToolPermission(next);
          if (!result.success) throw new Error(result.error ?? "Failed to save");
        }
      } catch (err) {
        if (!isControlled) setInternalValue(previous);
        controlledOnChange?.(previous);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    },
    [value, isControlled, controlledOnChange],
  );

  return (
    <SettingsCard>
      <SettingsRow
        label={t("settings.hostToolPermission.title")}
        description={t("settings.hostToolPermission.description")}
      >
        <SettingsSegmented
          value={value}
          onValueChange={handleChange}
          disabled={loading || saving}
          options={[
            { value: "ask", label: t("settings.hostToolPermission.ask") },
            { value: "always", label: t("settings.hostToolPermission.always") },
            { value: "never", label: t("settings.hostToolPermission.never") },
          ]}
        />
      </SettingsRow>

      {value === "always" && (
        <SettingsCardFooter className="flex items-start gap-2 text-amber-600 dark:text-amber-400">
          <AlertIcon size={16} className="mt-0.5 shrink-0" />
          <p className="text-xs leading-relaxed">
            {t("settings.hostToolPermission.warningAlways")}
          </p>
        </SettingsCardFooter>
      )}

      {value === "never" && (
        <SettingsCardFooter className="flex items-start gap-2 text-muted-foreground">
          <AlertIcon size={16} className="mt-0.5 shrink-0" />
          <p className="text-xs leading-relaxed">
            {t("settings.hostToolPermission.noteNever")}
          </p>
        </SettingsCardFooter>
      )}

      {error && (
        <SettingsCardFooter className="text-destructive">
          <p className="text-xs">{error}</p>
        </SettingsCardFooter>
      )}
    </SettingsCard>
  );
}
