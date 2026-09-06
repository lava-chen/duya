"use client";

/**
 * BotModelSelectorField — model field for the bot settings forms (create /
 * edit dialog + bot-settings side panel). Wraps the composer's
 * ModelProviderSelector in a bordered form field; the selector opens through
 * a portal so its flyout is not clipped by the dialog / panel scroll
 * containers (the reason the old native `<select>` existed).
 */

import { useTranslation } from "@/hooks/useTranslation";
import {
  ModelProviderSelector,
  type ProviderModelGroup,
} from "@/components/chat/ModelProviderSelector";

export interface BotModelSelectorFieldProps {
  /** Prefixed selector id (`[Provider] model`, raw fallback, '' = default). */
  value: string;
  groups: ProviderModelGroup[];
  loading?: boolean;
  /** Receives the prefixed selector id ('' = clear to the global default). */
  onChange: (selectorId: string) => void;
  /** Show the "Manage providers" row (dialogs pass false). */
  showManageProviders?: boolean;
}

export function BotModelSelectorField({
  value,
  groups,
  loading,
  onChange,
  showManageProviders = false,
}: BotModelSelectorFieldProps) {
  const { t } = useTranslation();
  return (
    <div className="mb-4">
      <div className="text-sm font-medium mb-1.5" style={{ color: "var(--text)" }}>
        {t("bot.create.model")}
      </div>
      <div
        className="w-full rounded-lg px-2 py-1"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
      >
        <ModelProviderSelector
          providerGroups={groups}
          selectedModelId={value}
          onSelectModel={onChange}
          effortOptions={[]}
          onSelectEffort={() => {}}
          loading={loading}
          portal
          clearOption={t("bot.create.modelDefault")}
          showManageProviders={showManageProviders}
        />
      </div>
    </div>
  );
}
