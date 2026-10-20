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
  type EffortOption,
} from "@/components/chat/ModelProviderSelector";
import type { ModelThinkingLevel } from "@duya/ai";
import type { TranslationKey } from "@/i18n";

/** Bot-level thinking levels (persisted to the contact / config). */
type BotReasoningLevel = 'off' | 'low' | 'medium' | 'high';

export interface BotModelSelectorFieldProps {
  /** Prefixed selector id (`[Provider] model`, raw fallback, '' = default). */
  value: string;
  groups: ProviderModelGroup[];
  loading?: boolean;
  /** Receives the prefixed selector id ('' = clear to the global default). */
  onChange: (selectorId: string) => void;
  /** Thinking level bound to the model; undefined → runtime default medium. */
  reasoning?: BotReasoningLevel | undefined;
  onReasoningChange?: (reasoning: BotReasoningLevel | undefined) => void;
  /** Show the "Manage providers" row (dialogs pass false). */
  showManageProviders?: boolean;
}

/** Standard bot-level thinking levels (auto / off / low / medium / high). */
const REASONING_OPTIONS: BotReasoningLevel[] = ['off', 'low', 'medium', 'high'];

export function BotModelSelectorField({
  value,
  groups,
  loading,
  onChange,
  reasoning,
  onReasoningChange,
  showManageProviders = false,
}: BotModelSelectorFieldProps) {
  const { t } = useTranslation();

  // Surface the reasoning field through the selector's built-in effort
  // flyout (labeled "Thinking"), so the trigger reads "<model> · <level>"
  // and the level is bound alongside the model. An explicit level is shown
  // literally; 'auto' (empty) means follow the runtime default (medium).
  const effortOptions: EffortOption[] = [
    { value: '', label: t('messageInput.effortAuto') },
    ...REASONING_OPTIONS.map((level) => ({
      value: level,
      label: level === 'off' ? t('messageInput.effortOff') : getReasoningLabel(t, level),
    })),
  ];
  const effortValue: string | null = reasoning ?? '';
  const handleSelectEffort = (level: string | null) => {
    onReasoningChange?.((level && REASONING_OPTIONS.includes(level as BotReasoningLevel)
      ? level
      : undefined) as BotReasoningLevel | undefined);
  };

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
          effortValue={effortValue}
          effortOptions={onReasoningChange ? effortOptions : []}
          onSelectEffort={handleSelectEffort}
          loading={loading}
          portal
          clearOption={t("bot.create.modelDefault")}
          showManageProviders={showManageProviders}
        />
      </div>
    </div>
  );
}

function getReasoningLabel(
  t: (key: TranslationKey) => string,
  level: ModelThinkingLevel,
): string {
  switch (level) {
    case 'off': return t('messageInput.effortOff');
    case 'low': return t('messageInput.effortLow');
    case 'medium': return t('messageInput.effortMedium');
    case 'high': return t('messageInput.effortHigh');
    default: return t('messageInput.effortAuto');
  }
}
