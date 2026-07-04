// MessageInput.tsx - Message input component with file attachments, model/effort selection, and badge support

'use client';

import React, { useState, useRef, useCallback, KeyboardEvent, FormEvent, useEffect } from 'react';
import { ArrowUpIcon,
  SearchIcon,
  XIcon,
  StopIcon,
  XCircleIcon,
  PaperclipIcon,
  PlusIcon,
} from '@/components/icons';
import { Select } from 'antd';
import type { CliBadge, PopoverItem, PopoverMode } from '@/types/slash-command';
import { FileAttachment } from '@/types/message';
import {
  buildCliAppend,
  resolveDirectSlash,
  filterItems,
} from '@/lib/message-input-logic';
import { ModelSelector, type ModelOption } from './ModelSelector';
import { PermissionModeSelector, type PermissionMode } from './PermissionModeSelector';
import { useAttachments, makeFileTreeRefAttachment } from '@/hooks/useAttachments';
import { AttachmentBar } from './AttachmentBar';
import {
  dispatchAddAttachment,
  ADD_ATTACHMENT_EVENT,
  type AddAttachmentDetail,
} from '@/lib/add-attachment-event';
import { useTranslation } from '@/hooks/useTranslation';
import { listProvidersIPC, listOutputStylesIPC, type Provider } from '@/lib/ipc-client';
import { saveDraftIPC, getDraftIPC } from '@/lib/ipc-client';
import { useSlashCommands } from '@/hooks/useSlashCommands';
import { SlashCommandPopover } from './SlashCommandPopover';
import { ContextUsageRing } from './ContextUsageRing';
import { RichTextInput } from './RichTextInput';
import type { Message } from '@/types/message';

function getEditableCursorPosition(element: HTMLElement | null, fallback: number): number {
  if (!element) return fallback;
  if ('selectionStart' in element && typeof element.selectionStart === 'number') {
    return element.selectionStart;
  }
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return fallback;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.endContainer)) return fallback;
  const preRange = document.createRange();
  preRange.selectNodeContents(element);
  preRange.setEnd(range.endContainer, range.endOffset);
  return preRange.toString().length;
}

interface MessageInputProps {
  onSend: (
    content: string,
    files?: FileAttachment[],
    outputStyleConfig?: { name: string; prompt: string; keepCodingInstructions?: boolean } | null,
    mode?: string,
    displayContent?: string,
  ) => void;
  onCommand?: (command: string) => void;
  onStop?: () => void;
  disabled?: boolean;
  isStreaming?: boolean;
  hasQueuedMessages?: boolean;
  sessionId?: string;
  modelName?: string;
  onModelChange?: (model: string) => void;
  onProviderChange?: (providerId: string) => void;
  effort?: string;
  onEffortChange?: (effort: string | undefined) => void;
  permissionMode?: PermissionMode | null;
  onPermissionModeChange?: (mode: PermissionMode) => void;
  /**
   * selector 切 mode 后, IPC updateThreadIPC 落库期间为 true.
   * 发送按钮在此期间 disabled, 防止 row 未落库就发消息, 引发 worker 读到旧值.
   */
  permissionUpdatePending?: boolean;
  placeholder?: string;
  // Slash-command popover placement. Default `top` keeps the popup above the
  // input (chat history). Pass `bottom` on the welcome / start page where
  // there is more room below the input.
  popoverPlacement?: 'top' | 'bottom';
  // For chat commands (/help, /clear, /cost) - execute locally
  onExecuteCommand?: (command: string) => { content: string } | null;
  // For clearing messages (/clear)
  onClearMessages?: () => void;
  // Messages for context usage calculation
  messages?: Message[];
}

interface EffortOption {
  value: string;
  label: string;
}

function useEffortOptions(t: (key: 'messageInput.effortAuto' | 'messageInput.effortLow' | 'messageInput.effortMedium' | 'messageInput.effortHigh' | 'messageInput.effortMax') => string): EffortOption[] {
  return [
    { value: '', label: t('messageInput.effortAuto') },
    { value: 'low', label: t('messageInput.effortLow') },
    { value: 'medium', label: t('messageInput.effortMedium') },
    { value: 'high', label: t('messageInput.effortHigh') },
    { value: 'max', label: t('messageInput.effortMax') },
  ];
}

interface EffortSelectorProps {
  value: string | undefined;
  onChange: (value: string) => void;
}

function EffortSelector({ value, onChange }: EffortSelectorProps) {
  const { t } = useTranslation();
  const options = useEffortOptions(t);
  const selectedLabel = options.find(opt => opt.value === (value || ''))?.label || t('messageInput.effortAuto');

  return (
    <Select
      value={value || ''}
      onChange={onChange}
      variant="borderless"
      dropdownMatchSelectWidth={false}
      className="effort-selector"
      popupClassName="effort-dropdown"
      options={options.map(opt => ({
        value: opt.value,
        label: opt.label,
      }))}
    >
    </Select>
  );
}

export function MessageInput({
  onSend,
  onCommand,
  onStop,
  disabled = false,
  isStreaming = false,
  hasQueuedMessages = false,
  sessionId,
  modelName,
  onModelChange,
  onProviderChange,
  effort,
  onEffortChange,
  permissionMode = 'ask',
  onPermissionModeChange,
  permissionUpdatePending = false,
  placeholder,
  popoverPlacement = 'top',
  onExecuteCommand,
  onClearMessages,
  messages = [],
}: MessageInputProps) {
  const { t } = useTranslation();
  const [inputValue, setInputValue] = useState('');
  // Plan 220: hidden prompt prefix that panels inject via
  // `duya:set-hidden-prompt`. Sent to the LLM ahead of `inputValue`
  // but invisible to the user — keeps the input box showing only what
  // the user actually typed, while still routing auto-generated
  // context (e.g. file selection) to the model.
  const [hiddenPrompt, setHiddenPrompt] = useState<string>('');
  // Clean up double-quoted model names in initial value (legacy data cleanup)
  const cleanInitialModel = (modelName || '').replace(/^"|"$/g, '');
  const [selectedModel, setSelectedModel] = useState<string>(cleanInitialModel);
  const [selectedEffort, setSelectedEffort] = useState<string | undefined>(effort);
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [hasProvider, setHasProvider] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [activeProviderId, setActiveProviderId] = useState<string | null>(null);
  // Map model ID (with prefix) to provider ID
  const [modelProviderMap, setModelProviderMap] = useState<Map<string, string>>(new Map());
  const textareaRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasFetchedModels = useRef(false);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevSessionIdRef = useRef<string | undefined>(sessionId);
  const draftLoadedRef = useRef(false);
  const prePasteValueRef = useRef<string>('');

  useEffect(() => {
    prePasteValueRef.current = inputValue;
  }, [inputValue]);

  // CLI badge state (for AI-requested CLI tools)
  const [cliBadge, setCliBadge] = useState<CliBadge | null>(null);

  // Slash command popover state
  const [popoverMode, setPopoverMode] = useState<PopoverMode>(null);
  const [popoverItems, setPopoverItems] = useState<PopoverItem[]>([]);
  const [popoverFilter, setPopoverFilter] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [triggerPos, setTriggerPos] = useState<number | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Attachment menu state
  const [skills, setSkills] = useState<Array<{ name: string; description?: string; source?: string }>>([]);
  const [mcpServers, setMcpServers] = useState<Array<{ name: string; description?: string; enabled?: boolean }>>([]);
  const [responseStyles, setResponseStyles] = useState<Array<{ id: string; name: string; description?: string; prompt: string; keepCodingInstructions?: boolean; isBuiltin?: boolean }>>([]);
  const [selectedStyleId, setSelectedStyleId] = useState<string | null>(null);
  const [sendMode, setSendMode] = useState<string | undefined>(undefined);

  // Drag-and-drop state — counter ref avoids flicker when crossing child boundaries
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const dragCounterRef = useRef(0);

  const closePopover = useCallback(() => {
    setPopoverMode(null);
    setPopoverItems([]);
    setPopoverFilter('');
    setSelectedIndex(0);
    setTriggerPos(null);
  }, []);

  const filteredItems = popoverMode === 'skill' ? filterItems(popoverItems, popoverFilter) : popoverItems;

  const {
    insertItem,
    handleInputChange: handleSlashInputChange,
    openCommandPopover,
  } = useSlashCommands({
    textareaRef,
    inputValue,
    setInputValue,
    popoverMode,
    popoverFilter,
    triggerPos,
    setPopoverMode,
    setPopoverFilter,
    setPopoverItems,
    setSelectedIndex,
    setTriggerPos,
    closePopover,
    sessionId,
  });

  // Plan 220 Phase 4: unified attachment state. Single source of truth for
  // files, paste, terminal refs, browser refs, and file-tree refs. Replaces
  // the 5 separate state carriers (fileChips / terminalReferenceChips /
  // browserReferenceChips / pastedContents / attachedFiles) that existed
  // before this refactor.
  const {
    attachments,
    parseErrors,
    isParsing,
    addAttachment,
    addPastedText,
    addFile,
    addBrowserScreenshot,
    remove: removeAttachment,
    clear: clearAttachments,
    buildModelContent,
    buildDisplayContent,
    hasUnparsedDocs,
  } = useAttachments();

  // Plan 220 Phase 4: single listener for `duya:add-attachment` plus
  // legacy event name aliases (kept for one minor version per Plan 220
  // §Design). The legacy aliases just re-dispatch as the new event so
  // panels can migrate independently.
  useEffect(() => {
    const handleAddAttachment = (e: Event) => {
      const detail = (e as CustomEvent<AddAttachmentDetail>).detail;
      if (!detail) return;

      switch (detail.kind) {
        case 'pasted-text': {
          addPastedText(detail.text);
          break;
        }
        case 'file-tree-ref': {
          // Skip if a chip for this exact path + range is already
          // attached. Plan 220: range-scoped refs (with lineStart/
          // lineEnd) are deduplicated independently from path-only
          // refs, so a user can attach both the file and a selection.
          const already = attachments.some(
            (a) =>
              a.kind === 'file-tree-ref' &&
              a.path === detail.path &&
              (a.metadata as { lineStart?: number; lineEnd?: number } | undefined)
                ?.lineStart === detail.lineStart &&
              (a.metadata as { lineStart?: number; lineEnd?: number } | undefined)
                ?.lineEnd === detail.lineEnd,
          );
          if (already) break;
          addAttachment(
            makeFileTreeRefAttachment({
              path: detail.path,
              lineStart: detail.lineStart,
              lineEnd: detail.lineEnd,
              selectedText: detail.selectedText,
            }),
          );
          break;
        }
        case 'terminal-ref': {
          if (!detail.text?.trim()) break;
          addAttachment({
            id: crypto.randomUUID(),
            kind: 'terminal-ref',
            name: detail.shell,
            type: 'text/plain',
            url: '',
            size: detail.text.length,
            text: detail.text.trim(),
            previewText: (() => {
              const first =
                detail.text
                  .trim()
                  .split(/\r?\n/)
                  .find((line) => line.trim())?.trim() ?? 'Terminal selection';
              return first;
            })(),
            metadata: {
              shell: detail.shell,
              cwd: detail.cwd,
              createdAt: Date.now(),
            },
          });
          break;
        }
        case 'browser-ref': {
          const ref = detail.reference;
          const att =
            detail.attachment ??
            (ref.attachment
              ? { ...ref.attachment, kind: 'image' as const }
              : undefined);
          if (ref.kind === 'screenshot' && att) {
            addBrowserScreenshot(
              {
                elementKind: 'screenshot',
                label: ref.label,
                title: ref.title,
                url: ref.url,
                text: ref.content,
                attachmentId: att.id,
              },
              att,
            );
          } else {
            addAttachment({
              id: crypto.randomUUID(),
              kind: 'browser-ref',
              name: ref.label,
              type: 'text/plain',
              url: '',
              size: ref.content.length,
              text: ref.content,
              previewText: ref.title || ref.label,
              metadata: {
                url: ref.url,
                elementKind: ref.kind,
                title: ref.title,
              },
            });
          }
          break;
        }
        case 'file': {
          addAttachment(detail.file);
          break;
        }
        default: {
          // Exhaustive check — invalid kind does nothing.
          break;
        }
      }

      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        adjustTextareaHeight();
      });
    };

    window.addEventListener(ADD_ATTACHMENT_EVENT, handleAddAttachment as EventListener);

    // Legacy alias listeners: re-dispatch under the new event name so
    // existing panels keep working without modification.
    const legacyFileTree = (e: Event) => {
      const detail = (e as CustomEvent<{
        path: string;
        lineStart?: number;
        lineEnd?: number;
        selectedText?: string;
      }>).detail;
      if (detail?.path) {
        dispatchAddAttachment({
          kind: 'file-tree-ref',
          path: detail.path,
          lineStart: detail.lineStart,
          lineEnd: detail.lineEnd,
          selectedText: detail.selectedText,
        });
      }
    };
    const legacyTerminal = (e: Event) => {
      const detail = (e as CustomEvent<{ shell: string; cwd: string; text: string }>).detail;
      if (detail) {
        dispatchAddAttachment({
          kind: 'terminal-ref',
          shell: detail.shell,
          cwd: detail.cwd,
          text: detail.text,
        });
      }
    };
    const legacyBrowser = (e: Event) => {
      const detail = (e as CustomEvent<{
        text?: string;
        attachment?: FileAttachment;
        reference?: {
          kind: 'element' | 'screenshot';
          label: string;
          title: string;
          url: string;
          content: string;
          attachmentId?: string;
        };
      }>).detail;
      if (!detail) return;
      if (detail.reference) {
        const ref = detail.reference;
        dispatchAddAttachment({
          kind: 'browser-ref',
          reference: {
            kind: ref.kind,
            label: ref.label,
            title: ref.title,
            url: ref.url,
            content: ref.content,
            attachment: detail.attachment,
          },
          attachment: detail.attachment,
        });
      } else if (detail.text) {
        // Plain text insert (legacy) — fall through to typed text path.
        // We surface this as a terminal-ref for parity, but with empty shell/cwd
        // the attachment's preview line becomes the text itself.
        dispatchAddAttachment({
          kind: 'terminal-ref',
          shell: 'browser',
          cwd: '',
          text: detail.text,
        });
      }
    };

    window.addEventListener('file-tree-add-to-input', legacyFileTree as EventListener);
    window.addEventListener('terminal-add-to-input', legacyTerminal as EventListener);
    window.addEventListener('browser-add-to-input', legacyBrowser as EventListener);

    // Plan 220: `duya:set-hidden-prompt` lets panels inject a context
    // prefix that the LLM will see ahead of the user's typed input,
    // but the user themselves does NOT see in the input box. The
    // prompt is cleared on the next send (so the next message starts
    // fresh) and is appended by `buildModelContent` during submit.
    const handleSetHiddenPrompt = (e: Event) => {
      const detail = (e as CustomEvent<{ value: string }>).detail;
      if (typeof detail?.value === 'string') {
        setHiddenPrompt(detail.value);
        requestAnimationFrame(() => {
          textareaRef.current?.focus();
          adjustTextareaHeight();
        });
      }
    };
    window.addEventListener('duya:set-hidden-prompt', handleSetHiddenPrompt as EventListener);

    return () => {
      window.removeEventListener(ADD_ATTACHMENT_EVENT, handleAddAttachment as EventListener);
      window.removeEventListener('file-tree-add-to-input', legacyFileTree as EventListener);
      window.removeEventListener('terminal-add-to-input', legacyTerminal as EventListener);
      window.removeEventListener('browser-add-to-input', legacyBrowser as EventListener);
      window.removeEventListener('duya:set-hidden-prompt', handleSetHiddenPrompt as EventListener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachments]);

  // Build content with attachments + hidden prompt baked in. The
  // `hiddenPrompt` is the auto-injected context that the LLM should
  // see but the user does NOT (it stays out of the inputValue they
  // edit). `buildModelContent` from the hook handles the 5 attachment
  // kinds; we prepend the hidden prompt here.
  const buildContentWithChips = useCallback(
    (textValue: string): string => {
      const base = buildModelContent(textValue);
      if (hiddenPrompt && hiddenPrompt.trim()) {
        return `${hiddenPrompt}\n\n${base}`;
      }
      return base;
    },
    [buildModelContent, hiddenPrompt],
  );

  const buildDisplayContentWithChips = useCallback(
    (textValue: string): string => buildDisplayContent(textValue),
    [buildDisplayContent],
  );

  // Sync model with prop
  // Also clean up double-quoted model names (legacy data cleanup)
  useEffect(() => {
    if (modelName) {
      const cleanModelName = modelName.startsWith('"') && modelName.endsWith('"')
        ? modelName.slice(1, -1)
        : modelName;
      setSelectedModel(cleanModelName);
    }
  }, [modelName]);

  // Fetch available models from providers API
  // Collect models from all configured providers
  const fetchModels = useCallback(async () => {
    setModelsLoading(true);
    try {
      const providers = await listProvidersIPC();
      if (providers && providers.length > 0) {
        // Fix the hasApiKey field if it's missing
        providers.forEach((p) => {
          const pAny = p as Provider & Record<string, unknown>;
          const hasKey = pAny.hasApiKey ?? pAny.has_api_key ?? !!(p.apiKey && p.apiKey.length > 0);
          if (pAny.hasApiKey === undefined && hasKey) {
            (p as Provider & { hasApiKey: boolean }).hasApiKey = hasKey;
          }
        });

        // Find the default provider for tracking. With the
        // multi-provider model, the default is the implicit
        // fallback; we surface it first, then fall back to the
        // first configured provider. (The local `activeProviderId`
        // state is a misnomer from the single-active era — it
        // tracks the default, not a hard lock.)
        const defaultProvider = providers.find(
          (p) => p.isDefault && (p.hasApiKey || p.providerType === 'ollama'),
        );
        const activeProvider =
          defaultProvider ?? providers.find(
            (p) => p.hasApiKey || p.providerType === 'ollama',
          );

        if (activeProvider) {
          setHasProvider(true);
          setActiveProviderId(activeProvider.id);
        }

        // Collect models from all providers
        // Only use enabled_models from provider options - no preset defaults
        // Format: "[providerName] modelId"
        const allModels: ModelOption[] = [];
        const modelIds = new Set<string>(); // Deduplication
        const providerMap = new Map<string, string>(); // modelId -> providerId

        for (const provider of providers) {
          // Skip providers without API key (except Ollama)
          if (!provider.hasApiKey && provider.providerType !== 'ollama') {
            continue;
          }

          // Plan 209 P4-prime: build the per-provider model list
          // with a layered fallback. The order is:
          //   1. options.enabled_models (the authoritative list
          //      written by ProviderEditView)
          //   2. options.defaultModel (written by the legacy
          //      ModelSelectionSection — the only field that
          //      existed before Plan 205)
          //   3. (no preset fallback here; the model list must
          //      reflect user choice, not preset defaults)
          //
          // Without this fallback, providers whose only persisted
          // option is `defaultModel` (e.g. set via the global
          // ModelSelectionSection) appear with no models in the
          // dropdown even though a working model is configured.
          let enabledModels: string[] = [];
          try {
            const opts = JSON.parse(provider.options || '{}');
            if (opts.enabled_models && Array.isArray(opts.enabled_models) && opts.enabled_models.length > 0) {
              enabledModels = opts.enabled_models;
            } else if (typeof opts.defaultModel === 'string' && opts.defaultModel.length > 0) {
              enabledModels = [opts.defaultModel];
            }
          } catch { /* ignore */ }

          // Add enabled models to the list with provider prefix
          for (const id of enabledModels) {
            const cleanId = id.startsWith('"') && id.endsWith('"') ? id.slice(1, -1) : id;
            // Use provider name for display, but keep provider id in the map for API calls
            const providerName = provider.name || provider.providerType || provider.id;
            const prefixedId = `[${providerName}] ${cleanId}`;
            if (!modelIds.has(prefixedId)) {
              modelIds.add(prefixedId);
              allModels.push({ id: prefixedId, display_name: cleanId });
              providerMap.set(prefixedId, provider.id);
            }
          }
        }

        setAvailableModels(allModels);
        setModelProviderMap(providerMap);
        setModelsLoading(false);
        return;
      }
    } catch (err) {
      console.error('[MessageInput] Error fetching providers:', err);
    }
    setHasProvider(false);
    setAvailableModels([]);
    setModelsLoading(false);
  }, []);

  // Fetch models on mount, when session changes, and when window regains focus
  // (user may have changed providers in Settings while this component was mounted)
  useEffect(() => {
    fetchModels();

    // Retry after 2 seconds if provider not found (ConfigManager might still be loading)
    const retryTimer = setTimeout(() => {
      if (!hasProvider) {
        fetchModels();
      }
    }, 2000);

    // Also retry after 5 seconds as a fallback
    const fallbackTimer = setTimeout(() => {
      if (!hasProvider) {
        fetchModels();
      }
    }, 5000);

    // Refresh models when user returns from Settings or another window
    const handleFocus = () => {
      fetchModels();
    };
    window.addEventListener('focus', handleFocus);

    return () => {
      clearTimeout(retryTimer);
      clearTimeout(fallbackTimer);
      window.removeEventListener('focus', handleFocus);
    };
  }, [fetchModels, hasProvider, sessionId]);

  // Fetch skills, MCP servers, and output styles
  useEffect(() => {
    const fetchSkillsAndMcp = async () => {
      try {
        // Fetch skills from filesystem via IPC (same as Agent uses)
        if (window.electronAPI?.skills?.list) {
          const result = await window.electronAPI.skills.list();
          if (result.success && Array.isArray(result.skills)) {
            // Filter to only user-invocable skills (same as claude-code-haha)
            const filteredSkills = (result.skills as Array<{ userInvocable?: boolean; enabled?: boolean; name: string; description?: string; category?: string; whenToUse?: string }>)
              .filter((s) => s.userInvocable !== false && s.enabled !== false)
              .map((s) => ({
                name: s.name,
                description: s.description || s.whenToUse || '',
                source: s.category || 'other',
              }));
            setSkills(filteredSkills);
          }
        }

        // Fetch MCP servers (prefer ConfigManager agentSettings source)
        if (window.electronAPI?.settings?.getMcpServers) {
          const mcpResult = await window.electronAPI.settings.getMcpServers();
          if (mcpResult.success && Array.isArray(mcpResult.data)) {
            setMcpServers(
              mcpResult.data
                .filter((item: { name?: string }) => typeof item?.name === 'string' && item.name.length > 0)
                .map((item: { name: string; command?: string; enabled?: boolean }) => ({
                  name: item.name,
                  description: item.command,
                  enabled: item.enabled !== false,
                }))
            );
          } else {
            setMcpServers([]);
          }
        } else if (window.electronAPI?.settingsDb?.getJson) {
          const mcpData = await window.electronAPI.settingsDb.getJson<
            Array<{ name?: string; command?: string; enabled?: boolean }> | Record<string, { description?: string; enabled?: boolean }>
          >('mcpServers', []);
          const servers = Array.isArray(mcpData)
            ? mcpData
                .filter((item): item is { name: string; command?: string; enabled?: boolean } => typeof item?.name === 'string' && item.name.length > 0)
                .map((item) => ({
                  name: item.name,
                  description: item.command,
                  enabled: item.enabled !== false,
                }))
            : Object.entries(mcpData || {}).map(([name, config]) => ({
                name,
                description: config?.description,
                enabled: config?.enabled !== false,
              }));
          setMcpServers(servers);
        }

        // Fetch output styles
        try {
          const styles = await listOutputStylesIPC();
          setResponseStyles(styles);
        } catch {
          // output styles not available in this environment
        }
      } catch (error) {
        console.error('[MessageInput] Error fetching skills/MCP/styles:', error);
      }
    };

    fetchSkillsAndMcp();
  }, [sessionId]);

  // Load draft when session changes
  useEffect(() => {
    const prevId = prevSessionIdRef.current;
    prevSessionIdRef.current = sessionId;
    draftLoadedRef.current = false;

    if (!sessionId) return;

    getDraftIPC(sessionId)
      .then((draft) => {
        if (draft && prevSessionIdRef.current === sessionId) {
          setInputValue(draft);
          draftLoadedRef.current = true;
          requestAnimationFrame(() => adjustTextareaHeight());
        }
      })
      .catch(() => {});

    return () => {
      if (draftTimerRef.current) {
        clearTimeout(draftTimerRef.current);
        draftTimerRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Debounced draft save on input change
  useEffect(() => {
    if (!sessionId || !draftLoadedRef.current) return;

    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current);
    }

    draftTimerRef.current = setTimeout(() => {
      saveDraftIPC(sessionId, inputValue).catch(() => {});
    }, 300);

    return () => {
      if (draftTimerRef.current) {
        clearTimeout(draftTimerRef.current);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputValue, sessionId]);

  // Save draft on window close
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (sessionId && inputValue) {
        saveDraftIPC(sessionId, inputValue).catch(() => {});
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [sessionId, inputValue]);

  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 150)}px`;
    }
  }, []);

  // Handle model change
  const handleModelChange = useCallback((modelId: string) => {
    console.log('[MessageInput] handleModelChange called:', modelId);
    setSelectedModel(modelId);
    onModelChange?.(modelId);
    // Also notify parent about the provider ID for this model
    const providerId = modelProviderMap.get(modelId);
    console.log('[MessageInput] providerId from map:', providerId, 'map size:', modelProviderMap.size);
    if (providerId) {
      console.log('[MessageInput] calling onProviderChange with:', providerId);
      onProviderChange?.(providerId);
    } else {
      console.warn('[MessageInput] No providerId found for model:', modelId);
    }
  }, [onModelChange, onProviderChange, modelProviderMap]);

  // Handle effort change
  const handleEffortChange = useCallback((value: string) => {
    const newEffort = value || undefined;
    setSelectedEffort(newEffort);
    onEffortChange?.(newEffort);
  }, [onEffortChange]);

  // Handle input change
  const handleInputChange = useCallback(
    async (val: string) => {
      setInputValue(val);
      prePasteValueRef.current = val;
      adjustTextareaHeight();
      await handleSlashInputChange(val);
    },
    [adjustTextareaHeight, handleSlashInputChange],
  );

  const handlePasteEvent = useCallback(
    async (e: React.ClipboardEvent<HTMLDivElement>) => {
      // First check for image files in clipboard
      const items = e.clipboardData?.items;
      if (items) {
        const imageItems: DataTransferItem[] = [];
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item.type.startsWith('image/')) {
            imageItems.push(item);
          }
        }

        if (imageItems.length > 0) {
          e.preventDefault();
          for (const item of imageItems) {
            const file = item.getAsFile();
            if (file) {
              // Generate a name if not provided (clipboard images often have no name)
              const namedFile = new File(
                [file],
                file.name || `pasted-image-${Date.now()}.png`,
                { type: file.type }
              );
              await addFile(namedFile);
            }
          }
          adjustTextareaHeight();
          return;
        }
      }

      // Fall back to text paste handling
      const prePasteValue = prePasteValueRef.current;
      const pastedText = e.clipboardData.getData('text');
      // Plan 220 Phase 4: legacy `usePastedContent.handlePaste` is gone.
      // Reproduce its threshold check (500 chars) inline — long pastes
      // become a `pasted-text` attachment instead of streaming into the
      // input value.
      if (pastedText.length > 500) {
        e.preventDefault();
        addPastedText(pastedText);
        setTimeout(() => {
          if (
            textareaRef.current &&
            'value' in textareaRef.current &&
            textareaRef.current.value !== prePasteValue
          ) {
            setInputValue(prePasteValue);
          }
        }, 0);
        adjustTextareaHeight();
      }
    },
    [addPastedText, adjustTextareaHeight, addFile],
  );

  // Drag-and-drop handlers — accept files dropped anywhere on the input box
  const handleDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    if (disabled) return;
    dragCounterRef.current += 1;
    if (dragCounterRef.current === 1) {
      setIsDraggingOver(true);
    }
  }, [disabled]);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
  }, [disabled]);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (disabled) return;
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) {
      setIsDraggingOver(false);
    }
  }, [disabled]);

  const handleDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
    if (disabled) {
      e.preventDefault();
      return;
    }
    const files = e.dataTransfer.files;
    if (files.length === 0) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDraggingOver(false);

    for (let i = 0; i < files.length; i++) {
      await addFile(files[i]);
    }
    adjustTextareaHeight();
  }, [addFile, adjustTextareaHeight, disabled]);

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      const trimmedValue = inputValue.trim();

      // Check if we have any content to send (input or any attachment).
      const hasContent = trimmedValue || attachments.length > 0;
      if (!hasContent) return;
      if (disabled) return;

      // Block sending while document parsing is in progress — the parsed
      // text would be missing and the agent would see "Not Parsed" warnings.
      if (isParsing && hasUnparsedDocs) return;

      // Block sending while permission profile is being persisted to DB.
      // 否则 worker 会读到旧的 row 值, 出现"用户切到 ask 但工具仍按 bypass 执行"的竞态.
      if (permissionUpdatePending) return;

      const clearDraft = () => {
        draftLoadedRef.current = false;
        if (sessionId) {
          saveDraftIPC(sessionId, '').catch(() => {});
        }
      };

      // Build content + display content from the unified hook.
      // `modelContent` is sent to the LLM and includes attachment text
      // (pasted-text, terminal-ref, browser-ref, file-tree-ref bodies
      // joined ahead of the user's input).
      // `displayContent` is the pure user-typed text — attachment text
      // is carried by the attachment objects themselves (persisted to
      // `message.attachments`), so the rendered message body should NOT
      // duplicate it. Otherwise the card AND the full text both show.
      const modelContent = buildContentWithChips(trimmedValue);
      const displayContentForUser = trimmedValue;

      // Build output style config from selected style
      const outputStyleConfig = selectedStyleId
        ? responseStyles.find(s => s.id === selectedStyleId)
        : null;
      const styleOpts = outputStyleConfig
        ? { name: outputStyleConfig.name, prompt: outputStyleConfig.prompt, keepCodingInstructions: outputStyleConfig.keepCodingInstructions }
        : null;

      // All attachment kinds are persisted to `message.attachments` for
      // UI rendering (cards in history view). The worker (startStream)
      // filters to file/image kinds internally when building LLM content
      // blocks — pasted-text/terminal-ref/browser-ref/file-tree-ref are
      // already baked into `modelContent` via `buildContentWithChips`.
      const allAttachments = attachments.length > 0 ? attachments : undefined;

      // Check for direct slash commands
      const slashResult = resolveDirectSlash(trimmedValue);
      if (slashResult.action === 'immediate_command') {
        const cmd = slashResult.commandValue;
        if (cmd === '/clear') {
          onClearMessages?.();
          clearDraft();
          setInputValue('');
          clearAttachments();
          return;
        }
        if (cmd === '/recap') {
          onCommand?.(cmd);
          clearDraft();
          setInputValue('');
          clearAttachments();
          return;
        }
        const result = onExecuteCommand?.(cmd);
        if (result) {
          // Show command result as a message
          onSend(result.content, allAttachments, styleOpts, sendMode);
          setSendMode(undefined);
        }
        clearDraft();
        setInputValue('');
        setHiddenPrompt('');
        clearAttachments();
        return;
      }

      // If CLI badge is active, inject systemPromptAppend to guide model
      const cliAppend = buildCliAppend(cliBadge);
      if (cliBadge) setCliBadge(null);

      clearDraft();
      onSend(modelContent, allAttachments, styleOpts, sendMode, displayContentForUser);
      setSendMode(undefined);
      setInputValue('');
      setHiddenPrompt('');
      clearAttachments();
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    },
    [inputValue, hiddenPrompt, disabled, isStreaming, isParsing, cliBadge, attachments, hasUnparsedDocs, buildContentWithChips, clearAttachments, onSend, onCommand, onExecuteCommand, onClearMessages, selectedStyleId, responseStyles, sessionId, sendMode, permissionUpdatePending],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      // When popover is open, handle navigation
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
          // Dispatch by kind — same logic as popover's handleItemClick.
          switch (item.kind) {
            case 'settings_action':
              if (item.value === '__add_files') {
                fileInputRef.current?.click();
              } else {
                onExecuteCommand?.(item.value);
              }
              closePopover();
              return;
            case 'settings_submenu':
              // Sub-view navigation is click-only; ignore keyboard activation.
              return;
            case 'mode': {
              const modeValue = item.modeValue ?? '';
              setSendMode((prev) => (prev === modeValue ? undefined : modeValue));
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

      // Submit on Enter (without shift)
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const hasContent = inputValue.trim() || attachments.length > 0;
        if (hasContent) {
          handleSubmit({ preventDefault: () => {} } as FormEvent);
        }
      }
    },
    [isStreaming, inputValue, attachments, popoverMode, filteredItems, selectedIndex, insertItem, closePopover, handleSubmit],
  );

  const handleStop = useCallback(() => {
    onStop?.();
  }, [onStop]);

  // Remove CLI badge handler
  const handleRemoveCliBadge = useCallback(() => {
    setCliBadge(null);
  }, []);

  return (
    <div className="flex flex-col">
      {/* Document Parse Errors */}
      {parseErrors.size > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {Array.from(parseErrors.entries()).map(([filename, error]) => (
            <div
              key={filename}
              className="flex items-center gap-1 px-2 py-1 bg-destructive/10 text-destructive rounded-full text-xs"
              title={error}
            >
              <XCircleIcon size={12} />
              <span className="truncate max-w-[150px]">{filename}</span>
              <span className="text-destructive/60 text-[10px]">解析失败</span>
            </div>
          ))}
        </div>
      )}

      {/* Main Input Area */}
      <form onSubmit={handleSubmit} className="relative">
        {/* Slash Command Popover */}
        <SlashCommandPopover
          popoverMode={popoverMode}
          popoverRef={popoverRef}
          filteredItems={filteredItems}
          selectedIndex={selectedIndex}
          popoverFilter={popoverFilter}
          inputValue={inputValue}
          triggerPos={triggerPos}
          searchInputRef={searchInputRef}
          allDisplayedItems={filteredItems}
          placement={popoverPlacement}
          // Settings state + callbacks
          thinkingEffort={selectedEffort ?? null}
          onSelectThinkingEffort={(effort) => {
            setSelectedEffort(effort ?? undefined);
            onEffortChange?.(effort ?? undefined);
          }}
          responseStyles={responseStyles.map(s => ({ id: s.id, name: s.name, description: s.description }))}
          selectedStyle={selectedStyleId}
          onSelectStyle={(styleId) => setSelectedStyleId(styleId)}
          mcpServers={mcpServers}
          onToggleMcpServer={(serverName, enabled) => {
            setMcpServers((prev) =>
              prev.map((s) => (s.name === serverName ? { ...s, enabled } : s))
            );
          }}
          onAddFiles={() => fileInputRef.current?.click()}
          // Action commands (/compact, /memory, /export, /recap)
          onExecuteAction={(action) => {
            if (onExecuteCommand) {
              onExecuteCommand(action);
            } else if (onCommand) {
              onCommand(action);
            }
          }}
          // Mode state (mutually exclusive single-select)
          currentMode={sendMode ?? null}
          onSelectMode={(mode) => {
            setSendMode(mode ?? undefined);
            if (mode) textareaRef.current?.focus();
          }}
          onInsertItem={insertItem}
          onSetSelectedIndex={setSelectedIndex}
          onSetPopoverFilter={setPopoverFilter}
          onSetInputValue={setInputValue}
          onClosePopover={closePopover}
          onFocusTextarea={() => textareaRef.current?.focus()}
        />

        <div
          className={`message-input-surface relative z-[1] rounded-3xl p-2 transition-shadow ${isDraggingOver ? 'message-input-drop-active' : ''}`}
          style={{ backgroundColor: 'var(--surface)', boxShadow: 'inset 0 0 0 1px var(--border-color), 0 2px 8px rgba(0,0,0,0.08)' }}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {/* Drag-and-drop overlay */}
          {isDraggingOver && (
            <div className="message-input-drop-overlay" role="status" aria-live="polite">
              <div className="message-input-drop-card">
                <PaperclipIcon size={20} />
                <span>{t('messageInput.dropFilesHint') || '松开以添加为附件'}</span>
              </div>
            </div>
          )}
          {/* Plan 220 Phase 4: unified attachment bar above the editor.
              All 5 attachment kinds (file / image / pasted-text /
              terminal-ref / browser-ref / file-tree-ref) render through
              this single component. */}
          <AttachmentBar
            attachments={attachments}
            mode="input"
            onRemove={(id) => {
              removeAttachment(id);
              requestAnimationFrame(() => adjustTextareaHeight());
            }}
          />

          {/* Textarea */}
          <RichTextInput
            ref={textareaRef}
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePasteEvent}
            placeholder={cliBadge ? t('messageInput.describeWhat') : (placeholder || t('chat.placeholder'))}
            disabled={disabled}
          />

          {/* CLI Badge */}
          {cliBadge && (
            <div className="mt-2 flex items-center gap-2">
              <span className="px-2 py-0.5 bg-green-500/10 text-green-400 rounded text-xs">
                CLI: {cliBadge.name}
              </span>
              <button
                type="button"
                onClick={handleRemoveCliBadge}
                className="w-4 h-4 rounded-full bg-gray-700 flex items-center justify-center hover:bg-gray-600 transition-colors"
              >
                <XIcon size={10} />
              </button>
            </div>
          )}

          {/* Bottom Toolbar */}
          <div className="mt-1 px-2 flex items-center justify-between">
            {/* Left: Plus Button (opens unified command popover) & Permission */}
            <div className="flex items-center gap-2">
              {/* Plus Button — opens the slash command popover (settings + mode + skills) */}
              <button
                type="button"
                data-plus-trigger
                onClick={() => {
                  if (popoverMode === 'skill') {
                    closePopover();
                  } else {
                    openCommandPopover();
                  }
                }}
                className="size-7 rounded-lg flex items-center justify-center transition-all text-xs"
                style={
                  popoverMode === 'skill'
                    ? {
                        color: 'var(--text)',
                        backgroundColor: 'var(--chip)',
                        border: '1px solid var(--border)',
                      }
                    : { color: 'var(--muted)' }
                }
                title={t('common.settings') || 'Settings'}
              >
                <PlusIcon size={16} />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={async (e) => {
                  const input = e.target;
                  if (!input.files) return;
                  for (const file of Array.from(input.files)) {
                    await addFile(file);
                  }
                  input.value = '';
                }}
              />

              {/* Model Selector */}
              {hasProvider && (
                <ModelSelector
                  models={availableModels}
                  selectedModelId={selectedModel}
                  onSelect={handleModelChange}
                  disabled={isStreaming}
                  loading={modelsLoading}
                  variant="compact"
                />
              )}

              {/* Permission Mode Selector */}
              <PermissionModeSelector
                value={permissionMode ?? 'ask'}
                onChange={onPermissionModeChange || (() => {})}
                disabled={isStreaming}
              />

              {/* Mode Badge — shows when a mode (plan/research) is active */}
              {sendMode && (
                <button
                  type="button"
                  onClick={() => setSendMode(undefined)}
                  className="group flex items-center gap-1.5 px-2.5 py-1 rounded-lg transition-all text-xs font-medium text-[#7db4ff] border border-transparent hover:bg-[rgba(37,99,235,0.18)] hover:border-[#7db4ff]/40"
                >
                  <XIcon
                    size={14}
                    className="hidden group-hover:block"
                  />
                  <span>{sendMode === 'research' ? 'Deep Research' : 'Plan Mode'}</span>
                </button>
              )}
            </div>

            {/* Right: Send/Stop Button */}
            <div className="flex items-center gap-1">
              {hasQueuedMessages && !isStreaming && (
                <span className="text-xs text-muted-foreground bg-accent/20 px-1.5 py-0.5 rounded-full select-none">
                  +{1}
                </span>
              )}
              {isStreaming && onStop && (
                <button
                  type="button"
                  onClick={handleStop}
                  className="w-8 h-8 rounded-full bg-red-500/20 text-red-400 flex items-center justify-center hover:bg-red-500/30 transition-colors ml-1"
                  title="Stop"
                >
                  <StopIcon size={16} />
                </button>
              )}
              <button
                type="submit"
                disabled={disabled || (!inputValue.trim() && attachments.length === 0)}
                className="w-8 h-8 rounded-full text-white flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed transition-colors ml-1"
                style={{ backgroundColor: 'var(--send-btn)' }}
                onMouseEnter={e => { e.currentTarget.style.backgroundColor = 'var(--send-btn-hover)'; }}
                onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'var(--send-btn)'; }}
              >
                <ArrowUpIcon size={16} />
              </button>
            </div>
          </div>
        </div>

      </form>

    </div>
  );
}
