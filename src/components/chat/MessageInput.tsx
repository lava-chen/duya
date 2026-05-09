// MessageInput.tsx - Message input component with file attachments, model/effort selection, and badge support

'use client';

import React, { useState, useRef, useCallback, KeyboardEvent, FormEvent, useEffect } from 'react';
import {
  ArrowUpIcon,
  XIcon,
  StopIcon,
  FileIcon,
} from '@/components/icons';
import { Select } from 'antd';
import type { CommandBadge, CliBadge, PopoverItem, PopoverMode } from '@/types/slash-command';
import { FileAttachment } from '@/types/message';
import {
  dispatchBadge,
  buildCliAppend,
  resolveDirectSlash,
  filterItems,
} from '@/lib/message-input-logic';
import { ModelSelector, type ModelOption } from './ModelSelector';
import { PermissionModeSelector, type PermissionMode } from './PermissionModeSelector';
import { useFileAttachments } from '@/hooks/useFileAttachments';
import { usePastedContent } from '@/hooks/usePastedContent';
import { PastedContentList } from './PastedContentAttachment';
import { useTranslation } from '@/hooks/useTranslation';
import { listProvidersIPC, listOutputStylesIPC, type Provider } from '@/lib/ipc-client';
import { useSlashCommands } from '@/hooks/useSlashCommands';
import { SlashCommandPopover } from './SlashCommandPopover';
import { AttachmentMenu } from './AttachmentMenu';
import { ContextUsageRing } from './ContextUsageRing';
import type { Message } from '@/types/message';

interface FileChip {
  id: string;
  name: string;
  path: string;
}

interface MessageInputProps {
  onSend: (content: string, files?: FileAttachment[], outputStyleConfig?: { name: string; prompt: string; keepCodingInstructions?: boolean } | null) => void;
  onCommand?: (command: string) => void;
  onStop?: () => void;
  disabled?: boolean;
  isStreaming?: boolean;
  sessionId?: string;
  modelName?: string;
  onModelChange?: (model: string) => void;
  onProviderChange?: (providerId: string) => void;
  effort?: string;
  onEffortChange?: (effort: string | undefined) => void;
  permissionMode?: PermissionMode;
  onPermissionModeChange?: (mode: PermissionMode) => void;
  placeholder?: string;
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
  sessionId,
  modelName,
  onModelChange,
  onProviderChange,
  effort,
  onEffortChange,
  permissionMode = 'ask',
  onPermissionModeChange,
  placeholder,
  onExecuteCommand,
  onClearMessages,
  messages = [],
}: MessageInputProps) {
  const { t } = useTranslation();
  const [inputValue, setInputValue] = useState('');
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasFetchedModels = useRef(false);

  // File chips from file tree
  const [fileChips, setFileChips] = useState<FileChip[]>([]);

  // Badge state (for non-immediate commands like /compact)
  const [badge, setBadge] = useState<CommandBadge | null>(null);
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
  const [thinkingEffort, setThinkingEffort] = useState<string | null>(null);

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
    onCommand,
    setBadge,
    sessionId,
  });

  // File attachments
  const { attachedFiles, addFile, removeFile, handleFileInput } = useFileAttachments();

  // Pasted content attachments
  const {
    pastedContents,
    removePastedContent,
    clearPastedContents,
    handlePaste,
    getCombinedContent,
    getCombinedContentWithMarkers,
    hasPastedContents,
  } = usePastedContent();

  // Listen for file tree add-to-input events
  useEffect(() => {
    const handleAddToInput = (e: Event) => {
      const customEvent = e as CustomEvent<{ path: string }>;
      const path = customEvent.detail.path;
      const name = path.split(/[/\\]/).pop() || path;
      
      // Check if file is already added
      setFileChips((prev) => {
        if (prev.some((c) => c.path === path)) {
          return prev; // Already added, skip
        }
        const chip: FileChip = {
          id: crypto.randomUUID(),
          name,
          path,
        };
        return [...prev, chip];
      });

      // Focus textarea after adding file
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        adjustTextareaHeight();
      });
    };

    window.addEventListener('file-tree-add-to-input', handleAddToInput as EventListener);
    return () => {
      window.removeEventListener('file-tree-add-to-input', handleAddToInput as EventListener);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const removeFileChip = useCallback((id: string) => {
    setFileChips((prev) => prev.filter((c) => c.id !== id));
    requestAnimationFrame(() => {
      adjustTextareaHeight();
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Build content with file chip paths inserted
  // Append file paths at the end of the message
  const buildContentWithChips = useCallback((textValue: string): string => {
    if (fileChips.length === 0) return textValue;
    
    const filePaths = fileChips.map((chip) => chip.path).join('\n');
    if (!textValue.trim()) {
      return filePaths;
    }
    return `${textValue}\n\n${filePaths}`;
  }, [fileChips]);

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

        // Find active provider for tracking
        const activeProvider = providers.find((p) => p.isActive && (p.hasApiKey || p.providerType === 'ollama'))
          || providers.find((p) => p.hasApiKey || p.providerType === 'ollama');

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

          // Only use enabled_models from provider options
          let enabledModels: string[] = [];
          try {
            const opts = JSON.parse(provider.options || '{}');
            if (opts.enabled_models && Array.isArray(opts.enabled_models) && opts.enabled_models.length > 0) {
              enabledModels = opts.enabled_models;
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
            const filteredSkills = (result.skills as Array<{ userInvocable?: boolean; name: string; description?: string; category?: string; whenToUse?: string }>)
              .filter((s) => s.userInvocable !== false)
              .map((s) => ({
                name: s.name,
                description: s.description || s.whenToUse || '',
                source: s.category || 'other',
              }));
            setSkills(filteredSkills);
          }
        }

        // Fetch MCP servers
        if (window.electronAPI?.settingsDb?.getJson) {
          const mcpData = await window.electronAPI.settingsDb.getJson<Record<string, { description?: string; enabled?: boolean }>>('mcpServers', {});
          const servers = Object.entries(mcpData).map(([name, config]) => ({
            name,
            description: config.description,
            enabled: config.enabled !== false,
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
    async (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const val = e.target.value;
      setInputValue(val);
      adjustTextareaHeight();
      await handleSlashInputChange(val);
    },
    [adjustTextareaHeight, handleSlashInputChange],
  );

  const handlePasteEvent = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
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
      const pastedContent = handlePaste(e);
      if (pastedContent) {
        // Pasted content was treated as attachment, textarea value not changed
        // Optionally adjust height if needed
        adjustTextareaHeight();
      }
    },
    [handlePaste, adjustTextareaHeight, addFile],
  );

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      const trimmedValue = inputValue.trim();

      // Check if we have any content to send (input, pasted content, files, or file chips)
      const hasContent = trimmedValue || hasPastedContents || attachedFiles.length > 0 || fileChips.length > 0;
      if (!hasContent) return;
      if (disabled || isStreaming) return;

      // Build content with file chip paths
      const contentWithChips = buildContentWithChips(trimmedValue);

      // Get combined content with markers for storage/display
      const contentWithMarkers = getCombinedContentWithMarkers(contentWithChips);
      // Get plain content for API
      const plainContent = getCombinedContent(contentWithChips);

      // Build output style config from selected style
      const outputStyleConfig = selectedStyleId
        ? responseStyles.find(s => s.id === selectedStyleId)
        : null;
      const styleOpts = outputStyleConfig
        ? { name: outputStyleConfig.name, prompt: outputStyleConfig.prompt, keepCodingInstructions: outputStyleConfig.keepCodingInstructions }
        : null;

      // If badge is active, dispatch badge content
      if (badge) {
        const { prompt, displayLabel } = dispatchBadge(badge, plainContent);
        setBadge(null);
        setInputValue('');
        setFileChips([]);
        clearPastedContents();
        onSend(contentWithMarkers, attachedFiles.length > 0 ? attachedFiles : undefined, styleOpts);
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
        return;
      }

      // Check for direct slash commands
      const slashResult = resolveDirectSlash(trimmedValue);
      if (slashResult.action === 'immediate_command') {
        const cmd = slashResult.commandValue;
        if (cmd === '/clear') {
          onClearMessages?.();
          setInputValue('');
          setFileChips([]);
          clearPastedContents();
          return;
        }
        const result = onExecuteCommand?.(cmd);
        if (result) {
          // Show command result as a message
          onSend(result.content, attachedFiles.length > 0 ? attachedFiles : undefined, styleOpts);
        }
        setInputValue('');
        setFileChips([]);
        clearPastedContents();
        return;
      } else if (slashResult.action === 'set_badge') {
        setBadge(slashResult.badge);
        setInputValue('');
        return;
      }

      // If CLI badge is active, inject systemPromptAppend to guide model
      const cliAppend = buildCliAppend(cliBadge);
      if (cliBadge) setCliBadge(null);

      onSend(contentWithMarkers, attachedFiles.length > 0 ? attachedFiles : undefined, styleOpts);
      setInputValue('');
      setFileChips([]);
      clearPastedContents();
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    },
    [inputValue, disabled, isStreaming, badge, cliBadge, attachedFiles, hasPastedContents, fileChips, buildContentWithChips, getCombinedContent, getCombinedContentWithMarkers, clearPastedContents, onSend, onExecuteCommand, onClearMessages, selectedStyleId, responseStyles],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
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
          if (filteredItems[selectedIndex]) {
            insertItem(filteredItems[selectedIndex]);
          }
          return;
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
        const hasContent = inputValue.trim() || hasPastedContents || attachedFiles.length > 0 || fileChips.length > 0;
        if (!isStreaming && hasContent) {
          // Simulate form submit
          const form = textareaRef.current?.closest('form');
          if (form) {
            const event = new Event('submit', { bubbles: true, cancelable: true });
            form.dispatchEvent(event);
          }
        }
      }
    },
    [isStreaming, inputValue, hasPastedContents, attachedFiles, fileChips, popoverMode, filteredItems, selectedIndex, insertItem, closePopover],
  );

  const handleStop = useCallback(() => {
    onStop?.();
  }, [onStop]);

  // Remove badge handler
  const handleRemoveBadge = useCallback(() => {
    setBadge(null);
  }, []);

  // Remove CLI badge handler
  const handleRemoveCliBadge = useCallback(() => {
    setCliBadge(null);
  }, []);

  return (
    <div className="flex flex-col">
      {/* File Attachments Capsules */}
      {attachedFiles.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {attachedFiles.map((file) => (
            <div
              key={file.id}
              className="flex items-center gap-1 px-2 py-1 bg-muted rounded-full text-xs"
            >
              <FileIcon size={12} />
              <span className="truncate max-w-[100px]">{file.name}</span>
              <button
                type="button"
                onClick={() => removeFile(file.id)}
                className="w-4 h-4 rounded-full bg-muted-foreground/20 flex items-center justify-center hover:bg-muted-foreground/40 transition-colors"
              >
                <XIcon size={10} />
              </button>
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
          onInsertItem={insertItem}
          onSetSelectedIndex={setSelectedIndex}
          onSetPopoverFilter={setPopoverFilter}
          onSetInputValue={setInputValue}
          onClosePopover={closePopover}
          onFocusTextarea={() => textareaRef.current?.focus()}
        />

        <div className="rounded-2xl p-3 transition-shadow" style={{ backgroundColor: 'var(--surface)', border: 'none', boxShadow: '0 2px 8px rgba(0,0,0,0.08)' }}>
          {/* Pasted Content Attachments - Inside input box */}
          <PastedContentList contents={pastedContents} onRemove={removePastedContent} />

          {/* File Chips from file tree - Inline style */}
          {fileChips.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {fileChips.map((chip) => (
                <div
                  key={chip.id}
                  className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium border"
                  style={{
                    backgroundColor: 'var(--accent-soft)',
                    color: 'var(--accent)',
                    borderColor: 'var(--accent-soft)',
                  }}
                >
                  <FileIcon size={12} />
                  <span className="truncate max-w-[150px]">{chip.name}</span>
                  <button
                    type="button"
                    onClick={() => removeFileChip(chip.id)}
                    className="w-4 h-4 rounded-full flex items-center justify-center hover:bg-accent/30 transition-colors"
                    style={{ color: 'var(--accent)' }}
                  >
                    <XIcon size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Textarea */}
          <textarea
            ref={textareaRef}
            className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground resize-none focus:outline-none min-h-[40px] max-h-[150px]"
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePasteEvent}
            placeholder={badge ? t('messageInput.addDetails') : cliBadge ? t('messageInput.describeWhat') : (placeholder || t('chat.placeholder'))}
            disabled={disabled}
            rows={1}
          />

          {/* Command Badge */}
          {badge && (
            <div className="mt-2 flex items-center gap-2">
              <span className="px-2 py-0.5 bg-primary/10 text-primary rounded text-xs">
                {badge.label}
              </span>
              <button
                type="button"
                onClick={handleRemoveBadge}
                className="w-4 h-4 rounded-full bg-gray-700 flex items-center justify-center hover:bg-gray-600 transition-colors"
              >
                <XIcon size={10} />
              </button>
            </div>
          )}

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
          <div className="mt-3 flex items-center justify-between">
            {/* Left: Plus Button (with file attach, model selector, effort) & Permission */}
            <div className="flex items-center gap-2">
              {/* Plus Button with Dropdown Menu */}
              <AttachmentMenu
                onAddFiles={() => fileInputRef.current?.click()}
                skills={skills}
                mcpServers={mcpServers}
                responseStyles={responseStyles.map(s => ({ id: s.id, name: s.name, description: s.description }))}
                selectedStyle={selectedStyleId}
                onSelectStyle={(styleId) => {
                  setSelectedStyleId(styleId);
                  const style = responseStyles.find(s => s.id === styleId);
                  if (style) {
                    console.log('Selected style:', style.name, styleId);
                  }
                }}
                onSelectSkill={(skillName) => {
                  // Insert skill command into input
                  const skillCommand = `/${skillName}`;
                  setInputValue((prev) => {
                    const textarea = textareaRef.current;
                    if (textarea) {
                      const cursorPos = textarea.selectionStart;
                      const before = prev.slice(0, cursorPos);
                      const after = prev.slice(cursorPos);
                      const newValue = before + skillCommand + after;
                      // Set cursor position after the inserted skill
                      setTimeout(() => {
                        textarea.selectionStart = cursorPos + skillCommand.length;
                        textarea.selectionEnd = cursorPos + skillCommand.length;
                        textarea.focus();
                      }, 0);
                      return newValue;
                    }
                    return prev + skillCommand;
                  });
                }}
                onToggleMcpServer={(serverName, enabled) => {
                  setMcpServers((prev) =>
                    prev.map((s) => (s.name === serverName ? { ...s, enabled } : s))
                  );
                  // TODO: Persist MCP server state
                  console.log('Toggle MCP server:', serverName, enabled);
                }}
                onManageSkills={() => {
                  // TODO: Navigate to skills management
                  console.log('Manage skills clicked');
                }}
                onAddSkill={() => {
                  // TODO: Navigate to add skill
                  console.log('Add skill clicked');
                }}
                onCreateStyle={() => {
                  // TODO: Navigate to style creation
                  console.log('Create style clicked');
                }}
                thinkingEffort={thinkingEffort}
                onSelectThinkingEffort={(effort) => {
                  setThinkingEffort(effort);
                  // TODO: Apply thinking effort to the conversation
                  console.log('Selected thinking effort:', effort);
                }}
                modelSupportsEffort={true}
              />
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileInput}
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
                value={permissionMode}
                onChange={onPermissionModeChange || (() => {})}
                disabled={isStreaming}
              />


            </div>

            {/* Right: Send/Stop Button */}
            <div className="flex items-center gap-1">
              {isStreaming && onStop ? (
                <button
                  type="button"
                  onClick={handleStop}
                  className="w-8 h-8 rounded-full bg-red-500/20 text-red-400 flex items-center justify-center hover:bg-red-500/30 transition-colors ml-1"
                  title="Stop"
                >
                  <StopIcon size={16} />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={disabled || (!inputValue.trim() && !hasPastedContents && attachedFiles.length === 0 && fileChips.length === 0) || isStreaming}
                  className="w-8 h-8 rounded-full text-white flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed transition-colors ml-1"
                  style={{ backgroundColor: 'var(--send-btn)' }}
                  onMouseEnter={e => { e.currentTarget.style.backgroundColor = 'var(--send-btn-hover)'; }}
                  onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'var(--send-btn)'; }}
                >
                  <ArrowUpIcon size={16} />
                </button>
              )}
            </div>
          </div>
        </div>

      </form>

    </div>
  );
}
