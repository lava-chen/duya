// useSlashCommands.ts - Hook for slash command detection and handling

import { useCallback, useMemo } from 'react';
import type { PopoverItem, PopoverMode } from '@/types/slash-command';
import { detectPopoverTrigger, resolveItemSelection } from '@/lib/message-input-logic';
import { getCommandsForPlatform } from '@/lib/commands';
import { useTranslation } from '@/hooks/useTranslation';
import {
  Terminal,
  Question,
  Brain,
  GlobeSimple,
  ClockCounterClockwise,
  ListChecks,
  Paperclip,
  Feather,
  Plug,
  SquareHalf,
} from '@phosphor-icons/react';
import { TelescopeIcon } from '@/components/icons';

// Commands removed from the popover (handled elsewhere or deleted).
const HIDDEN_COMMANDS = new Set(['/help', '/status', '/cost', '/new', '/clear', '/model']);

// Per-command icons for built-in slash commands that remain in the popover.
const COMMAND_ICONS: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  '/recap': ClockCounterClockwise,
};

// Category fallback icons.
const CATEGORY_ICONS: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  info: Question,
  session: Terminal,
  tools: Brain,
  config: GlobeSimple,
};

export interface UseSlashCommandsReturn {
  insertItem: (item: PopoverItem) => void;
  handleInputChange: (val: string) => Promise<void>;
  handleInsertSlash: () => void;
  openCommandPopover: () => Promise<void>;
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
  } = opts;

  const { t, locale } = useTranslation();

  // Attachment item (rendered standalone at the top of the popover).
  const addFilesItem = useMemo<PopoverItem>(() => {
    const isZh = locale === 'zh';
    return {
      label: isZh ? '添加附件' : 'Add files',
      value: '__add_files',
      description: isZh ? '文件、图片' : 'Files or photos',
      icon: Paperclip,
      kind: 'settings_action' as const,
      group: 'attachments' as const,
    };
  }, [locale]);

  // Static settings items (not slash commands, not filterable).
  const settingsItems = useMemo<PopoverItem[]>(() => {
    const isZh = locale === 'zh';
    return [
      {
        label: isZh ? '思考程度' : 'Thinking',
        value: '__thinking',
        description: isZh ? '推理深度' : 'Reasoning depth',
        icon: Brain,
        kind: 'settings_submenu' as const,
        submenu: 'thinking' as const,
        group: 'settings' as const,
      },
      {
        label: isZh ? '输出风格' : 'Output style',
        value: '__style',
        description: isZh ? '回复风格' : 'Response style',
        icon: Feather,
        kind: 'settings_submenu' as const,
        submenu: 'style' as const,
        group: 'settings' as const,
      },
      {
        label: isZh ? 'MCP 服务器' : 'MCP servers',
        value: '__mcp',
        description: isZh ? '工具开关' : 'Tool toggles',
        icon: Plug,
        kind: 'settings_submenu' as const,
        submenu: 'mcp' as const,
        group: 'settings' as const,
      },
    ];
  }, [locale]);

  // Mode items (mutually exclusive single-select).
  const modeItems = useMemo<PopoverItem[]>(() => {
    const isZh = locale === 'zh';
    return [
      {
        label: isZh ? 'Plan Mode' : 'Plan Mode',
        value: '__mode_plan',
        description: isZh ? '只读规划，先设计再实施' : 'Read-only planning before implementation',
        icon: ListChecks,
        kind: 'mode' as const,
        modeValue: 'plan',
        group: 'mode' as const,
      },
      {
        label: 'Deep Research',
        value: '__mode_research',
        description: isZh ? '深度研究模式' : 'Deep research mode',
        icon: TelescopeIcon,
        kind: 'mode' as const,
        modeValue: 'research',
        group: 'mode' as const,
      },
      {
        label: isZh ? 'Conductor 画布' : 'Conductor Canvas',
        value: '__conductor_toggle',
        description: isZh ? '注入画布操作工具，agent 可控制 conductor 画布' : 'Inject canvas tools, agent can control conductor canvas',
        icon: SquareHalf,
        kind: 'conductor_toggle' as const,
        group: 'mode' as const,
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
          ?? Terminal;

        return {
          label: title,
          value: slashName,
          description: desc,
          icon,
          builtIn: true,
          kind: 'settings_action' as const,
          group: 'settings' as const,
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

  // Fetch all items: settings + mode + registry commands + dynamic skills.
  const fetchSkills = useCallback(async () => {
    const builtIns = [addFilesItem, ...modeItems, ...settingsItems, ...registryCommands];

    if (!sessionId) {
      return builtIns;
    }

    try {
      if (window.electronAPI?.skills?.list) {
        const result = await window.electronAPI.skills.list();
        if (result.success && Array.isArray(result.skills)) {
          const skillItems: PopoverItem[] = (result.skills as Array<{
            name: string;
            description?: string;
            source?: string;
            userInvocable?: boolean;
            isHidden?: boolean;
            enabled?: boolean;
            skillRoot?: string;
          }>)
            .filter((s) => s.userInvocable !== false && !s.isHidden && s.enabled !== false)
            .map((skill) => ({
              label: `/${skill.name}`,
              value: `/${skill.name}`,
              description:
                typeof skill.description === 'string' ? skill.description : '',
              kind: 'agent_skill' as const,
              group: 'skills' as const,
              installedSource: skill.source === 'project' ? 'agents' : 'claude',
              source: (skill.source as 'global' | 'project' | 'plugin' | 'installed' | 'sdk') || undefined,
              skillRoot: typeof skill.skillRoot === 'string' ? skill.skillRoot : undefined,
            }));
          return [...builtIns, ...skillItems];
        }
      }
      return builtIns;
    } catch (error) {
      console.error('[useSlashCommands] Error fetching skills:', error);
      return builtIns;
    }
  }, [settingsItems, modeItems, registryCommands, sessionId]);

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

        if (trigger.mode === 'skill') {
          const items = await fetchSkills();
          setPopoverItems(items);
        }
        return;
      }

      // Close popover when trigger is removed
      if (popoverMode && popoverMode !== 'cli') {
        closePopover();
      }
    },
    [fetchSkills, popoverMode, closePopover, textareaRef, setInputValue, setPopoverMode, setPopoverFilter, setTriggerPos, setSelectedIndex, setPopoverItems],
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

  // Open the command popover via the plus button (no `/` inserted into input).
  // Render built-ins instantly so the popover feels responsive; dynamic agent
  // skills are appended in the background once the IPC call resolves.
  const openCommandPopover = useCallback(async () => {
    setPopoverMode('skill');
    setPopoverFilter('');
    setTriggerPos(null);
    setSelectedIndex(0);
    const builtIns = [addFilesItem, ...modeItems, ...settingsItems, ...registryCommands];
    setPopoverItems(builtIns);
    const fullItems = await fetchSkills();
    setPopoverItems(fullItems);
  }, [fetchSkills, settingsItems, modeItems, registryCommands, setPopoverMode, setPopoverFilter, setTriggerPos, setSelectedIndex, setPopoverItems]);

  return {
    insertItem,
    handleInputChange,
    handleInsertSlash,
    openCommandPopover,
  };
}
