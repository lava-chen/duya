/**
 * Goal mode modifier (plan 411 Phase 1).
 *
 * Goal mode is a session-level modifier that lets the user hand the agent
 * a long-running objective it drives across multiple self-driven rounds
 * until an independent verification passes (grok goal mode, duya-ized).
 *
 * Phase 1 ships the foundation: the 10-state {@link GoalTracker} mounted
 * on the 413 ModeTrackerEngine, the `update_goal` tool, and a prompt
 * prefix. Per plan 411 §4.3:
 *
 *  - `kind: 'session'` — state survives across messages (like conductor).
 *  - `tracker`         — the goal state machine; 413d's coordinator reads
 *                        it for per-round continuation injection.
 *  - `tools.inject`    — `update_goal` (model → harness completion report).
 *  - `prompt.prefix`   — the GOAL_RULES block.
 *  - no `exclusiveWith` — plan and goal are parallel trackers, not
 *    mutually exclusive (grok's model; §4.3).
 *
 * Phase 2 wires the coordinator (continuation reminders), the evaluator
 * (verification), persistence, and budget cut-off. Phase 3 adds the
 * skeptic panel + frontend card.
 */

import type { ModeModifier, ModeModifierContext, StreamOptionsPatch } from '../types.js';
import { goalModeTracker } from './goal-tracker.js';
import { getGoalTools } from './goal-tools.js';
import type { ModeTracker } from '../engine/tracker.js';
import { getGoalConfig } from './goal-config.js';

/** Cap on goal iterations per streamChat call (aligned with the agent's
 * default `maxTurns = 100`; consumed via `beforeStream` once the loop
 * merges StreamOptionsPatch — 413d wiring). */
const GOAL_MAX_ITERATIONS = 100;

/**
 * Render the GOAL_RULES prefix block. Re-evaluated per turn by the
 * streamChat refresh loop (like conductor's prefix), so the current
 * objective/status can be surfaced once the coordinator drives rounds.
 * Returns only the prefix text — the loop prepends it to the base
 * profile prompt.
 */
function buildGoalPrefix(ctx: ModeModifierContext): string {
  void ctx;
  const objective = goalModeTracker.objective();
  const state = goalModeTracker.state();
  const objectiveLine =
    objective && state !== 'idle'
      ? `\n\nCurrent objective: ${objective}`
      : '';
  return `# Goal Mode Active

You are working toward a **goal** that may require multiple rounds of work.
Drive the objective to completion yourself — do not stop after a single
answer if work remains. Keep your todo list current (≥1 in_progress item),
run targeted tests after every change, and report completion truthfully.${objectiveLine}

## Plan checklist

A goal plan file (\`.duya/goal-plan.md\` in the workspace) is seeded when the
goal starts. Keep its task checklist current: mark items done with \`- [x]\`
as you finish them and add new \`- [ ]\` items for remaining work — the next
unchecked item is surfaced to you each round.

## Starting a goal

When the user gives you a long-running objective (directly or via \`/goal <objective>\`), call \`goal_start\` with that objective. When the user sends \`/goal status\`, \`/goal pause\`, \`/goal resume\`, or \`/goal clear\`, act on the goal tracker accordingly (pause via \`update_goal\` with \`blocked_reason\`; resume/clear by reporting the current state and awaiting the user's next instruction).

## Completion

When you believe the objective is fully achieved, call \`update_goal\` with \`completed: true\` and a summary. The harness will independently verify — do not assume completion until the verification result is returned.`;
}

/**
 * Goal mode modifier — session-level, composes with the base profile,
 * no mutual exclusion with plan-task (parallel trackers, plan 411 §4.3).
 */
export const goalMode: ModeModifier = {
  id: 'goal',
  kind: 'session',
  display: { label: 'Goal', icon: 'Pin', description: '自主多轮目标追踪与核验' },

  // Goal events carry payloads (objects), unlike plan's string events, so
  // the narrowed tracker needs an explicit upcast to the shared
  // `ModeTracker<string, string, unknown>` shape (same rationale as the
  // engine registration in modes/index.ts).
  tracker: goalModeTracker as unknown as ModeTracker<string, string, unknown>,

  tools: {
    // `update_goal` must survive profile filtering so the model can
    // report completion under any base profile. Gated by `[goal] enabled`
    // (plan 411 Phase 4 config) — when disabled, inject nothing.
    inject: () => (getGoalConfig().enabled ? getGoalTools() : []),
    overrideFilter: true,
  },

  prompt: {
    prefix: buildGoalPrefix,
  },

  hooks: {
    beforeStream: (ctx: ModeModifierContext): StreamOptionsPatch => {
      void ctx;
      return { maxIterations: GOAL_MAX_ITERATIONS };
    },
  },
};
