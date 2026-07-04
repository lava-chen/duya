// useSlashCommands.ts - Hook for slash command detection and handling

import { useCallback, useMemo } from 'react';
import type { PopoverItem, PopoverMode } from '@/types/slash-command';
import { detectPopoverTrigger, resolveItemSelection } from '@/lib/message-input-logic';
import { getCommandsForPlatform } from '@/lib/commands';
import {
  Terminal,
  Question,
  Eraser,
  ChartLine,
  Brain,
  GlobeSimple,
  ClockCounterClockwise,
} from '@phosphor-icons/react';

// Command icons mapping
const COMMAND_ICONS: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  '/help': Question,
  '/clear': Eraser,
  '/cost': ChartLine,
  '/compact': Brain,
  '/recap': ClockCounterClockwise,
};

// Category icons mapping
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

  // Get commands from registry
  const registryCommands = useMemo(() => {
    const cmds = getCommandsForPlatform('app');
    return cmds.map((cmd) => ({
      label: `/${cmd.name}`,
      value: `/${cmd.name}`,
      description: cmd.description,
      icon: CATEGORY_ICONS[cmd.category] ?? Terminal,
      builtIn: true,
      kind: 'slash_command' as const,
      group: cmd.category === 'tools' ? 'skills' as const : 'settings' as const,
    }));
  }, []);

  // Insert selected item
  const insertItem = useCallback(
    (item: PopoverItem) => {
      if (triggerPos === null) return;

      const result = resolveItemSelection(item, popoverMode, triggerPos, inputValue, popoverFilter);

      switch (result.action) {
        case 'insert_slash_command':
          setInputValue(result.newInputValue!);
          closePopover();
          requestAnimationFrame(() => {
            const textarea = textareaRef.current;
            if (!textarea) return;
            textarea.focus();
            const commandEnd = triggerPos + (result.commandValue?.length ?? 0) + 1;
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

  // Fetch skills for / command (registry commands + enabled agent skills)
  const fetchSkills = useCallback(async () => {
    const builtIns = registryCommands;

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
              // Coerce to string — some skill files contain non-string `description`
              // values (arrays/objects), which would crash filterItems() later.
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
  }, [registryCommands, sessionId]);

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

  return {
    insertItem,
    handleInputChange,
    handleInsertSlash,
  };
}
