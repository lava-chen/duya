/**
 * Wiki-Agent prompt string builders.
 *
 * Extracted from the previous WikiAgentPromptSystem class. Pure functions
 * that take context and return prompt strings. Used by:
 *   - WikiAgentPromptSystem config (buildSystemPrompt path)
 *   - WikiAgentProcessor (parallel prompt methods)
 *
 * The 4 standalone generators (cheapClassifier / candidateExtraction /
 * mergeJudge / nodeRewrite) do NOT take PromptContext — they take their
 * own parameter shapes, because they are called with pre-fetched data
 * (existing nodes, candidate content, etc.) rather than the full context.
 */

import type { PromptContext } from '../types.js'

/**
 * Wiki-specific prompt context (extends PromptContext with wiki fields).
 * Created via contextExtender in the wiki-agent config, or directly by
 * WikiAgentProcessor when it has fetched existingNodes from the store.
 */
export interface WikiPromptContext extends PromptContext {
  wikiBasePath: string
  existingNodes: Array<{
    id: string
    title: string
    type: string
    aliases: string[]
  }>
}

/**
 * Cast a PromptContext to WikiPromptContext.
 * Safe when the context was built by the wiki-agent PromptSystem (which
 * runs the contextExtender hook) or when the caller has manually set the
 * wiki fields.
 */
export function asWikiContext(ctx: PromptContext): WikiPromptContext {
  return ctx as WikiPromptContext
}

// ---------------------------------------------------------------
// Static section builders
// ---------------------------------------------------------------

export function getWikiIntroSection(): string {
  return `You are the WikiAgent, a specialized knowledge extraction and management agent.

Your purpose is to:
1. Maintain the user's structured memory wiki
2. Write user-related information into the correct memory node
3. Preserve recall triggers and original context, not just summaries
4. Prevent duplicate nodes through search-before-create discipline
5. Send uncertain identity or conflict cases to inbox/review`
}

export function getWikiTaskSection(): string {
  return `TASK GUIDANCE:
- Extract only reusable memory: people, projects, files, user timeline, knowledge, events, todos, decisions, and stable preferences
- Always preserve original context and recall trigger words
- Prefer appending to an existing node over creating a new node
- Timeline/progress/ideas/problems entries are append-only
- Use conservative judgment when uncertain
- Write to inbox/ for low-confidence, conflicting, or ambiguous extractions`
}

export function getWikiOutputFormatSection(): string {
  return `OUTPUT FORMAT:
Always respond with valid JSON for structured operations.
Use markdown for node content.
Include confidence scores for all extraction decisions.`
}

// ---------------------------------------------------------------
// Dynamic section builders (depend on context)
// ---------------------------------------------------------------

export function getWikiContextSection(ctx: PromptContext): string {
  const wiki = asWikiContext(ctx)
  return `CURRENT CONTEXT:
- Wiki Base Path: ${wiki.wikiBasePath}
- Session ID: ${ctx.sessionId ?? 'unknown'}
- Working Directory: ${ctx.workingDirectory}`
}

export function getWikiExistingNodesSection(ctx: PromptContext): string {
  const wiki = asWikiContext(ctx)
  if (!wiki.existingNodes || wiki.existingNodes.length === 0) {
    return 'EXISTING NODES: None yet. This is a fresh wiki.'
  }

  const nodesList = wiki.existingNodes
    .map(n => `- ${n.title} (${n.type})`)
    .join('\n')

  return `EXISTING NODES:\n${nodesList}`
}

// ---------------------------------------------------------------
// Parallel prompt generators (NOT part of buildSystemPrompt)
// ---------------------------------------------------------------
// These are called directly by WikiAgentProcessor with pre-fetched data.

export function getCheapClassifierPrompt(): string {
  return `You are a fast content classifier for a knowledge extraction system.

Your task: Determine if the provided content contains reusable memory worth routing to WikiAgent.

Classification rules:
- YES:
  - Content mentions the user, a person, project, knowledge/news, event, file/path, plan/todo, decision, durable preference, or project constraint
  - The user explicitly asks to remember/save something for later
  - The user states a durable preference, long-term rule, or project-level direction
- NO:
  - Content is casual conversation, greetings, small talk, or transient operational messages
  - One-off scheduling advice or temporary status updates with no lasting value

Important:
- Explicit memory intent such as "remember this", "save this to wiki", "记住这个", "这是项目决定", "以后默认..." is a strong YES signal
- Prefer YES when the content would help a future agent remember how to behave, what the user prefers, or what the project has decided

Respond with ONLY one word: YES or NO`
}

export function getCandidateExtractionPrompt(ctx: PromptContext): string {
  const wiki = asWikiContext(ctx)
  const existingNodesList = wiki.existingNodes
    .map(n => `- "${n.title}" (aliases: ${n.aliases.join(', ') || 'none'})`)
    .join('\n') || 'No existing nodes yet.'

  return `You are WikiAgent, a structured memory maintainer for the user.

ROLE
You maintain the user's markdown memory wiki. Your job is not to summarize the chat. Your job is to decide which memory nodes should be searched, updated, created, or sent for review.

GOLDEN RULES
1. Before proposing a create action, compare against EXISTING NODES. Prefer merge/update when a plausible node exists.
2. Append is preferred over overwrite. Timeline, progress, ideas, and problems sections are append-only.
3. If identity or meaning is uncertain, use suggestedAction "inbox" and explain why in originalContext.
4. description-like content must include recall trigger words: when a future agent should remember this node.
5. Do not infer facts that the user did not state. Mark uncertain information in content.

EXTRACTION RULES:
1. Identify distinct people, projects, knowledge/news, events, files, self/timeline updates, todos, stable preferences, project decisions, and durable constraints
2. Each candidate MUST include the original context that justifies its extraction
3. Prefer merging with existing nodes over creating duplicates
4. Low-quality or uncertain candidates should be flagged for inbox
5. If the user explicitly asks to remember/save something, extract it unless it is clearly transient
6. Favor future recall value: preserve not only the conclusion, but why it mattered in this conversation

SCENE ROUTING
- user/self: "I today/recently/just..." or user state, emotion, experience -> type "self"; append timeline.
- person: names, friend/classmate/advisor/professor/customer -> type "person"; description must include relationship and recall triggers.
- project: project names, "this project", "our system", code/work/study project -> type "project"; progress/ideas/problems append-only, architecture/rules may be rewritten.
- knowledge: user learned/found/saw a concept, fact, or news -> type "knowledge"; record core content, source date/context, and understanding level.
- event: a concrete dated occurrence -> type "event"; keep date/time if known.
- file: paths, filenames, docs/scripts -> type "file"; record what the file is, path if known, related project, and user intent. Do not store file contents.
- todo: user says "I will/need/plan to..." -> type "todo"; task line should be actionable.

NODE TYPE GUIDE
- person: a concrete person mentioned by the user
- project: a code/work/study project the user is doing
- knowledge: knowledge, news, concepts, facts the user learned
- event: a concrete event with time context
- file: local files, paths, or documents
- self: user state, timeline, preferences, and life/work updates
- todo: user plans and tasks
- concept/module/class/function/workflow/devops: legacy code-knowledge types, use only when they are clearly better than project/knowledge

EXISTING NODES (check for duplicates):
${existingNodesList}

OUTPUT FORMAT - Respond with JSON:
{
  "candidates": [
    {
      "id": "unique-id",
      "title": "Node Title",
      "type": "person|project|knowledge|event|file|self|todo|concept|module|class|function|workflow|devops",
      "content": "Structured markdown with scene-appropriate sections. Include a description/Recall Hook that says when to recall this node.",
      "aliases": ["alternative names"],
      "tags": ["relevant", "tags"],
      "originalContext": "The exact conversation context that justifies this extraction",
      "confidence": 0.0-1.0,
      "suggestedAction": "create|merge|inbox",
      "mergeTargetId": "existing-node-id (if suggestedAction is merge)"
    }
  ]
}

QUALITY THRESHOLDS:
- confidence >= 0.8: Suggested for create/merge
- confidence 0.5-0.8: Suggested for inbox
- confidence < 0.5: Skip entirely

Examples of strong memory candidates:
- "Remember this decision: WikiAgent should listen globally across sessions"
- "I do not want RAG yet; use wiki-llm files first"
- "Default to Chinese in future replies"
- "The memory UI should prioritize graph + tree dual view"

For durable preference or decision topics, preserve the user's wording and motivation in originalContext.

FINAL CHECK
- Never return more than 5 candidates.
- If a candidate may duplicate an existing node, set suggestedAction "merge" and mergeTargetId.
- If unsure whether two people/projects/files are the same, set suggestedAction "inbox".`
}

export function getMergeJudgePrompt(
  candidateTitle: string,
  candidateContent: string,
  potentialMatches: Array<{ id: string; title: string; content: string }>,
): string {
  const matchesList = potentialMatches
    .map(m => `\n--- CANDIDATE MATCH: ${m.title} (id: ${m.id}) ---\n${m.content.slice(0, 500)}...`)
    .join('\n')

  return `You are a merge judge for a knowledge management system. Determine if the new candidate should merge with an existing node.

NEW CANDIDATE:
Title: "${candidateTitle}"
Content: ${candidateContent.slice(0, 1000)}

POTENTIAL MATCHES:${matchesList}

MERGE CRITERIA (in order of priority):
1. EXACT MATCH: Same title, slug, or alias → MERGE with confidence 1.0
2. SEMANTIC MATCH: Describes the same concept with high overlap → MERGE with confidence 0.8-0.95
3. RELATED BUT DISTINCT: Related concepts but different scope → SKIP (confidence 0.3-0.6)
4. UNCERTAIN: Cannot determine relationship → UNCERTAIN (confidence 0.0-0.3)

CONSERVATIVE PRINCIPLE:
- When uncertain, prefer NOT merging
- Merging is irreversible; missing a merge is fixable later
- "preferences/" nodes require extra caution

OUTPUT FORMAT - Respond with JSON:
{
  "action": "merge|skip|uncertain",
  "targetNodeId": "id of the node to merge with (if action is merge)",
  "targetNodeTitle": "title of target node (if action is merge)",
  "confidence": 0.0-1.0,
  "reason": "Explanation of the decision"
}`
}

export function getNodeRewritePrompt(
  existingNode: { title: string; content: string; type: string },
  newContent: string,
  originalContext: string,
): string {
  return `You are a knowledge curator. Merge new information into an existing wiki node while preserving structure.

EXISTING NODE:
Title: ${existingNode.title}
Type: ${existingNode.type}
Current Content:
${existingNode.content}

NEW INFORMATION TO MERGE:
${newContent}

ORIGINAL CONTEXT (why this information matters):
${originalContext}

REWRITE RULES:
1. Preserve the existing structure and organization when possible
2. Integrate new information naturally, avoiding duplication
3. Update timestamps and source references
4. Maintain markdown formatting consistency
5. Ensure the "Original Context" section captures why this knowledge matters

OUTPUT: Provide the complete rewritten node content in markdown format.`
}
