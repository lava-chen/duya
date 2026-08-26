// useSlashCommands.ts - Hook for slash command detection and handling

import { useCallback, useMemo } from 'react';
import type { PopoverItem, PopoverMode } from '@/types/slash-command';
import { detectPopoverTrigger, resolveItemSelection } from '@/lib/message-input-logic';
import { getCommandsForPlatform } from '@/lib/commands';
import { useTranslation } from '@/hooks/useTranslation';
import {
  TerminalIcon,
  QuestionIcon,
  BrainIcon,
  GlobeSimpleIcon,
  ClockCounterClockwiseIcon,
  ListChecksIcon,
  FeatherIcon,
  PlugIcon,
  ChalkboardIcon,
  ArrowsInLineVerticalIcon,
  TelescopeIcon,
  TargetArrowIcon,
  ChatCircleIcon,
  PaperclipIcon,
  EyeIcon,
} from '@/components/icons';
import { useFocusModeStore, selectFocusEnabled } from '@/stores/focus-mode-store';

// Commands removed from the popover (handled elsewhere or deleted).
const HIDDEN_COMMANDS = new Set(['/help', '/status', '/cost', '/new', '/clear', '/model']);

// Per-command icons for built-in slash commands that remain in the popover.
const COMMAND_ICONS: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  '/recap': ClockCounterClockwiseIcon,
};

// Category fallback icons.
const CATEGORY_ICONS: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  info: QuestionIcon,
  session: TerminalIcon,
  tools: BrainIcon,
  config: GlobeSimpleIcon,
};

export interface UseSlashCommandsReturn {
  insertItem: (item: PopoverItem) => void;
  handleInputChange: (val: string) => Promise<void>;
  handleInsertSlash: () => void;
  /** Static "add context" items (mode + MCP) shown when `@` is typed or the
   *  `@添加上上下文` plus-menu row is picked. */
  contextItems: PopoverItem[];
  /** Builds the "use commands & skills" items (settings + registry commands +
   *  loaded skills), used when `/` is typed or the `/使用指令和技能` row is
   *  picked. Skills are fetched asynchronously, so this returns a promise. */
  fetchCommandItems: () => Promise<PopoverItem[]>;
}

type SlashInputElement = HTMLTextAreaElement | HTMLDivElement;

function getCursorPosition(element: SlashInputElement): number {
  if ('selectionStart' in element) {
    return element.selectionStart;
  }

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return element.textContent?.length ?? 0;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.endContainer)) return element.textContent?.length ?? 0;

  const preRange = document.createRange();
  preRange.selectNodeContents(element);
  preRange.setEnd(range.endContainer, range.endOffset);
  return preRange.toString().length;
}

function setCursorPosition(element: SlashInputElement, position: number): void {
  if ('selectionStart' in element) {
    element.selectionStart = position;
    element.selectionEnd = position;
    return;
  }

  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let remaining = position;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }
    remaining -= length;
  }

  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export function useSlashCommands(opts: {
  textareaRef: React.RefObject<SlashInputElement | null>;
  inputValue: string;
  setInputValue: (value: string) => void;
  popoverMode: PopoverMode;
  popoverFilter: string;
  triggerPos: number | null;
  setPopoverMode: (mode: PopoverMode) => void;
  setPopoverFilter: (filter: string) => void;
  setPopoverItems: (items: PopoverItem[]) => void;
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  setTriggerPos: (pos: number | null) => void;
  closePopover: () => void;
  sessionId?: string;
  /**
   * Plan 450: connected app-connection providers surfaced as @-mention
   * items in the context popover. Selected items insert `@<providerId> `,
   * which the stream-session-manager extracts back to `mentionedProviders`.
   */
  connectorItems?: PopoverItem[];
}): UseSlashCommandsReturn {
  const {
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
    connectorItems,
  } = opts;

  const { t, locale } = useTranslation();

  // Per-session Focus display mode — the popover row reflects the live
  // toggle state so the check mark updates without closing the menu.
  const focusEnabled = useFocusModeStore((s) => selectFocusEnabled(s, sessionId));

  // Static "add context" items — MCP server toggles + the MCP submenu entry.
  // MCP lives under `@添加上上下文` (mode + plugin usage), not under settings.
  const mcpItem = useMemo<PopoverItem>(() => {
    const isZh = locale === 'zh';
    return {
      label: isZh ? 'MCP 服务器' : 'MCP servers',
      value: '__mcp',
      description: isZh ? '工具开关' : 'Tool toggles',
      icon: PlugIcon,
      kind: 'settings_submenu' as const,
      submenu: 'mcp' as const,
      group: 'settings' as const,
      category: 'context' as const,
    };
  }, [locale]);

  // Static settings items (not slash commands, not filterable). These belong
  // to the `/使用指令和技能` category (settings + skills). MCP is excluded —
  // it is part of `@添加上下文` instead.
  const settingsItems = useMemo<PopoverItem[]>(() => {
    const isZh = locale === 'zh';
    const category = 'command' as const;
    return [
      {
        label: isZh ? '思考程度' : 'Thinking',
        value: '__thinking',
        description: isZh ? '推理深度' : 'Reasoning depth',
        icon: BrainIcon,
        kind: 'settings_submenu' as const,
        submenu: 'thinking' as const,
        group: 'settings' as const,
        category,
      },
      {
        label: isZh ? '输出风格' : 'Output style',
        value: '__style',
        description: isZh ? '回复风格' : 'Response style',
        icon: FeatherIcon,
        kind: 'settings_submenu' as const,
        submenu: 'style' as const,
        group: 'settings' as const,
        category,
      },
      {
        label: isZh ? '压缩上下文' : 'Compact context',
        value: '__compact',
        description: isZh ? '摘要历史以节省 token' : 'Summarize history to save tokens',
        icon: ArrowsInLineVerticalIcon,
        kind: 'settings_action' as const,
        group: 'settings' as const,
        category,
      },
      {
        label: isZh ? '中途聊天' : 'Side chat',
        value: '__btw',
        description: isZh ? '旁侧问答，不打断当前对话' : 'Side Q&A without interrupting the conversation',
        icon: ChatCircleIcon,
        kind: 'settings_submenu' as const,
        submenu: 'btw' as const,
        group: 'settings' as const,
        category,
      },
      {
        label: isZh ? '专注模式' : 'Focus mode',
        value: '__focus',
        description: focusEnabled
          ? (isZh ? '已开启：只显示最终输出' : 'On — final output only')
          : (isZh ? '所有过程合并为一组，只看最终输出' : 'Merge all work into one group, show final output only'),
        icon: EyeIcon,
        kind: 'settings_action' as const,
        group: 'settings' as const,
        category,
      },
    ];
  }, [locale, focusEnabled]);

  // Mode items (mutually exclusive single-select). Category: @添加上下文.
  const modeItems = useMemo<PopoverItem[]>(() => {
    const isZh = locale === 'zh';
    const category = 'context' as const;
    return [
      {
        label: isZh ? 'Plan Mode' : 'Plan Mode',
        value: '__mode_plan',
        description: isZh ? '只读规划，先设计再实施' : 'Read-only planning before implementation',
        icon: ListChecksIcon,
        kind: 'mode' as const,
        modeValue: 'plan-task',
        group: 'mode' as const,
        category,
      },
      {
        label: 'Deep Research',
        value: '__mode_research',
        description: isZh ? '深度研究模式' : 'Deep research mode',
        icon: TelescopeIcon,
        kind: 'mode' as const,
        modeValue: 'research',
        group: 'mode' as const,
        category,
      },
      {
        label: isZh ? 'Conductor 画布' : 'Conductor Canvas',
        value: '__mode_conductor',
        description: isZh ? '注入画布操作工具，agent 可控制 conductor 画布' : 'Inject canvas tools, agent can control conductor canvas',
        icon: ChalkboardIcon,
        kind: 'mode' as const,
        modeValue: 'conductor',
        group: 'mode' as const,
        category,
      },
      {
        label: 'Goal',
        value: '__mode_goal',
        description: isZh ? '自主多轮目标追踪与核验' : 'Self-driven multi-round goal tracking with verification',
        icon: TargetArrowIcon,
        kind: 'mode' as const,
        modeValue: 'goal',
        group: 'mode' as const,
        category,
      },
    ];
  }, [locale]);

  // Built-in slash commands from registry (filtered).
  // Only /recap is kept in the popover; other built-ins are hidden until
  // their execution logic is wired up.
  const registryCommands = useMemo(() => {
    const cmds = getCommandsForPlatform('app');
    const isZh = locale === 'zh';
    return cmds
      .filter((cmd) => cmd.name === 'recap')
      .map((cmd) => {
        const slashName = `/${cmd.name}`;
        const title = isZh
          ? (cmd.labelZh ?? cmd.label ?? slashName)
          : (cmd.label ?? cmd.labelZh ?? slashName);
        const desc = isZh
          ? (cmd.descriptionZh ?? cmd.description)
          : cmd.description;
        const icon = COMMAND_ICONS[slashName]
          ?? CATEGORY_ICONS[cmd.category]
          ?? TerminalIcon;

        return {
          label: title,
          value: slashName,
          description: desc,
          icon,
          builtIn: true,
          kind: 'settings_action' as const,
          group: 'settings' as const,
          category: 'command' as const,
        };
      });
  }, [locale]);

  // Insert selected item (skill commands only).
  const insertItem = useCallback(
    (item: PopoverItem) => {
      // If triggerPos is null (opened via plus button), append at cursor or end.
      const cursorEl = textareaRef.current;
      const pos = triggerPos ?? (cursorEl ? getCursorPosition(cursorEl) : inputValue.length);
      const effectiveTriggerPos = triggerPos ?? pos;

      const result = resolveItemSelection(item, popoverMode, effectiveTriggerPos, inputValue, popoverFilter);

      switch (result.action) {
        case 'insert_slash_command':
          setInputValue(result.newInputValue!);
          closePopover();
          requestAnimationFrame(() => {
            const textarea = textareaRef.current;
            if (!textarea) return;
            textarea.focus();
            const commandEnd = effectiveTriggerPos + (result.commandValue?.length ?? 0) + 1;
            setCursorPosition(textarea, commandEnd);
          });
          return;

        case 'insert_file_mention':
          setInputValue(result.newInputValue!);
          closePopover();
          setTimeout(() => textareaRef.current?.focus(), 0);
          return;
      }
    },
    [triggerPos, popoverMode, closePopover, inputValue, popoverFilter, textareaRef, setInputValue],
  );

  // Attachment item — lives at the top of the `@` context popup (mode + MCP).
  const addFilesItem = useMemo<PopoverItem>(() => {
    const isZh = locale === 'zh';
    return {
      label: isZh ? '添加附件' : 'Add files',
      value: '__add_files',
      description: isZh ? '文件、图片' : 'Files or photos',
      icon: PaperclipIcon,
      kind: 'settings_action' as const,
      group: 'attachments' as const,
      category: 'context' as const,
    };
  }, [locale]);

  // Static "add context" items — attachment + mode + MCP, shown for `@` and
  // when the plus button is pressed. All static (no async fetch needed).
  const contextItems = useMemo<PopoverItem[]>(
    // Plan 450: connector items right after addFilesItem so connected apps
    // sit at the top of the `@` popover (mirroring codex's layout where
    // app mentions are the first thing users see after attachments).
    () => [addFilesItem, ...(connectorItems ?? []), ...modeItems, mcpItem],
    [addFilesItem, connectorItems, modeItems, mcpItem],
  );

  // Build the "use commands & skills" items (settings + registry commands +
  // loaded skills) for typing `/`. Skills are loaded asynchronously.
  const fetchCommandItems = useCallback(async () => {
    const commandBuiltIns = [...settingsItems, ...registryCommands];

    if (!sessionId) {
      return commandBuiltIns;
    }

    try {
      if (window.electronAPI?.skills?.list) {
        const result = await window.electronAPI.skills.list();
        if (result.success && Array.isArray(result.skills)) {
          const skillItems: PopoverItem[] = (result.skills as Array<{
            name: string;
            description?: string;
            category?: string;
            whenToUse?: string;
            source?: string;
            userInvocable?: boolean;
            isHidden?: boolean;
            enabled?: boolean;
            skillRoot?: string;
          }>)
            .filter((s) => s.userInvocable !== false && !s.isHidden && s.enabled !== false)
            .map((skill) => {
              const rawDesc = typeof skill.description === 'string' ? skill.description : '';
              const fallbackDesc = typeof skill.whenToUse === 'string' ? skill.whenToUse : (skill.category ?? '');
              return {
                label: skill.name,
                value: `/${skill.name}`,
                description: rawDesc || fallbackDesc,
                kind: 'agent_skill' as const,
                group: 'skills' as const,
                category: 'command' as const,
                installedSource: skill.source === 'project' ? 'agents' : 'claude',
                source: (skill.source as 'global' | 'project' | 'plugin' | 'installed' | 'sdk') || undefined,
                skillRoot: typeof skill.skillRoot === 'string' ? skill.skillRoot : undefined,
              };
            });
          return [...commandBuiltIns, ...skillItems];
        }
      }
      return commandBuiltIns;
    } catch (error) {
      console.error('[useSlashCommands] Error fetching skills:', error);
      return commandBuiltIns;
    }
  }, [settingsItems, registryCommands, sessionId]);

  // Handle input changes to detect @ and /
  const handleInputChange = useCallback(
    async (val: string) => {
      setInputValue(val);

      const textarea = textareaRef.current;
      if (!textarea) return;

      const cursorPos = getCursorPosition(textarea);
      const trigger = detectPopoverTrigger(val, cursorPos);

      if (trigger) {
        setPopoverMode(trigger.mode!);
        setPopoverFilter(trigger.filter);
        setTriggerPos(trigger.triggerPos);
        setSelectedIndex(0);

        // `/` → use commands & skills (settings + skills); `@` → add context
        // (mode + MCP). Items are already restricted to the matching
        // category, so the popover only shows the relevant group.
        if (trigger.mode === 'skill') {
          const items = await fetchCommandItems();
          setPopoverItems(items);
        } else if (trigger.mode === 'context') {
          setPopoverItems(contextItems);
        }
        return;
      }

      // Close popover when trigger is removed
      if (popoverMode && popoverMode !== 'cli') {
        closePopover();
      }
    },
    [fetchCommandItems, contextItems, popoverMode, closePopover, textareaRef, setInputValue, setPopoverMode, setPopoverFilter, setTriggerPos, setSelectedIndex, setPopoverItems],
  );

  // Insert `/` into textarea to trigger slash command popover
  const handleInsertSlash = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const cursorPos = getCursorPosition(textarea);
    const before = inputValue.slice(0, cursorPos);
    const after = inputValue.slice(cursorPos);
    const newValue = before + '/' + after;
    const newCursorPos = cursorPos + 1;
    setInputValue(newValue);
    textarea.focus();
    requestAnimationFrame(() => setCursorPosition(textarea, newCursorPos));
    handleInputChange(newValue);
  }, [inputValue, handleInputChange, textareaRef, setInputValue]);

  return {
    insertItem,
    handleInputChange,
    handleInsertSlash,
    contextItems,
    fetchCommandItems,
  };
}
