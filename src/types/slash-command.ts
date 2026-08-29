// slash-command.ts - Types for slash commands system

export type PopoverItemKind =
  | 'slash_command'
  | 'agent_command'
  | 'agent_skill'
  | 'sdk_command'
  | 'cli_tool'
  | 'settings_action'   // execute immediately (add files, /compact, /export, /recap)
  | 'settings_submenu'  // open a sub-view (thinking, style, mcp)
  | 'mode'              // toggle a popover mode (plan-task | research | conductor)
  /**
   * @deprecated As of plan 224 Phase 5, Conductor is a regular `mode`
   * item with `modeValue: 'conductor'`. The `conductor_toggle` kind is
   * retained only for backward compatibility with persisted state or
   * external callers; new code should use `kind: 'mode'`.
   */
  | 'conductor_toggle';

export type PopoverItemGroup = 'attachments' | 'mode' | 'settings' | 'skills' | 'apps';

export type SettingsSubmenu = 'thinking' | 'style' | 'mcp' | 'recap' | 'btw';

export interface PopoverItem {
  label: string;
  value: string;
  description?: string;
  /** Optional English counterpart to `description` for bilingual display. */
  descriptionEn?: string;
  icon?: React.ComponentType<{ size?: number; className?: string }>;
  builtIn?: boolean;
  immediate?: boolean;
  kind?: PopoverItemKind;
  installedSource?: 'agents' | 'claude';
  source?: 'global' | 'project' | 'plugin' | 'installed' | 'sdk';
  group?: PopoverItemGroup;
  /**
   * Category used by the input plus-menu to group items into the two
   * second-level lists:
   *   - 'context' → mode + MCP (triggered by `@` or the `@添加上下文` row)
   *   - 'command' → settings + skills (triggered by `/` or the `/使用指令和技能` row)
   * `attachments` (add files) lives outside either category and is exposed as a
   * top-level row of the plus-menu instead.
   */
  category?: 'context' | 'command';
  /** Absolute path to the skill directory (SKILL.md parent). Only set for agent_skill items. */
  skillRoot?: string;
  /** For settings_submenu items: which sub-view to open. */
  submenu?: SettingsSubmenu;
  /** For mode items: the ModeModifierId to toggle ('plan-task' | 'research' | 'conductor'). */
  modeValue?: string;
}

export type PopoverMode = 'skill' | 'context' | 'cli' | null;

export interface CommandBadge {
  command: string;
  label: string;
  description: string;
  kind: 'slash_command' | 'agent_command' | 'agent_skill' | 'sdk_command' | 'cli_tool';
  installedSource?: 'agents' | 'claude';
}

export interface CliBadge {
  name: string;
  summary?: string;
}

export interface InsertResult {
  action: 'insert_slash_command' | 'insert_file_mention';
  commandValue?: string;
  newInputValue?: string;
}

export interface TriggerResult {
  mode: PopoverMode;
  filter: string;
  triggerPos: number;
}
