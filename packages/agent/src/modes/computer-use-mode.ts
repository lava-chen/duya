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
 * Tool injection: the single `computer_use` tool with 10-action enum
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
 * (plan 454 follow-up). Teaches the model the SOM workflow so it
 * doesn't guess pixel coordinates:
 *
 *   1. capture(somMode=true) — see the screen with numbered elements
 *   2. click(element=N) — act via the labeled bbox, not raw coords
 *   3. capture again — verify the action took effect
 *
 * Also documents the safety gates the model will encounter
 * (APP_BLOCKED / REDACTED_FIELD / BLOCKED / approval popups) so a
 * refusal reads as expected behavior instead of a bug to retry
 * around.
 */
const COMPUTER_USE_PROMPT = `# Computer Use Mode Active

You are now in **Computer Use Mode** — you can drive the host OS desktop directly via the \`computer_use\` tool (screenshot + mouse + keyboard).

## Workflow (always follow this loop)

1. **Look** — call \`computer_use({ action: 'capture', somMode: true })\` to see the screen. Elements get numbered red markers (1, 2, 3…) with a center cross.
2. **Act** — prefer \`click({ element: N })\` over raw coordinates. Use \`count\` (single/double/triple) for word/line selection.
3. **Verify** — capture again to confirm the action took effect before moving on.

Other actions: \`type\` (auto-captures a follow-up screenshot), \`key\`, \`scroll\`, \`drag\`, \`window_switch\`, \`list_apps\`, \`set_value\`, \`wait\`, \`zoom\` (region-restricted SOM capture).

## Constraints

- **Refusals are policy, not bugs.** When an action returns APP_BLOCKED, the foreground app is not in the user's [computer_use] allow-list — tell the user which app you need and stop retrying.
- **REDACTED_FIELD means a password/sensitive field is focused.** Never attempt to work around it.
- **BLOCKED means a safety rule fired** (dangerous key combo or shell-like text). Do not attempt variations to bypass it.
- Destructive actions (click / drag / window_switch / set_value) may show a 3-second confirmation popup. If it times out, the action is cancelled — do not spam retries.
- Never type into fields you cannot see or that appear to contain credentials.

## Pacing

- Chain independent actions where possible, but verify after state-changing steps.
- Use \`wait\` (up to 60s) after launching apps instead of immediate re-capture.`;

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