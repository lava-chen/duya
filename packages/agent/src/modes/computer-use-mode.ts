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
 * `overrideFilter: true` so the tool survives even under restrictive
 * agent profiles.
 *
 * Phase 2 deliberately does NOT include `tracker` — Computer Use is
 * stateless at the session level. Phase 3 may add a tracker if we
 * introduce session-level safety budgets.
 */

import type { ModeModifier } from './types.js';
import { getComputerUseTools } from '../tool/OSTool/index.js';

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

You control the host desktop through the \`computer_use\` tool only (screenshot + mouse + keyboard). There is no app/window enumeration and no focus-by-name — you navigate entirely by looking.

## Operating loop (every step)

1. **LOOK** — \`capture(somMode=true)\`. Read the full screen. Never act on a screen state you have not just seen.
2. **ZOOM when unsure** — small text, dense toolbars, or a specific dialog: \`zoom(x, y, w, h)\` around the area. Read the returned image before clicking.
3. **ACT** — one state-changing step: \`click\`, \`type\`, \`key\`, \`scroll\`, \`drag\`, or \`set_value\`.
4. **VERIFY** — \`capture(somMode=true)\` again. Confirm the step did what you intended before the next one. If nothing changed, diagnose (wrong target? menu still loading?) instead of repeating blindly.

## Coordinates — read this carefully

- \`x\`/\`y\` are pixels in the **last image you received**: the full-screen capture, or the zoom crop.
- After a \`zoom\`, coordinates are relative to the cropped image (its top-left is 0,0) until your next full \`capture\` resets the frame. The backend handles the mapping to real screen space — do not add offsets yourself.
- Copy coordinates from what you see; never estimate from memory of a previous screenshot.
- For text input, click the field first, then \`type\`. \`set_value\` replaces the whole value of the focused field.

## Pacing

- One action per step; verify after each state change.
- After launching an app, opening a menu, or submitting a form, \`wait\` 1–3s before re-capturing — screens take time to settle.
- Long renders (app splash screens, file dialogs): \`wait\` then capture again rather than clicking on a stale screenshot.

## Refusals are policy, not bugs

- \`APP_BLOCKED\` — the foreground app is not in the user's allow-list. Tell the user which app you need and stop.
- \`REDACTED_FIELD\` — a password or sensitive field is focused. Never work around it.
- \`BLOCKED\` — a safety rule fired (dangerous key combo, shell-like text). Do not try variations.
- \`USER_REJECTED\` or confirmation timeout — the user declined. Stop that approach; ask the user.
- Control may be revoked at any moment by the user (stop button on the control overlay). If actions start failing after a revocation, stop and hand control back to the user.

## Hard limits

- Never type into fields you cannot see, or that appear to contain credentials.
- No destructive system actions (deleting files via dialogs, closing unsaved work, changing system settings) unless the user explicitly asked for that exact outcome.
- If you cannot reach a goal after ~3 failed attempts, stop and report what you see instead of guessing.`;

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
    // Single tool + 10-action enum (Phase 2 decision — single tool +
    // action enum, recommended default per plan §7 #1).
    inject: () => getComputerUseTools(),
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

    onExit: async () => {
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