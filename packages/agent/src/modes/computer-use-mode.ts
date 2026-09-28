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
 * plan 575 follow-up: the `computer_cua` 14-tool structural channel
 * (ZCode-aligned receipts) is now ALWAYS injected alongside — both
 * surfaces share the same execution guard (revoke + app policy) and
 * the same approval channel on the Electron side.
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
  getComputerUseToolsWithCua,
  isComputerUseDecideAvailable,
  shouldInjectComputerUseContext,
} from '../tool/OSTool/index.js';

export const COMPUTER_USE_MODE_ID = 'computer-use';

/**
 * System prompt prefix prepended while Computer Use mode is active
 * (plan 454 follow-up). Written in the codex-skill style: short
 * imperative sections the model can follow mechanically —
 * operating loop, coordinate rules, refusals-as-policy, recovery.
 *
 * plan 564 re-orders the loop around the STRUCTURAL channel: the
 * accessibility tree (`tree`) is the primary observation + targeting
 * surface, `invoke` / `set_value(element=)` are the primary actions —
 * they work on background windows, bypass IME for text, and never
 * depend on pixels. The vision loop (capture + coordinate click) is
 * the AUXILIARY fallback for custom-drawn windows and visual
 * verification. The coordinate section stays load-bearing for that
 * fallback: the capture image is in logical pixels, the mouse in
 * physical pixels, and after a `zoom` coords are relative to the crop.
 */
const COMPUTER_USE_PROMPT = `# Computer Use Mode

You drive the host desktop through the \`computer_use\` tool. Two channels:

- **STRUCTURAL (primary)** — \`tree\` reads the target window's accessibility tree (element index, role, name, value, real coordinates); \`invoke\` presses buttons / toggles / expands menus / selects items / focuses fields through the OS accessibility layer; \`set_value(element=n, ...)\` writes fields atomically. This channel works on **background windows**, needs no pixels, and set_value bypasses the IME (reliable for CJK).
- **VISION (auxiliary)** — \`capture\` / \`zoom\` + coordinate \`click\` / \`drag\` / \`type\`. Use it when the tree is empty or unreliable (custom-drawn apps, games, some browser content) and to visually verify effects.

## Operating loop (every step)
1. **TARGET** — \`tree\` first. Read roles/names/values, pick the element index. Re-run \`tree\` after navigation or scrolling — indices are only valid for the window state you observed.
2. **ACT structurally** — \`invoke(element=n)\` for buttons/menu items/tabs/lists; \`set_value(element=n, value=...)\` for text fields; \`invoke(element=n, method="focus")\` + \`type\` when a field needs real keystrokes; \`key\` for shortcuts; \`invoke(element=n, method="setValue", value=...)\` equals set_value(element).
3. **VERIFY cheaply** — \`tree\` again (no pixels) or read the invoke result's pattern/element read-back. Use \`capture(somMode=true)\` when you need to SEE the effect.
4. **Fall back to vision** when: \`tree\` returns 0 elements or misses the control; invoke reports \`no-pattern\` twice; or STRUCTURAL_UNAVAILABLE. Then: \`capture(somMode=true)\` → \`zoom\` on dense areas → \`click(x,y)\`, one state change per step. On \`stale-tree\`, re-run \`tree\` (invoke already retried once) — never fire indices from an old listing.

## Coordinates (vision fallback only)
- \`x\`/\`y\` are pixels in the **last image you received** (full screen or zoom crop). After \`zoom\`, coords are relative to the crop (top-left 0,0) until your next full \`capture\`; the backend maps to real screen — do not add offsets. Copy what you see; never guess from memory.

## Indexes are per-observation
- \`invoke\`/\`set_value\` \`element\` = 1-based \`tree\` index. SOM markers on a capture are a DIFFERENT numbering (only valid for \`click element=\`). Do not mix them.

## Verdict (in \`data.verdict.effect\` after vision state changes)
- \`confirmed\` — it landed; continue.
- \`unverifiable\` — could not tell; re-observe and judge yourself.
- \`suspected_noop\` — no on-screen change; **re-observe FIRST (tree or capture), then decide. Never blindly re-issue the same action / don't double-click.**

## Refusals are policy, not bugs
- \`APP_BLOCKED\` (app not allow-listed) / \`REDACTED_FIELD\` (password field) / \`BLOCKED\` (safety rule) / \`USER_REJECTED\` (declined) all mean: **stop that approach and tell the user** — no variations, no retries.

## Pacing & limits
- One action per step; after launching/menu/form, \`wait\` 1–3s and re-observe. If a goal eludes you after ~3 attempts, stop and report what you see instead of guessing.`;

/**
 * plan 551 Phase 3 — decide-channel section, appended to the prompt only
 * when the `computer_use_decide` tool is actually injected (no decision
 * backend → no tool → no prompt mention of a phantom tool).
 */
const COMPUTER_USE_DECIDE_PROMPT = `

## Delegated sub-goals (computer_use_decide)
- For a bounded sub-goal ("log in", "open settings", "fill this form"), state the outcome once and let \`computer_use_decide\` run the look-decide-act loop — it is far cheaper than reading every screen yourself.
- Pass exact field texts via \`values\`; the channel never invents text.
- \`status=done\` → continue your plan. \`likely_done\` → verify yourself. \`needs_confirmation\` → the user must approve a risky action. \`error | stuck | ambiguous | blocked | max_actions\` → take over with the vision loop above (ambiguous lists top candidates).`;

/**
 * plan 575 follow-up — `computer_cua` rides the same mode. Kept short:
 * the 14 sub-tools document themselves in-schema; the prompt only pins
 * the two-tool contract and the shared-safety fact.
 */
const COMPUTER_USE_CUA_PROMPT = `

## CUA channel (computer_cua)
- \`computer_cua\` is the receipt-grade sibling of \`computer_use\`: one call = one sub-tool (list_apps / list_windows / get_app_state / left_click / left_click_drag / scroll / type / key / set_value / select_text / perform_action / paste / request_access / stop_computer_control). Every action returns a receipt (\`actionSent\`, \`dispatchStatus\`, \`targetVerificationStatus\`); \`get_app_state\` returns window + tree + optional screenshot in one shot.
- Keep \`computer_use\` as your primary loop. Reach for \`computer_cua\` when you need a trusted, validated dispatch on a specific element (background-window clicks, \`set_value\` you will verify, \`paste\` for long text without IME).
- Both surfaces enforce the SAME gates — app allow-list policy and user approval. \`NOT_AUTHORIZED\` / \`PERMISSION_DENIED\` from either surface are refusals-as-policy: stop and tell the user.

## Switching apps (computer_cua)
- To work on another app, \`get_app_state\` it by name / pid / windowId — no app ever needs the foreground. \`list_windows\` lists minimized windows too (\`minimized: true\`), and a minimized window's tree is still readable.
- \`includeScreenshot=true\` on a minimized window first restores it WITHOUT stealing the user's focus, so tree bounds and pixels share one post-restore layout; a pure-tree observation keeps it minimized.
- An app that is not running cannot be observed: launch it first via the Bash tool (\`start "QQ"\` or \`Start-Process\`), wait for its window, then get_app_state it — the CUA surface has no launch primitive.
- After switching apps or surfaces, re-observe before acting — element indices and screenshot coordinates belong to the observation that produced them.`;

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
    description: 'Agent 直接驱动 OS 桌面(结构化 UIA 控制为主,截图+鼠标为辅)',
  },

  tools: {
    // plan 519 §3.2 (D2) + plan 551 Phase 3 + plan 575 follow-up —
    // function-form inject so the tool list is decided per run. The
    // `computer_use` vision tool (9-action enum, never widened) and the
    // `computer_cua` 14-tool structural channel are always present; the
    // `computer_use_context` escape hatch is appended when its sticky
    // trigger registry is armed; the `computer_use_decide` delegated-goal
    // tool is appended only when a decision backend is configured.
    inject: (ctx) =>
      getComputerUseToolsWithCua(shouldInjectComputerUseContext(ctx.sessionId)),
    // Computer Use tools must survive profile filtering — even the
    // `code` profile should see them when this mode is on.
    overrideFilter: true,
  },

  prompt: {
    // plan 551 Phase 3 + plan 575 follow-up: the decide section rides
    // along only when the decide tool is actually injected; the CUA
    // section is always present (the CUA tool always is). PromptBuilder
    // contract: return the FULL prompt (prefix + incoming base).
    prefix: (_ctx, base) =>
      COMPUTER_USE_PROMPT +
      COMPUTER_USE_CUA_PROMPT +
      (isComputerUseDecideAvailable() ? COMPUTER_USE_DECIDE_PROMPT : '') +
      base,
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