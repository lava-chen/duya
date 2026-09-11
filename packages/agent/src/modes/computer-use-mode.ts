/**
 * computer-use-mode.ts — Computer Use Mode ModeModifier (plan 454 §5 Task A).
 *
 * Session-level mode that exposes the `computer_use` tool to the
 * agent. The mode is exclusive with every other session-level mode
 * (plan-task / research / conductor / goal) because computer-use is
 * an OS-level takeover — composing it with another mode would create
 * ambiguous tool priority and unsafe overlay behavior.
 *
 * Lifecycle (mirrors conductor-mode.ts structure):
 *   - onEnter: enable OSContextBridge, ensure the daemon is running,
 *     and surface `computerUseMode` to tool use context so tools can
 *     branch on it.
 *   - onExit: disable OSContextBridge (the daemon stays running for
 *     Wake Agent reuse).
 *   - persist: empty object — Computer Use mode has no per-session
 *     private state in Phase 2.
 *
 * Tool injection: the single `computer_use` tool with 9-action enum
 * (Phase 2 decision: single tool + action enum, hermes-agent style).
 * plan 519 §3.2 (D2) adds a conditional sibling — `computer_use_context`
 * (list_apps / focus_app) — injected only when the vision path armed
 * its escape hatch (0-element SOM capture / suspected_noop click /
 * explicit prior call); the 9-action enum itself is never widened.
 * `overrideFilter: true` so the tools survive even under restrictive
 * agent profiles.
 *
 * Phase 2 deliberately does NOT include `tracker` — Computer Use is
 * stateless at the session level. Phase 3 may add a tracker if we
 * introduce session-level safety budgets.
 */

import type { ModeModifier } from './types.js';
import {
  clearComputerUseContextTrigger,
  getComputerUseTools,
  getComputerUseToolsWithContext,
  shouldInjectComputerUseContext,
} from '../tool/OSTool/index.js';

export const COMPUTER_USE_MODE_ID = 'computer-use';

/**
 * System prompt prefix prepended while Computer Use mode is active
 * (plan 454 follow-up). Written in the codex-skill style: short
 * imperative sections the model can follow mechanically —
 * operating loop, coordinate rules, refusals-as-policy, recovery.
 *
 * The coordinate section is load-bearing: the capture image is in
 * logical pixels, the mouse in physical pixels, and after a `zoom`
 * coords are relative to the crop. The main-process dispatcher
 * handles the mapping, but the model must know WHICH image its
 * coordinates refer to.
 */
const COMPUTER_USE_PROMPT = `# Computer Use Mode

You drive the host desktop through the \`computer_use\` tool only (screenshot + mouse + keyboard). No app/window enumeration, no focus-by-name — navigate by looking. The full manual is in the \`computer-use\` skill.

## Operating loop (every step)
1. **LOOK** — \`capture(somMode=true)\`; never act on a screen state you have not just seen.
2. **ZOOM when unsure** — small text/dense toolbar/dialog: \`zoom(x, y, w, h)\`, read the crop before clicking.
3. **ACT** — one state change: \`click\` / \`type\` / \`key\` / \`scroll\` / \`drag\` / \`set_value\`.
4. **VERIFY** — \`capture(somMode=true)\` again; confirm it landed before the next step. For text, click the field first, then \`type\`; \`set_value\` replaces the whole focused value.

## Coordinates
- \`x\`/\`y\` are pixels in the **last image you received** (full screen or zoom crop). After \`zoom\`, coords are relative to the crop (top-left 0,0) until your next full \`capture\`; the backend maps to real screen — do not add offsets. Copy what you see; never guess from memory.

## Verdict (in \`data.verdict.effect\` after state changes)
- \`confirmed\` — it landed; continue.
- \`unverifiable\` — could not tell; re-capture and read the screen yourself.
- \`suspected_noop\` — no on-screen change; **re-capture FIRST to see the state, then decide. Never blindly re-issue the same action / don't double-click.**

## Refusals are policy, not bugs
- \`APP_BLOCKED\` (app not allow-listed) / \`REDACTED_FIELD\` (password field) / \`BLOCKED\` (safety rule) / \`USER_REJECTED\` (declined) all mean: **stop that approach and tell the user** — no variations, no retries.

## Pacing & limits
- One action per step; after launching/menu/form, \`wait\` 1–3s and re-capture. If a goal eludes you after ~3 attempts, stop and report what you see instead of guessing.`;

/**
 * Computer Use Mode modifier — session-level, exclusive with every
 * other mode. Injects the `computer_use` tool and wires OSContext.
 */
export const computerUseMode: ModeModifier = {
  id: COMPUTER_USE_MODE_ID,
  kind: 'session',
  exclusiveWith: ['plan-task', 'research', 'conductor', 'goal'],
  display: {
    label: 'Computer Use',
    icon: 'MousePointerClick',
    description: 'Agent 可直接驱动 OS 桌面(截图 + 鼠标 + 键盘)',
  },

  tools: {
    // plan 519 §3.2 (D2) — function-form inject so the tool list is
    // decided per run. The `computer_use` vision tool (9-action enum,
    // Phase 2 decision, never widened) is always present; the
    // `computer_use_context` escape hatch (list_apps / focus_app) is
    // appended only when its sticky trigger registry is armed for the
    // session: 0-element SOM capture, suspected_noop click, or an
    // explicit prior call (see OSTool/context-tool.ts).
    inject: (ctx) =>
      shouldInjectComputerUseContext(ctx.sessionId)
        ? getComputerUseToolsWithContext()
        : getComputerUseTools(),
    // Computer Use tools must survive profile filtering — even the
    // `code` profile should see them when this mode is on.
    overrideFilter: true,
  },

  prompt: {
    // Prepended to the system prompt (same channel as plan-task /
    // research / goal). Static content — no per-turn refresh needed.
    prefix: COMPUTER_USE_PROMPT,
  },

  hooks: {
    /**
     * Phase 2 lazy-imports the Electron-side services to avoid a hard
     * dependency from @duya/agent to the electron tree. Production
     * registers the relevant singletons at boot (electron/main.ts);
     * if they're unavailable (e.g. in a unit test), we still record
     * the intent in ctx.state so downstream tools can detect the
     * missing bridge and surface a structured error.
     */
    onEnter: async (ctx) => {
      let bridgeEnabled = false;
      let daemonRunning = false;
      try {
        const bridge = await import('../context/os-context/index.js');
        bridge.getOSContextBridge().enable();
        bridgeEnabled = true;
      } catch {
        // Bridge not available in this environment (tests, CLI).
      }
      try {
        // The daemon singleton is owned by the Electron main; we
        // poke it indirectly via an IPC call. Phase 3 may expose a
        // direct accessor on the bridge.
        ctx.toolUseContextPatch = {
          ...(ctx.toolUseContextPatch ?? {}),
          computerUseMode: true,
          computerUseBridgeEnabled: bridgeEnabled,
        };
      } catch {
        // ignore
      }
      ctx.state.computerUseBridgeEnabled = bridgeEnabled;
      ctx.state.computerUseDaemonRunning = daemonRunning;
    },

    onExit: async (ctx) => {
      // plan 519 §3.2 (D2): the conditional `computer_use_context`
      // escape hatch is armed per session — disarm it when the mode
      // is toggled off so it doesn't outlive Computer Use.
      clearComputerUseContextTrigger(ctx.sessionId);
      try {
        const bridge = await import('../context/os-context/index.js');
        bridge.getOSContextBridge().disable();
      } catch {
        // Bridge not available; nothing to disable.
      }
    },
  },

  // No per-session state in Phase 2. Keep the contract honest.
  persist: {
    serialize: () => ({}),
    deserialize: () => ({}),
  },
};