/**
 * The duya input-completion contract.
 *
 * One implementation of the rules that decide *when* a completion popup opens,
 * *what* survives the filter, and *what* accepting an item writes back — shared
 * by the desktop composer and the CLI TUI so that "the two behave the same" is
 * a fact about one module rather than a claim about two.
 *
 * ## What is deliberately absent
 *
 * No React, no Electron, no terminal, no IO, no candidate sources. Every
 * function here is a pure transform, which is what lets all three surfaces share
 * it: `apps/desktop` (browser), `packages/agent`'s blessed TUI (terminal), and
 * tests with none of the above.
 *
 * The counterpart is that each surface supplies its own CANDIDATES. The desktop
 * gets skills over Electron IPC, plugins from the plugin registry and modes
 * from its own store; the CLI reads `packages/agent/src/skills`, its mode
 * registry and the workspace tree. Only the selection rules are shared, and
 * that is the part that had actually drifted.
 */

export type {
  InsertResult,
  PopoverItem,
  PopoverItemGroup,
  PopoverItemKind,
  PopoverMode,
  SettingsSubmenu,
  TriggerResult,
} from './types.js';

export { detectPopoverTrigger } from './trigger.js';
export { filterItems, filterItemsFuzzy } from './filter.js';
export { resolveItemSelection, cycleIndex } from './insert.js';
export { fuzzyMatch, fuzzyFilter } from './fuzzy.js';
export type { FuzzyMatchResult } from './fuzzy.js';