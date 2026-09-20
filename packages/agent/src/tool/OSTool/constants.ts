/**
 * constants.ts — Computer Use tool naming + action enum (plan 454 §5 Task B).
 *
 * Phase 2 ships a SINGLE tool (`computer_use`) with an action enum
 * covering 9 OS-side operations. This keeps the per-turn schema cost
 * low (hermes-agent style) and matches the user's earlier decision
 * (single tool + action enum, recommended default).
 *
 * Action mapping:
 *   - capture        : capture screen (SOM overlay optional)
 *   - click          : click at element index or coords
 *   - type           : type text into focused field
 *   - key            : press key + modifiers
 *   - scroll         : wheel scroll
 *   - drag           : drag between elements/coordinates
 *   - set_value      : replace value in focused field
 *   - wait           : sleep
 *   - zoom           : region-restricted SOM capture
 *
 * `window_switch` / `list_apps` were removed (user decision
 * 2026-08-29): targeting is pure vision — the model sees the screen
 * via capture/zoom and clicks; app enumeration / focus switching by
 * name proved unused in practice and added schema + prompt surface.
 * The backend keeps the underlying providers for future use.
 *
 * The tool name is `computer_use` — chosen to be domain-specific
 * (not generic `os`) and avoid collisions with the existing `computer-use`
 * (dash) identifier used by the package name.
 */

export const COMPUTER_USE_TOOL_NAME = 'computer_use';

export const COMPUTER_USE_ACTIONS = [
  'capture',
  'click',
  'type',
  'key',
  'scroll',
  'drag',
  'set_value',
  'wait',
  'zoom',
] as const;

export const COMPUTER_USE_ACTION_LIST: readonly string[] = COMPUTER_USE_ACTIONS;

export type ComputerUseAction = (typeof COMPUTER_USE_ACTIONS)[number];

/**
 * plan 519 §3.2 (D2) — the conditional sibling tool. NOT part of the
 * 9-action enum above: `list_apps` / `focus_app` were deliberately
 * removed from `computer_use` (user decision 2026-08-29, "pure
 * vision") and come back only as a second tool that is injected just
 * when the vision path needs an escape hatch (0-element capture /
 * suspected_noop click / explicit prior call — see context-tool.ts).
 */
export const COMPUTER_USE_CONTEXT_TOOL_NAME = 'computer_use_context';

export const COMPUTER_USE_CONTEXT_ACTIONS = ['list_apps', 'focus_app'] as const;

export type ComputerUseContextAction = (typeof COMPUTER_USE_CONTEXT_ACTIONS)[number];

/**
 * plan 551 Phase 3 — the delegated-goal sibling tool ("LLM plans, Jev
 * decides"). Like `computer_use_context`, it is NOT part of the
 * 9-action enum: it is a separately-schematized tool injected only
 * when a decision backend is configured (no key → never injected →
 * zero behavior change). It dispatches no new main-process action —
 * the inner loop reuses the existing 9-action IPC surface.
 */
export const COMPUTER_USE_DECIDE_TOOL_NAME = 'computer_use_decide';

/**
 * Union of every action string the `computer-use:execute` IPC channel
 * can carry — the 9-action vision enum plus the conditional context
 * actions. Tool-level schemas stay separate; only the main-process
 * dispatcher and the envelope type see the union.
 */
export type ComputerUseExecuteAction = ComputerUseAction | ComputerUseContextAction;

/**
 * Actions that require user confirmation before execution. These
 * are destructive / state-changing operations where the LLM could
 * easily misuse them.
 */
export const CONFIRM_REQUIRED_ACTIONS: ReadonlySet<ComputerUseAction> = new Set([
  'click',
  'drag',
  'set_value',
]);

/**
 * IPC channel name for the agent→main dispatch. The main process
 * handler resolves the action and forwards to DesktopBackend.
 */
export const COMPUTER_USE_IPC_CHANNEL = 'computer-use:execute';

/**
 * Approval request channel — used by the main process to push a
 * confirmation request to the renderer (Plan 454 Phase 2 Task C).
 */
export const COMPUTER_USE_APPROVAL_CHANNEL = 'computer-use:approval';

/**
 * Audit log directory under the standard DUYA logs path.
 * Phase 2 will write a single JSONL file per day here.
 */
export const COMPUTER_USE_AUDIT_DIR = 'computer-use';