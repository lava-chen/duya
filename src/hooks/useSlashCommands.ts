// useSlashCommands.ts - Hook for slash command detection and handling

import { useCallback, useMemo } from 'react';
import type { PopoverItem, PopoverMode, CommandBadge } from '@/types/slash-command';
import { detectPopoverTrigger, resolveItemSelection, BUILT_IN_COMMANDS } from '@/lib/message-input-logic';
import {
  Terminal,
  Question,
  Eraser,
  ChartLine,
  Brain,
  GlobeSimple,
} from '@phosphor-icons/react';

// Command icons mapping
const COMMAND_ICONS: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  '/help': Question,
  '/clear': Eraser,
  '/cost': ChartLine,
  '/compact': Brain,
};

export interface UseSlashCommandsReturn {
  insertItem: (item: PopoverItem) => void;
  handleInputChange: (val: string) => Promise<void>;
  handleInsertSlash: () => void;
}

export function useSlashCommands(opts: {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
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
  onCommand?: (command: string) => void;
  setBadge: (badge: CommandBadge | null) => void;
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
    onCommand,
    setBadge,
    sessionId,
  } = opts;

  // Enrich built-in commands with icons
  const enrichedBuiltIns = useMemo(
    () =>
      BUILT_IN_COMMANDS.map((cmd) => ({
        ...cmd,
        icon: COMMAND_ICONS[cmd.value],
      })),
    [],
  );

  // Insert selected item
  const insertItem = useCallback(
    (item: PopoverItem) => {
      if (triggerPos === null) return;

      const result = resolveItemSelection(item, popoverMode, triggerPos, inputValue, popoverFilter);

      switch (result.action) {
        case 'immediate_command':
          if (onCommand) {
            setInputValue('');
            closePopover();
            onCommand(result.commandValue!);
          }
          return;

        case 'set_badge':
          setBadge(result.badge!);
          setInputValue('');
          closePopover();
          setTimeout(() => textareaRef.current?.focus(), 0);
          return;

        case 'insert_file_mention':
          setInputValue(result.newInputValue!);
          closePopover();
          setTimeout(() => textareaRef.current?.focus(), 0);
          return;
      }
    },
    [triggerPos, popoverMode, closePopover, onCommand, inputValue, popoverFilter, textareaRef, setInputValue, setBadge],
  );

  // Fetch skills for / command (built-in commands + agent skills from registry)
  const fetchSkills = useCallback(async () => {
    const builtIns = enrichedBuiltIns;

    if (!sessionId) {
      return builtIns;
    }

    try {
      if (window.electronAPI?.settingsDb?.getJson) {
        const skills = await window.electronAPI.settingsDb.getJson<Array<{ name: string; description?: string; source?: string; userInvocable?: boolean; isHidden?: boolean }>>('skills', []);
        if (Array.isArray(skills)) {
          const skillItems: PopoverItem[] = skills
            .filter((s) => s.userInvocable !== false && !s.isHidden)
            .map((skill) => ({
              label: `/${skill.name}`,
              value: `/${skill.name}`,
              description: skill.description,
              kind: 'agent_skill' as const,
              installedSource: skill.source === 'project' ? 'agents' : 'claude',
              source: (skill.source as 'global' | 'project' | 'plugin' | 'installed' | 'sdk') || undefined,
            }));
          return [...builtIns, ...skillItems];
        }
      }
      return builtIns;
    } catch (error) {
      console.error('[useSlashCommands] Error fetching skills:', error);
      return builtIns;
    }
  }, [enrichedBuiltIns, sessionId]);

  // Handle input changes to detect @ and /
  const handleInputChange = useCallback(
    async (val: string) => {
      setInputValue(val);

      const textarea = textareaRef.current;
      if (!textarea) return;

      const cursorPos = textarea.selectionStart;
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
    const cursorPos = textarea.selectionStart;
    const before = inputValue.slice(0, cursorPos);
    const after = inputValue.slice(cursorPos);
    const newValue = before + '/' + after;
    const newCursorPos = cursorPos + 1;
    setInputValue(newValue);
    textarea.value = newValue;
    textarea.selectionStart = newCursorPos;
    textarea.selectionEnd = newCursorPos;
    textarea.focus();
    handleInputChange(newValue);
  }, [inputValue, handleInputChange, textareaRef, setInputValue]);

  return {
    insertItem,
    handleInputChange,
    handleInsertSlash,
  };
}
