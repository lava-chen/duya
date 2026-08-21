/**
 * researchMode — modifier-paradigm ModeModifier for Deep Research (plan 423).
 *
 * Research mode shapes agent behavior through a prompt prefix (research
 * methodology), a tool block list (no writes, no canvas), and a session-level
 * state machine {@link ResearchTracker} that drives lifecycle state, per-round
 * reminders, and runtime tool gating. It does NOT take over the stream — the
 * standard DuyaAgent.streamChat loop drives the entire workflow. Every search,
 * fetch, and source evaluation is a normal tool_use/tool_result pair visible
 * in chat.
 *
 * Since plan 423 the mode is session-typed (`kind: 'session'`) and carries a
 * {@link ResearchTracker}: the state machine survives across messages, persists
 * via plan 413c `mode_state_snapshots`, and enables state-based runtime tool
 * gating (plan 423 §3.4, coordinator `filterTools` research branch).
 *
 * Symmetric with plan-task-mode.ts / goal-mode.ts: modifier paradigm, no
 * orchestrator. Clarification uses the standard ask_user_question tool.
 */

import type { ModeModifier } from './types.js';
import { researchModeTracker } from './research-mode/research-tracker.js';
import { getResearchTools } from './research-mode/research-tools.js';
import { getResearchConfig } from './research-mode/research-config.js';
import type { ModeTracker } from './engine/tracker.js';

/**
 * System prompt prefix prepended in research mode.
 *
 * Instructs the agent to follow a research methodology
 * (clarify -> plan -> search -> evaluate -> iterate -> synthesize). The state
 * machine enforces the lifecycle and gates tools; the prompt keeps the
 * methodology legible to the model.
 */
const RESEARCH_MODE_PROMPT = `# Deep Research Mode Active

You are now in **Deep Research Mode**. Your goal is to conduct a rigorous research investigation using the available tools (web_search, web_fetch, read, glob, grep, session_search, ask_user_question, vision) and produce a comprehensive research report.

## Starting & Finalizing

- When the user asks you to research a topic, call \`research_start\` with the query to begin the research run.
- When you have written the report to a local markdown file, call \`research_report(completed: true, title: <short title>, file_path: <path to the written report file>)\` to finalize. The report content is read from the file, so do not paste it back into the tool call. It is only accepted while you are synthesizing.

## Research Workflow

1. **Clarify** — If the query is ambiguous, use \`ask_user_question\` to clarify scope, depth, and success criteria. Do not over-ask; one focused round is usually enough.

2. **Plan** — Before searching, briefly outline:
   - Key sub-questions to investigate
   - Search strategies and source types to prioritize
   - What "sufficient coverage" looks like for this query

3. **Search & Gather** — Execute searches iteratively:
   - Start broad, then refine based on findings
   - Use multiple query formulations when initial results are sparse
   - Cross-reference claims across at least 2 independent sources when factual accuracy matters
   - Fetch full pages for promising leads (don't rely on snippets alone)
   - When you have several independent sub-questions, call \`research_fanout\` (while gathering) to spawn parallel Research sub-agents and aggregate their findings

4. **Evaluate** — For each source, consider:
   - Authority: who published this, and why should I trust them?
   - Recency: is the information current enough for this question?
   - Bias: what perspective does this source represent?
   - Corroboration: do other sources confirm or contradict this?

5. **Iterate** — After each batch of findings:
   - What gaps remain?
   - What contradictions need resolution?
   - Is it worth searching more, or have I hit diminishing returns?
   - If a new angle emerges, pursue it before synthesizing

6. **Synthesize** — When evidence is sufficient (or you've hit diminishing returns), write the research report as a structured markdown document.

## Constraints

- **Do NOT modify, create, or delete files.** Write/edit/bash are blocked.
- **Do NOT use canvas/conductor tools.** They are blocked in research mode.
- Use \`ask_user_question\` when you genuinely need user input — do not guess on scope-critical decisions.
- Every factual claim in your final report must be traceable to a source you actually consulted during this session.

## Report Format

When you are ready to synthesize, produce the report as a single markdown message with this structure:

\`\`\`markdown
## Research Report: <topic>

### Executive Summary
[2-3 sentence overview of findings]

### Key Findings
1. [Finding 1 — with inline source references]
2. [Finding 2 — ...]
...

### Evidence & Sources
- [Source 1 — title, url, key quote, authority/recency notes]
- [Source 2 — ...]

### Contradictions & Uncertainties
- [Unresolved conflicts, missing evidence, areas of low confidence]

### Methodology
- Brief note on what was searched, what was excluded, and why
\`\`\`

## When to Stop

Stop researching when:
- You have cross-corroborated the central claims
- Additional searches return redundant information
- You've hit the time/iteration budget the user specified
- The user asks you to wrap up

Do not stop early just because the first search returned results. Depth matters more than speed in research mode.
`;

/**
 * Research mode modifier — session-level, read-only, mutually exclusive
 * with plan-task. Composes with conductor at the registry level, but all
 * canvas tools are blocked so conductor's injections are inert under
 * research mode (intentional — research is read-only).
 */
export const researchMode: ModeModifier = {
  id: 'research',
  kind: 'session',
  exclusiveWith: ['plan-task'],
  display: { label: 'Deep Research', icon: 'Telescope', description: '多轮深度调研与报告' },

  // Research events carry payloads (objects) and the gate is state-dependent,
  // mirroring the goal tracker's explicit upcast to the shared existential
  // `ModeTracker<string, string, unknown>` shape (same rationale as
  // modes/index.ts).
  tracker: researchModeTracker as unknown as ModeTracker<string, string, unknown>,

  tools: {
    // `research_start` / `research_report` must survive profile filtering so
    // the model can start and finalize a research run under any base profile.
    // Gated by `[research] enabled` — when disabled, inject nothing.
    inject: () => (getResearchConfig().enabled ? getResearchTools() : []),
    overrideFilter: true,

    // Block write/execute/side-effect tools (same set as plan-task) plus
    // all conductor canvas tools. Uses `block` (blacklist) instead of
    // `allow` (whitelist) so read-only tools added in the future remain
    // available without updating this list.
    block: [
      // Write / execute / side-effect tools
      'bash',
      'edit',
      'write',
      'module',

      // Conductor canvas tools (13)
      'canvas_create_element',
      'canvas_batch_create',
      'canvas_delete_element',
      'canvas_move_element',
      'canvas_resize_element',
      'canvas_fill_content',
      'canvas_style_element',
      'canvas_list_elements',
      'canvas_find_empty_space',
      'canvas_auto_layout',
      'canvas_apply_layout',
      'canvas_capture',
      'canvas_get_knowledge',
    ],
  },

  prompt: {
    prefix: RESEARCH_MODE_PROMPT,
  },
};