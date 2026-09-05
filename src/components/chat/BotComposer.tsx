'use client';

/**
 * BotComposer.tsx — Telegram-style chat input for BotDirectChatView.
 *
 * Visual consistency with the Session ChatView (MessageInput):
 *   - Rounded shell with a clean input row: [plus] [textarea] [model] [send/stop]
 *   - Auto-expanding textarea (mirror-div technique, max 120px)
 *   - Send enabled only when there is non-whitespace text
 *   - Stop (■) shown while the bot is streaming
 *
 * Reuses the session composer's components (2026-09-05):
 *   - ModelProviderSelector — cascading provider/model/effort picker
 *   - SlashCommandPopover + useSlashCommands — the `+` button opens the same
 *     `@` context popup as the session (添加附件 + modes). `/`-typed command
 *     mode is intentionally NOT wired here: a 1:1 bot chat has no session
 *     settings (compaction / recap / output style) to surface.
 *   - useAttachments — the session's unified attachment state (files/images).
 *
 * Props:
 *   disabled    — true when the bot has no bound session
 *   busy        — true while streaming or queued
 *   onSend      — called with a BotComposerSendPayload when the user sends
 *   onStop      — called when user clicks Stop
 */

import React, { useRef, useCallback, useState, useMemo, useEffect } from 'react';
import { PaperclipIcon, ArrowUpIcon, PlusIcon, XIcon } from '@/components/icons';
import { IconButton } from '@/components/ui/IconButton';
import { useTranslation } from '@/hooks/useTranslation';
import { useBotDraft } from './bot/draft';
import { useAttachments } from '@/hooks/useAttachments';
import {
  ModelProviderSelector,
  type ModelOption,
  type ProviderModelGroup,
} from './ModelProviderSelector';
import { SlashCommandPopover } from './SlashCommandPopover';
import { useSlashCommands } from '@/hooks/useSlashCommands';
import { filterItems } from '@/lib/message-input-logic';
import { listProvidersIPC, type Provider } from '@/lib/ipc-client';
import { isKeylessLocalProvider } from '@/lib/providers';
import { modelCapabilityService } from '@/lib/providers/models/ModelCapabilityService';
import { getEffortOptionsForCapability, getEffortOptionsForModel } from '@duya/ai';
import type { PopoverItem, PopoverMode } from '@/types/slash-command';
import type { ModeModifierId } from '@/types/mode-id';
import { MODE_KIND, toggleModeInSet, isModeExcludedByActive } from '@/types/mode-id';
import type { FileAttachment } from '@/types/message';

export interface BotComposerSendPayload {
  text: string;
  /** Raw model id (no `[provider] ` prefix). Absent → server uses the bot default. */
  model?: string;
  providerId?: string;
  /** Anthropic thinking effort level (low/medium/high/max). */
  effort?: string;
  /** Message-level mode (plan-task / research / ...). */
  mode?: string;
  /** User-attached files (files/images). */
  files?: FileAttachment[];
}

interface BotComposerProps {
  /** Bot session ID for draft persistence key */
  botId?: string | null;
  disabled?: boolean;
  busy?: boolean;
  onSend: (payload: BotComposerSendPayload) => void;
  onStop?: () => void;
  placeholder?: string;
}

/**
 * Message-level mode for the send payload: goal wins, otherwise the first
 * non-conductor active mode (conductor is session-level, not per-message).
 */
function pickSendMode(activeModes: Set<ModeModifierId>): string | undefined {
  if (activeModes.has('goal')) return 'goal';
  for (const mode of activeModes) {
    if (mode !== 'conductor') return mode;
  }
  return undefined;
}

/** Keep session-level modes (conductor, plan-task); clear per-message ones. */
function clearMessageModes(prev: Set<ModeModifierId>): Set<ModeModifierId> {
  const next = new Set<ModeModifierId>();
  for (const mode of prev) {
    if (MODE_KIND[mode] === 'session') next.add(mode);
  }
  return next;
}

/** Inline labels for thinking levels not covered by i18n keys. */
const EFFORT_LABELS: Partial<Record<string, string>> = {
  minimal: 'Minimal',
  xhigh: 'Extra High',
};

/** Effort options for a model (mirrors MessageInput's useEffortOptions). */
function effortOptionsFor(
  t: (key: 'messageInput.effortAuto' | 'messageInput.effortLow' | 'messageInput.effortMedium' | 'messageInput.effortHigh' | 'messageInput.effortMax') => string,
  modelId?: string,
  capability?: {
    supportsReasoning?: boolean;
    reasoningEffortOptions?: string[];
  } | null,
): Array<{ value: string; label: string }> {
  if (capability) {
    const capOptions = getEffortOptionsForCapability(capability);
    if (capOptions) {
      return capOptions.map((opt) => {
        const inline = EFFORT_LABELS[opt.level];
        return { value: opt.value, label: inline || opt.level };
      });
    }
  }
  if (modelId) {
    const modelOptions = getEffortOptionsForModel(modelId);
    if (modelOptions) {
      return modelOptions.map((opt) => {
        const inline = EFFORT_LABELS[opt.level];
        if (inline) return { value: opt.value, label: inline };
        switch (opt.level) {
          case 'off': return { value: opt.value, label: t('messageInput.effortAuto') };
          case 'low': return { value: opt.value, label: t('messageInput.effortLow') };
          case 'medium': return { value: opt.value, label: t('messageInput.effortMedium') };
          case 'high': return { value: opt.value, label: t('messageInput.effortHigh') };
          case 'max': return { value: opt.value, label: t('messageInput.effortMax') };
          default: return { value: opt.value, label: opt.level };
        }
      });
    }
  }
  return [
    { value: '', label: t('messageInput.effortAuto') },
    { value: 'low', label: t('messageInput.effortLow') },
    { value: 'medium', label: t('messageInput.effortMedium') },
    { value: 'high', label: t('messageInput.effortHigh') },
    { value: 'max', label: t('messageInput.effortMax') },
  ];
}

export function BotComposer({
  botId,
  disabled = false,
  busy = false,
  onSend,
  onStop,
  placeholder,
}: BotComposerProps) {
  const { t } = useTranslation();
  // Plan 491 P2.1: Use bot draft hook for persistence per botId
  const { draft, setDraft, clearDraft } = useBotDraft(botId ?? null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Plan 220 Phase 4: unified attachment state (reused from the session).
  const {
    attachments,
    addFile,
    remove: removeAttachment,
    clear: clearAttachments,
  } = useAttachments();

  // ---------------------------------------------------------------------------
  // Model / provider / effort state — mirrors MessageInput's selector wiring.
  // ---------------------------------------------------------------------------
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [selectedEffort, setSelectedEffort] = useState<string | undefined>(undefined);
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [hasProvider, setHasProvider] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  // Map prefixed model id (`[Provider] model`) → provider id.
  const [modelProviderMap, setModelProviderMap] = useState<Map<string, string>>(new Map());

  // Fetch available models from providers API (same source as MessageInput).
  const fetchModels = useCallback(async () => {
    setModelsLoading(true);
    try {
      const providersList = await listProvidersIPC();
      if (providersList && providersList.length > 0) {
        providersList.forEach((p) => {
          const pAny = p as Provider & Record<string, unknown>;
          const hasKey = pAny.hasApiKey ?? pAny.has_api_key ?? !!(p.apiKey && p.apiKey.length > 0);
          if (pAny.hasApiKey === undefined && hasKey) {
            (p as Provider & { hasApiKey: boolean }).hasApiKey = hasKey;
          }
        });

        if (providersList.some(
          (p) => p.hasApiKey || isKeylessLocalProvider(p.providerType, p.baseUrl),
        )) {
          setHasProvider(true);
        }

        // Collect models from all providers (enabled_models / defaultModel only).
        const allModels: ModelOption[] = [];
        const modelIds = new Set<string>();
        const providerMap = new Map<string, string>();

        for (const provider of providersList) {
          if (!provider.hasApiKey && !isKeylessLocalProvider(provider.providerType, provider.baseUrl)) {
            continue;
          }
          let enabledModels: string[] = [];
          try {
            const opts = JSON.parse(provider.options || '{}');
            if (opts.enabled_models && Array.isArray(opts.enabled_models) && opts.enabled_models.length > 0) {
              enabledModels = opts.enabled_models;
            } else if (typeof opts.defaultModel === 'string' && opts.defaultModel.length > 0) {
              enabledModels = [opts.defaultModel];
            }
          } catch { /* ignore */ }

          for (const id of enabledModels) {
            const cleanId = id.startsWith('"') && id.endsWith('"') ? id.slice(1, -1) : id;
            const providerName = provider.name || provider.providerType || provider.id;
            const prefixedId = `[${providerName}] ${cleanId}`;
            if (modelIds.has(prefixedId)) continue;
            modelIds.add(prefixedId);
            const cap = modelCapabilityService.getModelCapability(provider.id, cleanId);
            allModels.push({
              id: prefixedId,
              display_name: cleanId,
              ...(cap?.contextWindow && cap.contextWindow > 0
                ? { context_length: cap.contextWindow }
                : {}),
              ...(cap?.supportsVision !== undefined
                ? { supportsVision: cap.supportsVision }
                : {}),
              ...(cap?.supportsToolUse !== undefined
                ? { supportsToolUse: cap.supportsToolUse }
                : {}),
              ...(cap?.supportsReasoning !== undefined
                ? { supportsReasoning: cap.supportsReasoning }
                : {}),
              ...(cap?.reasoningEffortOptions !== undefined && cap.reasoningEffortOptions.length > 0
                ? { reasoningEffortOptions: cap.reasoningEffortOptions }
                : {}),
              ...(cap?.isLoaded === true ? { isLoaded: true } : {}),
            });
            providerMap.set(prefixedId, provider.id);
          }
        }

        setAvailableModels(allModels);
        setProviders(
          providersList.filter(
            (p) => p.hasApiKey || isKeylessLocalProvider(p.providerType, p.baseUrl),
          ),
        );
        setModelProviderMap(providerMap);
        setModelsLoading(false);
        return;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[BotComposer] Error fetching providers:', err);
    }
    setHasProvider(false);
    setAvailableModels([]);
    setModelsLoading(false);
  }, []);

  // Fetch models on mount + retry + refresh on window focus (mirrors MessageInput).
  useEffect(() => {
    fetchModels();
    const retryTimer = setTimeout(() => {
      if (!hasProvider) fetchModels();
    }, 2000);
    const fallbackTimer = setTimeout(() => {
      if (!hasProvider) fetchModels();
    }, 5000);
    const handleFocus = () => fetchModels();
    window.addEventListener('focus', handleFocus);
    return () => {
      clearTimeout(retryTimer);
      clearTimeout(fallbackTimer);
      window.removeEventListener('focus', handleFocus);
    };
  }, [fetchModels, hasProvider]);

  // Group models by provider for the multi-level ModelProviderSelector.
  const providerGroups: ProviderModelGroup[] = useMemo(
    () =>
      providers
        .map((provider) => {
          const providerName = provider.name || provider.providerType || provider.id;
          const prefix = `[${providerName}] `;
          const models = availableModels.filter((m) => m.id.startsWith(prefix));
          return { id: provider.id, name: providerName, models };
        })
        .filter((g) => g.models.length > 0),
    [providers, availableModels],
  );

  // Raw model id (no provider prefix) used to resolve thinking-effort options.
  const rawSelectedModelId = useMemo(() => {
    const match = selectedModel.match(/^\[([^\]]+)\]\s*(.+)$/);
    return match ? match[2] : selectedModel;
  }, [selectedModel]);

  const selectedModelCapability = useMemo(() => {
    if (!rawSelectedModelId) return null;
    const providerId = modelProviderMap.get(selectedModel);
    if (!providerId) return null;
    return modelCapabilityService.getModelCapability(providerId, rawSelectedModelId);
  }, [rawSelectedModelId, selectedModel, modelProviderMap]);

  const modelEffortOptions = useMemo(
    () => effortOptionsFor(t, rawSelectedModelId, selectedModelCapability),
    [t, rawSelectedModelId, selectedModelCapability],
  );

  const handleModelChange = useCallback((modelId: string) => {
    setSelectedModel(modelId);
  }, []);

  const handleEffortChange = useCallback((value: string | null) => {
    setSelectedEffort(value || undefined);
  }, []);

  // ---------------------------------------------------------------------------
  // Plus-button context popover — reuses the session's SlashCommandPopover.
  // ---------------------------------------------------------------------------
  const [popoverMode, setPopoverMode] = useState<PopoverMode>(null);
  const [popoverItems, setPopoverItems] = useState<PopoverItem[]>([]);
  const [popoverFilter, setPopoverFilter] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [triggerPos, setTriggerPos] = useState<number | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const closePopover = useCallback(() => {
    setPopoverMode(null);
    setPopoverItems([]);
    setPopoverFilter('');
    setSelectedIndex(0);
    setTriggerPos(null);
  }, []);

  const filteredItems =
    popoverMode === 'skill' || popoverMode === 'context'
      ? filterItems(popoverItems, popoverFilter)
      : popoverItems;

  const { insertItem, contextItems } = useSlashCommands({
    textareaRef,
    inputValue: draft,
    setInputValue: setDraft,
    popoverMode,
    popoverFilter,
    triggerPos,
    setPopoverMode,
    setPopoverFilter,
    setPopoverItems,
    setSelectedIndex,
    setTriggerPos,
    closePopover,
    sessionId: botId ?? undefined,
  });

  // Open the `@` context popup (添加附件 + modes) — the plus button opens this
  // directly, exactly like MessageInput's openContextPopover.
  const openContextPopover = useCallback(() => {
    setPopoverMode('context');
    setPopoverFilter('');
    setTriggerPos(null);
    setSelectedIndex(0);
    setPopoverItems(contextItems);
  }, [contextItems]);

  // Mode toggling for the context popover (visual state only — the agent
  // server resolves the actual per-run mode from the payload).
  const [activeModes, setActiveModes] = useState<Set<ModeModifierId>>(new Set());
  const handleToggleMode = useCallback((mode: ModeModifierId) => {
    setActiveModes((prev) => {
      if (!prev.has(mode) && isModeExcludedByActive(prev, mode)) return prev;
      return toggleModeInSet(prev, mode);
    });
  }, []);

  // ---------------------------------------------------------------------------
  // Auto-resize + submit
  // ---------------------------------------------------------------------------
  const resizeTextarea = useCallback(() => {
    const ta = textareaRef.current;
    const mirror = mirrorRef.current;
    if (!ta || !mirror) return;
    mirror.textContent = ta.value + '\n';
    const newHeight = Math.min(mirror.scrollHeight, 120);
    ta.style.height = `${newHeight}px`;
  }, []);

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value);
    resizeTextarea();
  };

  const handleSend = useCallback(() => {
    const text = draft.trim();
    if (!text || disabled || busy) return;
    const match = selectedModel.match(/^\[([^\]]+)\]\s*(.+)$/);
    const rawModel = match ? match[2] : selectedModel;
    const providerId = modelProviderMap.get(selectedModel);
    const mode = pickSendMode(activeModes);
    onSend({
      text,
      model: rawModel || undefined,
      providerId,
      effort: selectedEffort,
      mode,
      files: attachments.length > 0 ? attachments : undefined,
    });
    clearDraft();
    clearAttachments();
    setActiveModes((prev) => clearMessageModes(prev));
    // Reset height after clearing
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    if (mirrorRef.current) mirrorRef.current.textContent = '';
  }, [
    draft, disabled, busy, onSend, selectedModel, modelProviderMap,
    selectedEffort, activeModes, attachments, clearDraft, clearAttachments,
  ]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    if (!input.files) return;
    for (const file of Array.from(input.files)) {
      await addFile(file);
    }
    input.value = '';
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Keyboard navigation when the context popover is open.
    if (popoverMode && popoverMode !== 'cli' && filteredItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % filteredItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + filteredItems.length) % filteredItems.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const item = filteredItems[selectedIndex];
        if (!item) return;
        switch (item.kind) {
          case 'settings_action':
            if (item.value === '__add_files') {
              fileInputRef.current?.click();
            }
            closePopover();
            return;
          case 'mode': {
            const modeValue = item.modeValue as ModeModifierId | undefined;
            if (modeValue) handleToggleMode(modeValue);
            return;
          }
          default:
            insertItem(item);
            return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closePopover();
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  const canSend = !disabled && !busy && draft.trim().length > 0;
  const placeholderText = placeholder || t('bot.chat.placeholder');
  const plusActive = popoverMode === 'context';

  return (
    <div className="bot-chat-composer">
      <div className="bot-chat-composer__shell">
        {/* Reused session context popover (plus button → 添加附件 + modes). */}
        {popoverMode && (
          <SlashCommandPopover
            popoverMode={popoverMode}
            popoverRef={popoverRef}
            filteredItems={filteredItems}
            selectedIndex={selectedIndex}
            popoverFilter={popoverFilter}
            inputValue={draft}
            triggerPos={triggerPos}
            searchInputRef={searchInputRef}
            allDisplayedItems={filteredItems}
            // Settings state (stubbed — the context popover for a bot only
            // surfaces files + modes, not session settings).
            thinkingEffort={selectedEffort ?? null}
            onSelectThinkingEffort={handleEffortChange}
            modelId={rawSelectedModelId}
            providerId={modelProviderMap.get(selectedModel)}
            responseStyles={[]}
            selectedStyle={null}
            onSelectStyle={() => {}}
            mcpServers={[]}
            onToggleMcpServer={() => {}}
            onAddFiles={() => fileInputRef.current?.click()}
            onRequestRecap={async () => ({ success: false, recap: null, error: 'Unsupported for bot chat' })}
            activeModes={activeModes}
            onToggleMode={handleToggleMode}
            onInsertItem={insertItem}
            onSetSelectedIndex={setSelectedIndex}
            onSetPopoverFilter={setPopoverFilter}
            onSetInputValue={setDraft}
            onClosePopover={closePopover}
            onFocusTextarea={() => textareaRef.current?.focus()}
          />
        )}

        {/* Attachment chips above the input (files picked via + / attach). */}
        {attachments.length > 0 && (
          <div className="bot-chat-composer__chips">
            {attachments.map((a) => (
              <span key={a.id} className="bot-chat-composer__chip" title={a.path ?? a.name}>
                <span className="bot-chat-composer__chip-name">{a.name}</span>
                <button
                  type="button"
                  className="bot-chat-composer__chip-remove"
                  onClick={() => removeAttachment(a.id)}
                  aria-label={t('bot.chat.removeAttachment')}
                >
                  <XIcon size={12} />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Field on top: mirror + auto-resizing textarea (grok prompt-shell). */}
        <div className="bot-chat-composer__input-area">
          {/* Mirror div — invisible, measures text height for auto-resize */}
          <div
            ref={mirrorRef}
            className="bot-chat-composer__mirror"
            aria-hidden="true"
          />
          <textarea
            ref={textareaRef}
            className="bot-chat-composer__input"
            value={draft}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder={placeholderText}
            disabled={disabled}
            rows={1}
            aria-label={placeholderText}
          />
        </div>

        {/* Actions row below: plus/attach left, model + send right (mirrors the
            session MessageInput toolbar). */}
        <div className="bot-chat-composer__actions">
          <div className="bot-chat-composer__actions-left">
            {/* Plus Button — opens the `@` context popup (添加附件 / modes),
                reusing the session's plus button behavior. */}
            <IconButton
              variant="ghost"
              shape="square"
              size="md"
              aria-label={t('common.settings') || 'Settings'}
              data-plus-trigger
              onClick={() => {
                if (plusActive) {
                  closePopover();
                } else {
                  openContextPopover();
                }
              }}
              className={`border ${
                plusActive
                  ? 'text-foreground bg-chip border-border'
                  : 'text-muted-foreground border-transparent hover:text-foreground hover:bg-accent/50'
              }`}
              title={t('common.settings') || 'Settings'}
              disabled={disabled || busy}
            >
              <PlusIcon size={16} />
            </IconButton>

            {/* Quick attach — direct file picker (grok paperclip). */}
            <button
              type="button"
              className="bot-chat-composer__attach"
              onClick={() => fileInputRef.current?.click()}
              aria-label={t('bot.chat.attach')}
              title={t('bot.chat.attach')}
              disabled={disabled || busy}
            >
              <PaperclipIcon size={16} />
            </button>
          </div>

          <div className="bot-chat-composer__actions-right">
            {/* Model / Provider / Effort selector — reuses the session component. */}
            {hasProvider && providerGroups.length > 0 && (
              <ModelProviderSelector
                providerGroups={providerGroups}
                selectedModelId={selectedModel}
                onSelectModel={handleModelChange}
                effortValue={selectedEffort}
                effortOptions={modelEffortOptions}
                onSelectEffort={handleEffortChange}
                disabled={disabled || busy}
                loading={modelsLoading}
              />
            )}

            {busy && onStop ? (
              <button
                type="button"
                className="bot-chat-composer__send bot-chat-composer__send--stop"
                onClick={onStop}
                aria-label={t('bot.chat.stop')}
                title={t('bot.chat.stop')}
              >
                ■
              </button>
            ) : (
              <button
                type="button"
                className="bot-chat-composer__send"
                onClick={handleSend}
                disabled={!canSend}
                aria-label={t('bot.chat.send')}
                title={t('bot.chat.send')}
              >
                <ArrowUpIcon size={16} />
              </button>
            )}
          </div>
        </div>

        {/* Hidden file input shared by the plus popover's 添加附件 and the attach button. */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileChange}
        />
      </div>
    </div>
  );
}
