// slash-command.ts - Types for slash commands system

export interface PopoverItem {
  label: string;
  value: string;
  description?: string;
  icon?: React.ComponentType<{ size?: number; className?: string }>;
  builtIn?: boolean;
  immediate?: boolean;
  kind?: 'slash_command' | 'agent_command' | 'agent_skill' | 'sdk_command' | 'cli_tool';
  installedSource?: 'agents' | 'claude';
  source?: 'global' | 'project' | 'plugin' | 'installed' | 'sdk';
}

export type PopoverMode = 'skill' | 'file' | 'cli' | null;

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
  action: 'immediate_command' | 'set_badge' | 'insert_file_mention';
  commandValue?: string;
  badge?: CommandBadge;
  newInputValue?: string;
}

export interface TriggerResult {
  mode: PopoverMode;
  filter: string;
  triggerPos: number;
}
