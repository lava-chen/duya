"use client";

/**
 * BotModelField — model selector for the bot create/edit dialogs.
 *
 * A plain grouped `<select>` (provider → models). A native select is used
 * instead of the composer's ModelProviderSelector because its flyout would be
 * clipped by the dialog's scroll container. An empty value means "use the
 * global default model".
 */

import { useTranslation } from "@/hooks/useTranslation";
import type { ProviderModelGroup } from "@/components/chat/ModelProviderSelector";
import { prefixedToRaw } from "@/lib/bot-model-options";

export interface BotModelFieldProps {
  /** Selected raw model id (`''` = use global default). */
  value: string;
  groups: ProviderModelGroup[];
  loading?: boolean;
  onChange: (raw: string) => void;
  /**
   * Synthetic option guaranteeing `value` always has a matching option —
   * used by the edit dialog when the configured model is no longer exposed
   * by any provider, so saving without touching the field keeps it intact.
   */
  extraOption?: string;
}

export function BotModelField({
  value,
  groups,
  loading,
  onChange,
  extraOption,
}: BotModelFieldProps) {
  const { t } = useTranslation();
  const hasExtra =
    !!extraOption &&
    value === extraOption &&
    !groups.some((g) => g.models.some((m) => prefixedToRaw(m.id) === extraOption));

  return (
    <div className="mb-4">
      <div className="text-sm font-medium mb-1.5" style={{ color: "var(--text)" }}>
        {t("bot.create.model")}
      </div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={loading}
        className="w-full rounded-lg px-3 py-2 text-sm"
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          color: "var(--text)",
        }}
      >
        <option value="">{t("bot.create.modelDefault")}</option>
        {hasExtra && extraOption ? (
          <option value={extraOption}>{extraOption}</option>
        ) : null}
        {groups.map((group) => (
          <optgroup key={group.id} label={group.name}>
            {group.models.map((m) => (
              <option key={m.id} value={prefixedToRaw(m.id)}>
                {m.display_name}
              </option>
            ))}
          </optgroup>
        ))}
        {!loading && groups.length === 0 && !hasExtra ? (
          <option value="" disabled>
            {t("bot.create.modelUnavailable")}
          </option>
        ) : null}
      </select>
    </div>
  );
}
