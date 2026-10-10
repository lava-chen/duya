// slash-command.ts - Types for slash commands system

import type * as React from 'react';
import type {
  PopoverItem as SharedPopoverItem,
  PopoverItemGroup as SharedPopoverItemGroup,
  PopoverItemKind as SharedPopoverItemKind,
  PopoverMode as SharedPopoverMode,
  SettingsSubmenu as SharedSettingsSubmenu,
} from '@duya/input-completion';

/**
 * The shared enums and result shapes, aliased rather than copied.
 *
 * `PopoverMode`, `PopoverItemKind`, `PopoverItemGroup`, `SettingsSubmenu`,
 * `InsertResult` and `TriggerResult` have no host content, so they live in
 * `@duya/input-completion` and both surfaces take the same declaration. An
 * alias is the point: a copied union here would be a second definition to keep
 * in step, which is exactly what this package exists to remove.
 */
export type PopoverItemGroup = SharedPopoverItemGroup;
export type PopoverItemKind = SharedPopoverItemKind;
export type PopoverMode = SharedPopoverMode;
export type SettingsSubmenu = SharedSettingsSubmenu;
export type { InsertResult, TriggerResult };

/**
 * A candidate row, with the icon narrowed to something React can render.
 *
 * The shared type declares `icon` as `unknown` because the terminal has no JSX.
 * Narrowing it HERE rather than there is what lets one contract serve both:
 * `SlashCommandPopover` can render `item.icon` as a component, and the CLI can
 * read the same field as a glyph, without either of them widening the other.
 */
export interface PopoverItem extends Omit<SharedPopoverItem, 'icon'> {
  icon?: React.ComponentType<{ size?: number; className?: string }>;
}

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

import type { InsertResult, TriggerResult } from '@duya/input-completion';
