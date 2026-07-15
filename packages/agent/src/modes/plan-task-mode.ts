/**
 * Plan-task mode modifier (plan 224 Phase 4).
 *
 * Read-only planning mode: the agent analyzes the codebase and produces
 * a structured plan without making any changes. Write/execute tools are
 * blocked so the model cannot accidentally mutate the filesystem or run
 * side-effectful commands while planning.
 *
 * The modifier paradigm (tools.block + prompt.prefix) composes with the
 * normal agent loop — no orchestrator takeover. This fixes the
 * long-standing "Unknown mode: plan" broken chain (the popover exposed
 * `modeValue: 'plan'` but `ModeRegistry` only registered 'research').
 *
 * Mutual exclusion: plan-task conflicts with research (research has its
 * own multi-stage flow that shouldn't be mixed with planning) and
 * conductor (conductor needs to write canvas elements, plan-task is
 * read-only).
 */

import type { ModeModifier } from './types.js';

/**
 * System prompt prefix prepended in plan-task mode.
 *
 * The prompt instructs the model to:
 *   1. Only analyze — never modify files or execute commands
 *   2. Produce a structured plan as a markdown document
 *   3. Use read-only tools (read, glob, grep, task, etc.) to investigate
 *   4. Identify affected files, risks, and a step-by-step implementation plan
 *   5. End with a clear summary the user can approve before switching modes
 */
const PLAN_TASK_PROMPT = `# Plan Mode Active

You are now in **Plan Mode** — a read-only analysis mode. Your goal is to investigate the user's request, understand the codebase, and produce a structured implementation plan **without making any changes**.

## Constraints

- **Do NOT modify, create, or delete any files.** Write/edit/bash tools are blocked.
- **Do NOT execute commands with side effects.** Bash is blocked.
- **Do NOT create background agents or worktrees.** Team/worktree tools are blocked.
- Use only read-only tools: \`read\`, \`glob\`, \`grep\`, \`task\` (for structuring the plan), \`session_search\`, \`ask_user_question\`, \`web_search\`, \`web_fetch\`, \`wiki_search\`, \`wiki_read\`.

## Workflow

1. **Ground** — Apply the base Project Grounding contract first: read scoped AGENTS.md, the repository's plan/spec indexes, and any clearly overlapping active artifact. Continue a matching plan instead of drafting a competing one.
2. **Investigate** — Read the relevant implementation and trace the real runtime/data path. Search broadly enough to identify dependencies and prior attempts, but stop when more discovery cannot change the proposed implementation or verification strategy.
3. **Identify** — Determine the source of truth, affected files, constraints, risks, edge cases, migration or compatibility concerns, and testing strategy. Separate verified facts from assumptions and open questions.
4. **Plan** — Update the canonical existing plan when one clearly applies; otherwise produce a clear, ordered implementation plan. Every step must state the concrete outcome, likely files or subsystem, dependency, and verification checkpoint.
5. **Reconcile** — Check the plan against the user's request, relevant spec, current architecture, and working-tree constraints. End with a concise summary the user can approve.

## Output Format

Structure your plan as:

\`\`\`markdown
## Investigation Summary
[Brief findings from reading the codebase]

## Affected Files
- \`path/to/file.ts\` — [what changes and why]
- ...

## Implementation Steps
1. [Step 1 — specific action, file, and rationale]
2. [Step 2 — ...]
...

## Risks & Considerations
- [Risk 1 and mitigation]
- ...

## Assumptions & Open Questions
- [Only questions or assumptions that materially change implementation]

## Testing Strategy
- [How to verify the changes work]

## Summary
[One-paragraph summary the user can approve to proceed]
\`\`\`

## When to Exit Plan Mode

After presenting the plan, ask the user whether they want to proceed with implementation. If they approve, they will switch out of Plan Mode (or you may call \`exit_plan_mode\` if available) and the write/execute tools will become available again.

Do not begin implementation until the user explicitly approves the plan and exits Plan Mode.
`;

/**
 * Plan-task mode modifier — per-message, read-only, mutually exclusive
 * with research and conductor.
 */
export const planTaskMode: ModeModifier = {
  id: 'plan-task',
  kind: 'message',
  exclusiveWith: ['research', 'conductor'],
  display: { label: 'Plan Mode', icon: 'ListChecks' },

  tools: {
    // Block all write/execute/side-effect tools. Using `block` rather
    // than `allow` so new read-only tools automatically remain
    // available without updating this list.
    block: [
      'bash',
      'edit',
      'write',
      'enter_worktree',
      'exit_worktree',
      'team_create',
      'team_delete',
      'skill_manage',
      'module',
    ],
  },

  prompt: {
    prefix: PLAN_TASK_PROMPT,
  },
};
