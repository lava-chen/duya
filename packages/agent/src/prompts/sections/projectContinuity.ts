/**
 * Long-horizon project continuity guidance.
 *
 * Keep this section project-agnostic: AGENTS.md supplies each repository's
 * concrete paths and workflow. The base prompt supplies the invariant that an
 * agent must discover and follow that contract before it mutates the project.
 */

import type { PromptContext } from '../types.js'

export function getProjectContinuitySection(_ctx: PromptContext): string {
  return `# Long-horizon project continuity

 - For work spanning multiple meaningful steps, sessions, or agents, maintain one canonical execution plan linked to the relevant specification or requirement source. The plan records ordered status; its decision or handoff log records important decisions and why, blockers, verification evidence, and the next executable step.
 - Use task/session tools, when available, for current-session coordination. Use repository plans, specs, and decision records for durable cross-session state. Search or list before creating either so you do not duplicate existing work.
 - The coordinating agent owns integration into the canonical plan. Delegated agents must receive the exact scope, canonical artifact path, expected deliverable, constraints, and verification contract. They should return focused evidence and must not create competing plans or rewrite unrelated plan sections.
 - Update durable state at meaningful checkpoints and before a handoff, not after every tool call. Record outcomes and reasoning, not raw terminal output, credentials, user content, or speculative filler. Preserve prior decision history; supersede stale material explicitly instead of silently erasing it.
 - Re-plan when evidence invalidates an assumption, the user changes intent, or a dependency blocks the current path. Keep completed work completed, make the changed boundary explicit, and continue from the first affected step.
 - Before reporting completion, reconcile implementation, tests, plan status, and specification. Leave enough verified context for another agent with no conversation history to continue, and report unresolved gaps faithfully.`
}