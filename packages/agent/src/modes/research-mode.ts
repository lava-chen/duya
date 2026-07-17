/**
 * researchMode — modifier-paradigm ModeModifier for Deep Research.
 *
 * Research mode shapes agent behavior through a prompt prefix (research
 * methodology) and a tool block list (no writes, no canvas). It does
 * NOT take over the stream — the standard DuyaAgent.streamChat loop
 * drives the entire workflow. Every search, fetch, and source
 * evaluation is a normal tool_use/tool_result pair visible in chat.
 *
 * Symmetric with plan-task-mode.ts: both use prompt.prefix + tools.block
 * instead of an orchestrator. Clarification uses the standard
 * ask_user_question tool — no bespoke IPC channel.
 *
 * Migration (plan 224 follow-up): the previous orchestrator-paradigm
 * implementation (research-mode/ directory + researchRunDb.ts) is
 * deleted. The Orchestrator paradigm itself is retained in
 * ModeModifierOrchestrator for future modes.
 */

import type { ModeModifier } from './types.js';

/**
 * System prompt prefix prepended in research mode.
 *
 * Instructs the agent to follow a research methodology
 * (clarify -> plan -> search -> evaluate -> iterate -> synthesize)
 * without hardcoding a state machine. The agent uses existing
 * read-only tools (web_search, web_fetch, read, glob, grep,
 * session_search, wiki_search, wiki_read, ask_user_question, vision)
 * and produces a structured markdown report.
 */
const RESEARCH_MODE_PROMPT = `# Deep Research Mode Active

You are now in **Deep Research Mode**. Your goal is to conduct a rigorous research investigation using the available tools (web_search, web_fetch, read, glob, grep, session_search, wiki_search, wiki_read, ask_user_question, vision) and produce a comprehensive research report.

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
 * Research mode modifier — per-message, read-only, mutually exclusive
 * with plan-task. Composes with conductor at the registry level, but
 * all canvas tools are blocked so conductor's injections are inert
 * under research mode (intentional — research is read-only).
 */
export const researchMode: ModeModifier = {
  id: 'research',
  kind: 'message',
  exclusiveWith: ['plan-task'],
  display: { label: 'Deep Research', icon: 'Telescope' },

  tools: {
    // Block write/execute/side-effect tools (same set as plan-task) plus
    // all conductor canvas tools. Uses `block` (blacklist) instead of
    // `allow` (whitelist) so read-only tools added in the future remain
    // available without updating this list.
    block: [
      // Write / execute / side-effect tools
      'bash',
      'edit',
      'write',
      'enter_worktree',
      'exit_worktree',
      'team_create',
      'team_delete',
      'skill_manage',
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
