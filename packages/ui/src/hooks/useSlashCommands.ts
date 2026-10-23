// useSlashCommands.ts - Hook for slash command detection and handling

import { useCallback, useEffect, useMemo } from 'react';
import type { PopoverItem, PopoverMode } from '@/types/slash-command';
import { detectPopoverTrigger, resolveItemSelection } from '@/lib/message-input-logic';
import { canonicalOffsetAt, setCanonicalCaret } from '@/lib/rich-text-canonical';
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
  ArrowsInLineVerticalIcon,
  TelescopeIcon,
  TargetArrowIcon,
  ChatCircleIcon,
  PaperclipIcon,
  EyeIcon,
} from '@/components/icons';
import { useFocusModeStore, selectFocusEnabled } from '@/stores/focus-mode-store';

// Per-command icons for built-in slash commands that need a specific glyph.
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

// Section order and headings, matching /help's category layout so the popover
// and the help text describe the same command set in the same order.
const CATEGORY_ORDER = ['session', 'config', 'info', 'tools', 'exit'] as const;
const CATEGORY_LABELS: Record<string, string> = {
  session: 'Session',
  config: 'Configuration',
  info: 'Info',
  tools: 'Tools & Skills',
  exit: 'Exit',
};
const CATEGORY_LABELS_ZH: Record<string, string> = {
  session: '会话',
  config: '配置',
  info: '信息',
  tools: '工具与技能',
  exit: '退出',
};

/** Where a skill was loaded from, for the popover's source annotation. */
type SkillSource = 'user' | 'project' | 'custom' | 'plugin' | 'system' | 'unknown';

const SKILL_SOURCE_LABELS: Record<SkillSource, { en: string; zh: string }> = {
  user: { en: 'user', zh: '用户' },
  project: { en: 'project', zh: '项目' },
  custom: { en: 'custom', zh: '自定义' },
  plugin: { en: 'plugin', zh: '插件' },
  system: { en: 'system', zh: '系统' },
  unknown: { en: 'unknown', zh: '未知' },
};

/**
 * Map the loader's source vocabulary onto the narrower `PopoverItem.source`
 * union. `user`/`custom`/`system` have no counterpart there, so they collapse
 * to `global` rather than being force-cast into a value the type does not
 * declare (the old cast wrote `'user'` into a field typed `'global' | ...`).
 */
const SKILL_POPOVER_SOURCE: Record<SkillSource, 'global' | 'project' | 'plugin' | 'installed'> = {
  user: 'global',
  custom: 'global',
  system: 'global',
  project: 'project',
  plugin: 'plugin',
  unknown: 'installed',
};

/**
 * Resolve a skill's origin. `skills.list()` reports `source` directly
 * (user | project | custom | plugin | system); when it is missing, fall back
 * to the skill directory, which encodes the same four loading roots
 * (see apps/desktop/src/main/ipc/skills-handlers.ts).
 */
function resolveSkillSource(skill: {
  source?: unknown;
  skillRoot?: unknown;
}): SkillSource {
  const reported = typeof skill.source === 'string' ? skill.source.toLowerCase() : '';
  if (
    reported === 'user'
    || reported === 'project'
    || reported === 'custom'
    || reported === 'plugin'
    || reported === 'system'
  ) {
    return reported;
  }
  if (reported === 'installed') return 'plugin';

  const root = typeof skill.skillRoot === 'string' ? skill.skillRoot.replace(/\\/g, '/') : '';
  if (root === '') return 'unknown';
  if (/\/\.agent\/skills\/?$|\/\.duya\/skills\/?$/.test(root)) return 'project';
  if (/\/skills\/?$/.test(root) && /\/plugins?\//.test(root)) return 'plugin';
  if (/[\\/]\.system[\\/]/.test(root)) return 'system';
  return 'user';
}

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

  const fallback = element.textContent?.length ?? 0;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return fallback;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.endContainer)) return fallback;

  // Atomic chips (plugin @-mentions, skill tokens) render a friendly label
  // that differs in length from the canonical token they stand for, so map the
  // DOM caret back through canonical lengths instead of raw textContent.
  return canonicalOffsetAt(element, range.endContainer, range.endOffset) ?? fallback;
}

function setCursorPosition(element: SlashInputElement, position: number): void {
  if ('selectionStart' in element) {
    element.selectionStart = position;
    element.selectionEnd = position;
    return;
  }

  setCanonicalCaret(element, position);
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
   * Installed plugins surfaced as @-mention items in the context popover
   * (one row per plugin). Selected items insert `@<pluginId> `, which the
   * stream-session-manager rewrites to `[@Name](plugin://id)` and merges
   * into `mentionedProviders`/`mentionedPlugins` on submit.
   */
  pluginItems?: PopoverItem[];
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
    pluginItems,
  } = opts;

  const { t, locale } = useTranslation();

  // Per-session Focus display mode — the popover row reflects the live
  // toggle state so the check mark updates without closing the menu.
  const focusEnabled = useFocusModeStore((s) => selectFocusEnabled(s, sessionId));

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

  // Every command in the app registry is listed, ordered and described the
  // same way `/help` prints them (lib/commands/help.ts and
  // executors/info.ts both read this same registry).
  //
  // Rows are inserted into the composer rather than executed on click
  // (`kind: 'slash_command'`): SlashCommandPopover's click handler only
  // dispatches `/recap`, the compact row and the focus toggle, so any other
  // `settings_action` would close the menu without running anything. Inserting
  // routes both the mouse and the keyboard path through submit, where
  // `resolveDirectSlash` -> `runSlashCommand` picks the executor up, and it
  // also lets the user type arguments (`/model gpt-4`, `/goal status`).
  // `/recap` keeps its dedicated popover sub-view.
  const registryCommands = useMemo(() => {
    const isZh = locale === 'zh';
    const labels = isZh ? CATEGORY_LABELS_ZH : CATEGORY_LABELS;
    const cmds = getCommandsForPlatform('app');
    const rank = (category: string) => {
      const idx = CATEGORY_ORDER.indexOf(category as (typeof CATEGORY_ORDER)[number]);
      return idx === -1 ? CATEGORY_ORDER.length : idx;
    };
    const sorted = [...cmds].sort((a, b) => rank(a.category) - rank(b.category));

    return sorted.map((cmd) => {
      const slashName = `/${cmd.name}`;
      const title = isZh
        ? (cmd.labelZh ?? cmd.label ?? slashName)
        : (cmd.label ?? cmd.labelZh ?? slashName);
      const desc = isZh
        ? (cmd.descriptionZh ?? cmd.description)
        : cmd.description;

      // The popover renders one flat section per `group`, so the category is
      // carried in the description line instead of a section header.
      let description = `${labels[cmd.category] ?? cmd.category} · ${desc}`;
      if (cmd.argsHint) description += ` ${cmd.argsHint}`;
      if (cmd.aliases?.length) description += ` (/${cmd.aliases.join(', /')})`;

      const icon = COMMAND_ICONS[slashName]
        ?? CATEGORY_ICONS[cmd.category]
        ?? TerminalIcon;

      return {
        label: title,
        value: slashName,
        description,
        icon,
        builtIn: true,
        kind: (slashName === '/recap' ? 'settings_action' : 'slash_command') as
          | 'settings_action'
          | 'slash_command',
        group: 'settings' as const,
        category: 'command' as const,
      };
    });
  }, [locale]);

  // Insert selected item (registry commands and skills both land here).
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

        case 'insert_file_mention': {
          setInputValue(result.newInputValue!);
          closePopover();
          // Land the caret right after the inserted token (before any text
          // that followed the `@filter`). Chips count as canonical tokens, so
          // the offset is derived from the post-insert string, not the DOM.
          const afterLength = inputValue.slice(effectiveTriggerPos + popoverFilter.length + 1).length;
          const caret = Math.max(0, (result.newInputValue ?? '').length - afterLength);
          requestAnimationFrame(() => {
            const textarea = textareaRef.current;
            if (!textarea) return;
            textarea.focus();
            setCursorPosition(textarea, caret);
          });
          return;
        }
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

  // Static "add context" items — attachment + modes + plugins, shown for
  // `@` and when the plus button is pressed. All static (no async fetch
  // needed). Plan 452 Phase A: the MCP entry moved out — server toggles live
  // in Settings only, and MCP tools are Direct-exposed (no @-activation).
  const contextItems = useMemo<PopoverItem[]>(
    // Installed plugins sit right after the attachments row so the most
    // relevant capabilities are the first thing users see in the `@` popover
    // (codex parity: plugin mentions lead the list).
    () => [addFilesItem, ...(pluginItems ?? []), ...modeItems],
    [addFilesItem, pluginItems, modeItems],
  );

  // Plan 450 follow-up: when `contextItems` changes (e.g. the MessageInput's
  // async plugin fetch completes and updates `pluginItems`) AND the
  // `@` popover is currently open, push the latest items into the popover.
  // Without this, handleInputChange's initial setPopoverItems(contextItems)
  // freezes the (empty) snapshot at trigger time and the popover never
  // updates even after the fetch finishes.
  useEffect(() => {
    if (popoverMode === 'context') {
      setPopoverItems(contextItems);
    }
  }, [contextItems, popoverMode, setPopoverItems]);

  // Build the "use commands & skills" items (settings + registry commands +
  // loaded skills) for typing `/`. Skills are loaded asynchronously.
  const fetchCommandItems = useCallback(async () => {
    const commandBuiltIns = [...settingsItems, ...registryCommands];
    const isSkillSourceZh = locale === 'zh';

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
              const origin = resolveSkillSource(skill);
              const sourceLabel = isSkillSourceZh ? SKILL_SOURCE_LABELS[origin].zh : SKILL_SOURCE_LABELS[origin].en;
              // Same shape as claude's formatDescriptionWithSource: the origin
              // is appended so two skills with the same description are still
              // tellable apart. `source`/`installedSource` on the row are kept
              // for callers that render them separately.
              const description = [rawDesc || fallbackDesc, `(${sourceLabel})`]
                .filter((part) => part.length > 0)
                .join(' ');
              return {
                label: skill.name,
                value: `/${skill.name}`,
                description,
                kind: 'agent_skill' as const,
                group: 'skills' as const,
                category: 'command' as const,
                installedSource: origin === 'project' ? 'agents' : 'claude',
                source: SKILL_POPOVER_SOURCE[origin],
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
  }, [settingsItems, registryCommands, sessionId, locale]);

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
