/**
 * The item vocabulary, with no host types in it.
 *
 * ## Why these types are NOT the desktop's
 *
 * `apps/desktop/src/renderer/types/slash-command.ts` is the same shape, but its
 * `PopoverItem` carries `icon?: React.ComponentType<{ size?: number;
 * className?: string }>`. Importing that from a terminal UI is impossible, and
 * importing it into a shared package would drag React into a package whose
 * entire purpose is to have none.
 *
 * So `icon` is declared here as an opaque `unknown`. Each surface narrows it to
 * what it can actually draw: the desktop reads a React component, the CLI reads
 * a single-character glyph. Neither narrowing leaks back into this file, which
 * is what keeps the package importable from a blessed renderer that has never
 * heard of JSX.
 */

/** What an item does when it is accepted. */
export type PopoverItemKind =
  | 'slash_command'
  | 'agent_command'
  | 'agent_skill'
  | 'sdk_command'
  | 'cli_tool'
  /** Execute immediately rather than inserting text (add files, /compact, …). */
  | 'settings_action'
  /** Open a sub-view (thinking, style, mcp). */
  | 'settings_submenu'
  /** Toggle a product mode (plan-task | research | conductor). */
  | 'mode'
  /**
   * @deprecated Conductor is a regular `mode` item with
   * `modeValue: 'conductor'`. Retained for persisted state and external
   * callers; new items use `kind: 'mode'`.
   */
  | 'conductor_toggle';

export type PopoverItemGroup = 'attachments' | 'mode' | 'settings' | 'skills' | 'apps';

export type SettingsSubmenu = 'thinking' | 'style' | 'mcp' | 'recap' | 'btw';

/**
 * One candidate row.
 *
 * `label` is what the filter matches and what the user reads, so it is required
 * rather than defaulted: a row with no label cannot be ranked and cannot be
 * rendered, and both surfaces would have to invent something.
 */
export interface PopoverItem {
  label: string;
  /** Inserted text. Distinct from `label` for localised labels, where the
   *  label is Chinese but the value is `/doctor`. */
  value: string;
  description?: string;
  descriptionEn?: string;
  /** Opaque to this package; narrowed by each surface's renderer. */
  icon?: unknown;
  builtIn?: boolean;
  immediate?: boolean;
  kind?: PopoverItemKind;
  installedSource?: 'agents' | 'claude';
  source?: 'global' | 'project' | 'plugin' | 'installed' | 'sdk';
  group?: PopoverItemGroup;
  category?: 'context' | 'command';
  /** Absolute path to a skill directory (the SKILL.md's parent). */
  skillRoot?: string;
  submenu?: SettingsSubmenu;
  modeValue?: string;
}

/**
 * Which kind of completion is open.
 *
 * `null` means closed. `'skill'` is the `/` trigger, `'context'` the `@`
 * trigger; `'cli'` is a desktop-only third state with no CLI counterpart, kept
 * in the union so the desktop's existing state type stays assignable.
 */
export type PopoverMode = 'skill' | 'context' | 'cli' | null;

/** The span an accepted item replaces. */
export interface InsertResult {
  action: 'insert_slash_command' | 'insert_file_mention';
  commandValue?: string;
  /** The whole input after insertion, when the action supplies one. */
  newInputValue?: string;
}

/** Where a trigger was found and what has been typed since. */
export interface TriggerResult {
  mode: PopoverMode;
  /** Text between the trigger character and the cursor. */
  filter: string;
  /** Index of the trigger character itself. */
  triggerPos: number;
}