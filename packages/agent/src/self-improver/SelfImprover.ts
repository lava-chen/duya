/**
 * SelfImprover - Self-improvement orchestration for DUYA Agent
 *
 * Implements a three-phase iterative skill creation and evaluation loop:
 * 1. Creator Agent analyzes experience and creates draft skill
 * 2. Evaluator Agent scores the skill through real task execution
 * 3. If score < 7, Creator Agent revises based on feedback (max 3 iterations)
 *
 * Key concepts:
 * - _iters_since_skill: counts iterations since last skill_manage call
 * - _skill_nudge_interval: threshold for triggering background review
 * - Draft skills: created in ~/.duya/skills-draft/ for evaluation
 * - Iteration loop: max 3 revisions before rejection
 */

import type { Message, AgentOptions } from '../types.js';
import { readDraftSkill, backupDraftSkill, getDraftSkillsDir } from '../skills/SkillDraftManager.js';
import { getSkillRegistry } from '../skills/registry.js';
import {
  loadSelfImproverState,
  saveSelfImproverState,
  clearSelfImproverState,
} from './SelfImproverState.js';

// ============================================================================
// Types
// ============================================================================

export interface SelfImproverConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
  provider?: 'anthropic' | 'openai' | 'ollama';
}

/**
 * Phase of the improvement process
 */
export enum ImprovementPhase {
  IDLE = 'idle',
  CREATOR_RUNNING = 'creator_running',
  EVALUATOR_RUNNING = 'evaluator_running',
  CREATOR_REVISING = 'creator_revising',
}

/**
 * Result of skill evaluation
 */
export interface EvaluationResult {
  score: number;           // 0-10
  passed: boolean;
  feedback: string;         // Detailed feedback
  dimensions?: Record<string, { score: number; feedback: string }>;
  executedTask?: string;    // Task executed to test the skill
}

/**
 * Result of skill creation
 */
export interface CreatorResult {
  created: boolean;
  skillName?: string;
  skillContent?: string;
  reason: string;
}

/**
 * Final result of the improvement process
 */
export interface ImprovementResult {
  phase: ImprovementPhase;
  creatorResult?: CreatorResult;
  evaluationResult?: EvaluationResult;
  finalSkillPath?: string;
  iterationCount: number;
  maxIterations: number;
  error?: string;
}

/**
 * Result of a background skill review (legacy interface)
 */
export interface SkillReviewResult {
  success: boolean;
  actions: string[];
  error?: string;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_SKILL_NUDGE_INTERVAL = 10;
const MAX_REVISION_ITERATIONS = 3;

// ============================================================================
// Prompts
// ============================================================================

/**
 * Prompt for the Creator Agent - analyzes experience and creates/modifies skills
 */
const SKILL_CREATOR_PROMPT = `You are a skill creator. Analyze the conversation history and existing skills to decide whether to improve an existing skill or create a new one.

## Step 1: Analyze Existing Skills

First, examine the existing skills listed below. Consider:
- Does any existing skill cover a similar workflow or approach?
- Would improving an existing skill be better than creating a new one?
- Is the current task's approach complementary to an existing skill?

## Step 2: Analyze the Conversation

Then analyze the conversation history to understand:
- What task was being performed?
- What approach/workflow was discovered or used?
- Were there any non-trivial patterns, tricks, or lessons learned?
- Did something require trial-and-error to solve?

## Step 3: Make a Decision

**Decision Framework:**

1. **If an existing skill is relevant** (covers similar workflow):
   - Improve the existing skill instead of creating a new one
   - Call skill_manage(action='draft', name='<existing-skill-name>', content=<updated-full-content>)
   - Focus on: adding new steps, updating outdated parts, or extending scope

2. **If NO existing skill is relevant** AND the task is worth saving:
   - Create a NEW skill
   - Call skill_manage(action='draft', name, content, category)
   - Focus on: reusable patterns, clear steps, common pitfalls

3. **If the task is simple or not reusable**:
   - Return "Nothing significant to save."

## Decision Criteria

A skill is worth creating/improving when:
- Involves 5+ tool calls (non-trivial workflow)
- Required trial-and-error or changing approach
- Contains reusable patterns others could benefit from
- Documents non-obvious solutions or workarounds

## Important: Always Use 'draft' Action

For BOTH new skills AND improvements to existing skills:
- Use action='draft' to create the skill in draft directory for evaluation
- The evaluation system will handle promoting to正式 location after approval
- Do NOT use 'edit' or 'patch' directly - they bypass the quality evaluation

## Existing Skills to Consider

{EXISTING_SKILLS_PLACEHOLDER}

## SKILL.md Format (for new skills)

\`\`\`yaml
---
name: <lowercase-with-hyphens>
description: <brief-one-line-description>
category: <category-name>
allowed-tools: <comma-separated-tool-names>
---

# <Skill Title>

## When to Use
<describe when this skill should be invoked>

## Steps
1. <numbered steps with exact commands>
2. <include verification steps>

## Pitfalls
- <common mistakes to avoid>
- <platform-specific issues>

## Verification
<how to verify the skill worked correctly>
\`\`\`

## Important

- ALWAYS use action='draft' for evaluation (both new AND improved skills)
- After creating or improving, provide a brief summary of what changed.
`.trim();

/**
 * Prompt for the Evaluator Agent - scores skills through real execution
 */
const SKILL_EVALUATOR_PROMPT = `You are a skill evaluator. Evaluate draft skills through REAL execution, not theoretical analysis.

## Your Evaluation Process

### Step 1: Read the Draft Skill

Find the skill in ~/.duya/skills-draft/<skill-name>/SKILL.md and read its content.

### Step 2: Execute a Real Task

Based on the skill's purpose, design and execute a REAL task that:
- Is relevant to the skill's domain
- Can be completed within your tool execution limit
- Produces verifiable output

Execute the task using the tools and steps described in the skill. Observe:
- Execution time and efficiency
- Output correctness
- Any errors or issues
- Overall workflow quality

### Step 3: Score Each Dimension (0-2 per dimension)

| Dimension | 0 | 1 | 2 |
|-----------|---|---|---|
| **Output Quality** | Wrong/empty output | Partially correct | Correct and useful |
| **Execution Efficiency** | Wasteful/unnecessary steps | Reasonable efficiency | Optimal approach |
| **Approach Validity** | Flawed approach | Sound but suboptimal | Excellent methodology |
| **Correctness** | Errors in commands | Minor issues | Fully accurate |
| **Completeness** | Missing critical steps | Some gaps | All necessary steps |

**Total Score: 0-10 (sum of all dimensions)**

### Step 4: Pass/Fail Decision

- **Pass (score >= 7)**: Call skill_manage(action='promote', name='<skill-name>')
- **Fail (score < 7)**: Provide detailed feedback for revision

### Step 5: Return Evaluation

Provide your evaluation in JSON format in your response:
\`\`\`json
{
  "score": <0-10>,
  "dimensions": {
    "output_quality": { "score": <0-2>, "feedback": "<>" },
    "execution_efficiency": { "score": <0-2>, "feedback": "<>" },
    "approach_validity": { "score": <0-2>, "feedback": "<>" },
    "correctness": { "score": <0-2>, "feedback": "<>" },
    "completeness": { "score": <0-2>, "feedback": "<>" }
  },
  "passed": <true/false>,
  "feedback": "<overall detailed feedback for improvement>",
  "executed_task": "<what task you executed to test>"
}
\`\`\`

## Critical Requirements

1. You MUST execute a real task - pure theoretical evaluation is not acceptable
2. You MUST observe actual execution - watch for errors, efficiency issues
3. Score must be justified - each score needs supporting evidence
4. Feedback must be actionable - Creator should know exactly what to fix`;

/**
 * Prompt for the initial review - decides if a skill should be created
 */
const SKILL_REVIEW_PROMPT = `Review the conversation above and consider saving or updating a skill if appropriate.

Focus on: was a non-trivial approach used to complete a task that required trial and error, or changing course due to experiential findings along the way, or did the user expect or desire a different method or outcome?

If a relevant skill already exists, update it with what you learned. Otherwise, create a new skill if the approach is reusable.
If nothing is worth saving, just say 'Nothing to save.' and stop.`;

// ============================================================================
// SelfImprover Class
// ============================================================================

/**
 * Lazily import duyaAgent to break circular dependency between index.ts and SelfImprover.ts.
 * Both modules reference each other: index.ts imports SelfImprover, and SelfImprover needs
 * to create duyaAgent instances for creator/evaluator sub-agents.
 *
 * Dynamic import ensures the module graph resolves before duyaAgent is accessed at runtime.
 */
async function createSubAgent(options: AgentOptions): Promise<InstanceType<typeof import('../index.js').duyaAgent>> {
  const { duyaAgent } = await import('../index.js');
  return new duyaAgent(options);
}

export class SelfImprover {
  private itersSinceSkill = 0;
  private toolCallsSinceSkill = 0;
  private lastReviewAt: number | null = null;
  private lastResetAt = 0;
  private skillNudgeInterval: number;
  private enabled = false;
  private maxIterations = MAX_REVISION_ITERATIONS;
  /** Set to true once we've loaded the persisted state from disk. */
  private stateLoaded = false;
  /** When true, the next counter mutation will skip the disk write
   *  (used during initial load to avoid a write storm on every
   *  start). */
  private suppressPersist = false;

  constructor(skillNudgeInterval?: number) {
    this.skillNudgeInterval = skillNudgeInterval ?? DEFAULT_SKILL_NUDGE_INTERVAL;
    this.enabled = this.skillNudgeInterval > 0;
  }

  /**
   * Load persisted counter state from disk. Call once after
   * construction; safe to call multiple times (subsequent calls are
   * no-ops).
   *
   * Returns a Promise that resolves once the load completes. Errors
   * are absorbed — the worst case is "start from 0", which matches
   * the pre-persistence behavior.
   */
  async init(): Promise<void> {
    if (this.stateLoaded) return;
    this.stateLoaded = true;

    const persisted = await loadSelfImproverState();
    // While populating from disk, suppress the implicit save() that
    // the setters would fire.
    this.suppressPersist = true;
    try {
      this.itersSinceSkill = persisted.itersSinceSkill;
      this.toolCallsSinceSkill = persisted.toolCallsSinceSkill;
      this.lastResetAt = persisted.lastResetAt;
      this.lastReviewAt = persisted.lastReviewAt;
    } finally {
      this.suppressPersist = false;
    }
    if (persisted.itersSinceSkill > 0 || persisted.toolCallsSinceSkill > 0) {
      console.log(
        `[SelfImprover] Loaded persisted counters: iters=${this.itersSinceSkill}, ` +
        `toolCalls=${this.toolCallsSinceSkill}, lastReviewAt=${this.lastReviewAt ?? 'never'}`,
      );
    }
  }

  /**
   * Enable or disable the self-improvement mechanism
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Set the skill nudge interval
   */
  setSkillNudgeInterval(interval: number): void {
    this.skillNudgeInterval = interval;
    this.enabled = interval > 0;
  }

  /**
   * Fire-and-forget disk persistence. Errors are logged inside the
   * save helper, so we don't need to await or .catch() here — but
   * we still install a handler to avoid unhandled-rejection noise.
   *
   * Each call returns the pending promise so callers (e.g. tests)
   * that need deterministic ordering can await it. Production code
   * can ignore the return value.
   */
  /**
   * Fire-and-forget disk persistence. Errors are logged inside the
   * save helper, so we don't need to await or .catch() here — but
   * we still install a handler to avoid unhandled-rejection noise.
   *
   * Each call returns the pending promise so callers (e.g. tests)
   * that need deterministic ordering can await it. Production code
   * can ignore the return value.
   */
  private lastPersistPromise: Promise<void> | null = null;

  private schedulePersist(): Promise<void> {
    if (this.suppressPersist) return Promise.resolve();
    const p = saveSelfImproverState({
      itersSinceSkill: this.itersSinceSkill,
      toolCallsSinceSkill: this.toolCallsSinceSkill,
      lastResetAt: this.lastResetAt,
      lastReviewAt: this.lastReviewAt,
    }).catch((err) => {
      console.warn(`[SelfImprover] persist failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.lastPersistPromise = p;
    return p;
  }

  /**
   * Wait for any in-flight persist to complete. Intended for tests
   * (to avoid races between test cases that share a state file)
   * and for shutdown handlers that need to flush state to disk
   * before the process exits.
   */
  async flushPendingPersists(): Promise<void> {
    if (this.lastPersistPromise) {
      await this.lastPersistPromise;
    }
  }

  /**
   * Called after each turn completes to track turn + tool-call counts.
   *
   * `validToolNames` is the set of tools currently available in the
   * session. It's accepted (and ignored at the counter level) for
   * backwards compatibility with the previous call site; the gate for
   * counter accumulation is purely the `enabled` flag. The spawn
   * decision in `shouldReview()` consults the tool set to decide
   * whether `skill_manage` is actually exposed to the LLM.
   *
   * Note: `skillNudgeInterval` is the *threshold* (how many turns
   * between reviews). A value of 0 doesn't mean "disabled" — it
   * means "never trigger"; the master on/off switch is `enabled`.
   * (The constructor sets `enabled = interval > 0` as a default
   * convenience for callers that pass `0` to mean "off", but
   * `setEnabled(true)` can re-enable a `0`-interval improver for
   * testing / forcing a review.)
   */
  onIterationComplete(validToolNames: Set<string>, toolCallCountThisTurn: number): void {
    if (!this.enabled) return;

    // Always accumulate while enabled; the tool-set check belongs in
    // shouldReview(). (Previously the tool-set check was here, which
    // made the counter silently stop accumulating the moment
    // `skill_manage` was disabled at the registry level — a hidden
    // failure mode with no log output.)
    this.itersSinceSkill++;
    this.toolCallsSinceSkill += toolCallCountThisTurn;

    // Persist (fire-and-forget) so the counter survives across
    // duyaAgent instances.
    void this.schedulePersist();

    // Light log so an operator can see the counter moving in dev.
    const skillManageAvailable = validToolNames.has('skill_manage');
    console.log(
      `[SelfImprover] Turn completed. itersSinceSkill=${this.itersSinceSkill}, ` +
      `toolCallsSinceSkill=${this.toolCallsSinceSkill}, ` +
      `threshold=${this.skillNudgeInterval}, ` +
      `skill_manage_available=${skillManageAvailable}`,
    );
  }

  /**
   * Async variant of `onIterationComplete` that returns the persist
   * promise. Use in tests for deterministic ordering; production
   * code should keep using the sync version.
   */
  onIterationCompleteAsync(
    validToolNames: Set<string>,
    toolCallCountThisTurn: number,
  ): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    this.itersSinceSkill++;
    this.toolCallsSinceSkill += toolCallCountThisTurn;

    const skillManageAvailable = validToolNames.has('skill_manage');
    console.log(
      `[SelfImprover] Turn completed. itersSinceSkill=${this.itersSinceSkill}, ` +
      `toolCallsSinceSkill=${this.toolCallsSinceSkill}, ` +
      `threshold=${this.skillNudgeInterval}, ` +
      `skill_manage_available=${skillManageAvailable}`,
    );
    return this.schedulePersist();
  }

  /**
   * Called when skill_manage is actually used
   */
  onSkillManageUsed(): void {
    console.log(`[SelfImprover] skill_manage used, resetting counters`);
    this.itersSinceSkill = 0;
    this.toolCallsSinceSkill = 0;
    this.lastResetAt = Date.now();
    void this.schedulePersist();
  }

  /**
   * Async variant of `onSkillManageUsed` that returns the persist
   * promise. Use in tests for deterministic ordering.
   */
  async onSkillManageUsedAsync(): Promise<void> {
    console.log(`[SelfImprover] skill_manage used, resetting counters`);
    this.itersSinceSkill = 0;
    this.toolCallsSinceSkill = 0;
    this.lastResetAt = Date.now();
    await this.schedulePersist();
  }

  /**
   * Check if skill review should be triggered.
   *
   * Triggered when EITHER turns OR tool calls reach the threshold.
   *
   * `availableToolNames` is the set of tools the LLM can see in the
   * current session. If `skill_manage` is not in the set (filtered
   * out by an agent profile, by `disabledTools`, or otherwise
   * hidden), spawning a sub-agent that depends on it would be
   * pointless. The check here is the only authoritative one for
   * tool availability — counter accumulation in `onIterationComplete`
   * does NOT consult it (so a temporary tool-filter change doesn't
   * silently wipe progress).
   *
   * Note on `skillNudgeInterval <= 0`: the original `shouldReview`
   * allowed the `enabled = true` + `interval = 0` combination to
   * fire on every turn. We keep that contract for testability but
   * the practical effect is the same — in production the
   * constructor maps `interval <= 0` to `enabled = false`, so
   * `shouldReview` returns false on its first guard.
   */
  shouldReview(availableToolNames?: Set<string>): boolean {
    if (!this.enabled) return false;
    if (availableToolNames && !availableToolNames.has('skill_manage')) {
      return false;
    }

    const shouldTrigger =
      this.skillNudgeInterval <= 0 ||
      this.itersSinceSkill >= this.skillNudgeInterval ||
      this.toolCallsSinceSkill >= this.skillNudgeInterval * 3;

    if (shouldTrigger) {
      console.log(
        `[SelfImprover] Triggering skill review: iters=${this.itersSinceSkill}, ` +
        `toolCalls=${this.toolCallsSinceSkill}, threshold=${this.skillNudgeInterval}`,
      );
    }
    return shouldTrigger;
  }

  /**
   * Get current iteration count since last skill_manage
   */
  getItersSinceSkill(): number {
    return this.itersSinceSkill;
  }

  /**
   * Get current tool call count since last skill_manage
   */
  getToolCallsSinceSkill(): number {
    return this.toolCallsSinceSkill;
  }

  /**
   * Reset the counter (called after review is spawned)
   */
  reset(): void {
    console.log(`[SelfImprover] Resetting counters`);
    this.itersSinceSkill = 0;
    this.toolCallsSinceSkill = 0;
    this.lastReviewAt = Date.now();
    this.schedulePersist();
  }

  /**
   * Wipe the persisted state file on disk. Used by the CLI for
   * `duya skill reset-counters` and by tests for cleanup. Does NOT
   * clear the in-memory counters — call `reset()` for that.
   */
  async clearPersistedState(): Promise<void> {
    await clearSelfImproverState();
  }

  /**
   * Initiate the full skill creation-evaluation loop.
   * This is the main entry point for the self-improvement process.
   */
  async initiateSkillCreation(
    messagesSnapshot: Message[],
    llmConfig: SelfImproverConfig,
    workingDirectory?: string
  ): Promise<ImprovementResult> {
    if (!this.enabled) {
      console.log('[SelfImprover] Skill creation skipped: self-improvement is disabled');
      return {
        phase: ImprovementPhase.IDLE,
        iterationCount: 0,
        maxIterations: this.maxIterations,
        error: 'Self-improvement is disabled',
      };
    }

    console.log(`[SelfImprover] Starting skill creation process. Messages: ${messagesSnapshot.length}`);

    // Phase 1: Run Creator Agent to decide if skill should be created
    console.log('[SelfImprover] Phase 1: Running Creator Agent...');
    const creatorResult = await this.executeCreatorPhase(messagesSnapshot, llmConfig, workingDirectory);
    console.log(`[SelfImprover] Creator result: created=${creatorResult.created}, reason=${creatorResult.reason}`);

    if (!creatorResult.created || !creatorResult.skillName) {
      console.log(`[SelfImprover] No skill created. Reason: ${creatorResult.reason}`);
      return {
        phase: ImprovementPhase.IDLE,
        creatorResult,
        iterationCount: 0,
        maxIterations: this.maxIterations,
      };
    }

    console.log(`[SelfImprover] Skill '${creatorResult.skillName}' drafted. Proceeding to evaluation...`);

    // Phase 2-3: Run Evaluator loop (may iterate with Creator revisions)
    const finalResult = await this.executeEvaluatorLoop(
      creatorResult.skillName,
      creatorResult.skillContent,
      llmConfig,
      workingDirectory
    );

    console.log(`[SelfImprover] Final result: passed=${finalResult.evaluationResult?.passed}, score=${finalResult.evaluationResult?.score}, iterations=${finalResult.iterationCount}`);

    return finalResult;
  }

  /**
   * Get a summary of existing skills for the Creator Agent to consider
   */
  private getExistingSkillsSummary(): string {
    try {
      const registry = getSkillRegistry();
      const skills = registry.listMetadata();

      if (skills.length === 0) {
        return 'No existing skills.';
      }

      const lines: string[] = [];
      lines.push(`Found ${skills.length} existing skill(s):\n`);

      for (const skill of skills.slice(0, 20)) { // Limit to 20 skills for prompt size
        lines.push(`## ${skill.name}`);
        lines.push(`Description: ${skill.description || 'N/A'}`);
        lines.push('');
      }

      if (skills.length > 20) {
        lines.push(`... and ${skills.length - 20} more skills.`);
      }

      return lines.join('\n');
    } catch {
      return 'Could not load existing skills.';
    }
  }

  /**
   * Execute the Creator Agent to decide and create a draft skill
   */
  private async executeCreatorPhase(
    messagesSnapshot: Message[],
    llmConfig: SelfImproverConfig,
    workingDirectory?: string
  ): Promise<CreatorResult> {
    console.log('[SelfImprover] Creator Phase: Preparing to analyze conversation...');

    // Get existing skills to help Creator Agent decide
    const existingSkills = this.getExistingSkillsSummary();
    console.log(`[SelfImprover] Existing skills summary: ${existingSkills.split('\n')[0]}`);

    // Build system prompt with existing skills injected
    const systemPrompt = SKILL_CREATOR_PROMPT.replace(
      '{EXISTING_SKILLS_PLACEHOLDER}',
      existingSkills || 'No existing skills found.'
    );

    // Create a forked agent for skill creation
    const creatorAgent = await createSubAgent({
      apiKey: llmConfig.apiKey,
      baseURL: llmConfig.baseURL,
      model: llmConfig.model,
      provider: llmConfig.provider,
      workingDirectory: workingDirectory || process.cwd(),
      skillNudgeInterval: 0, // Disable self-improvement in the creator agent
    });

    // Prime the creator agent with the review task + conversation snapshot.
    // The snapshot gives the creator real context about what the user did;
    // SKILL_REVIEW_PROMPT is the actual user-role question for this turn.
    // Previously, this code built `reviewMessages` but never passed it to
    // the agent — it was silently dropped.
    const userTurnPrompt = `Analyze the following conversation and decide if a skill should be created or an existing skill improved:\n\n${SKILL_REVIEW_PROMPT}`;
    creatorAgent.setMessages([
      ...messagesSnapshot,
      {
        role: 'user',
        content: userTurnPrompt,
        timestamp: Date.now(),
      },
    ]);

    let skillName: string | undefined;
    let skillContent: string | undefined;
    let actionType: 'draft' | 'edit' | 'patch' | undefined;

    try {
      console.log('[SelfImprover] Creator Phase: Running creator agent stream...');
      // Run the creator conversation.
      // The system prompt defines the role + decision framework; the user
      // message is the actual task prompt that asks for analysis. Passing
      // the system prompt as the first positional arg (the user prompt)
      // would be a critical bug — the LLM would treat the role
      // instructions as the user's question.
      for await (const event of creatorAgent.streamChat(userTurnPrompt, {
        systemPrompt,
      })) {
        if (event.type === 'tool_use' && event.data.name === 'skill_manage') {
          const input = event.data.input as Record<string, unknown>;
          console.log(`[SelfImprover] Creator Phase: skill_manage called with action=${input.action}, name=${input.name}`);
          if (input.action === 'draft' && input.name && input.content) {
            skillName = input.name as string;
            skillContent = input.content as string;
            actionType = 'draft';
          } else if (input.action === 'edit' && input.name && input.content) {
            // Improving an existing skill
            skillName = input.name as string;
            skillContent = input.content as string;
            actionType = 'edit';
          } else if (input.action === 'patch' && input.name) {
            // Patching an existing skill - still count it
            skillName = input.name as string;
            actionType = 'patch';
          }
        }
      }

      // Extract result from creator agent messages
      const messages = creatorAgent.getMessages();
      const lastAssistantMessage = messages.filter(m => m.role === 'assistant').pop();

      // Check if creator decided nothing worth saving
      const content = typeof lastAssistantMessage?.content === 'string'
        ? lastAssistantMessage.content
        : JSON.stringify(lastAssistantMessage?.content);

      if (content?.toLowerCase().includes('nothing') && content?.toLowerCase().includes('save')) {
        console.log('[SelfImprover] Creator Phase: Agent decided nothing to save');
        return {
          created: false,
          reason: 'Nothing significant to save',
        };
      }

      if (!skillName) {
        console.log('[SelfImprover] Creator Phase: No skill was created or improved');
        return {
          created: false,
          reason: 'Creator agent did not create or improve a skill',
        };
      }

      console.log(`[SelfImprover] Creator Phase: Skill '${skillName}' action=${actionType}`);

      // If improving an existing skill (edit/patch), create a draft from it for evaluation
      if (actionType === 'edit' || actionType === 'patch') {
        // The improved skill content should be in skillContent for draft creation
        // For now, we'll treat this as if a draft was created for evaluation
        return {
          created: true,
          skillName,
          skillContent,
          reason: `Skill '${skillName}' improved via ${actionType}`,
        };
      }

      return {
        created: true,
        skillName,
        skillContent,
        reason: `Skill '${skillName}' created`,
      };
    } catch (error) {
      console.error(`[SelfImprover] Creator Phase error:`, error);
      return {
        created: false,
        reason: error instanceof Error ? error.message : 'Unknown error in creator phase',
      };
    } finally {
      creatorAgent.interrupt();
    }
  }

  /**
   * Execute the Evaluator Agent to score the skill
   */
  private async executeEvaluatorPhase(
    skillName: string,
    llmConfig: SelfImproverConfig,
    workingDirectory?: string
  ): Promise<EvaluationResult> {
    console.log(`[SelfImprover] Evaluator Phase: Evaluating skill '${skillName}'...`);

    // Read the draft skill content
    const skillContent = await readDraftSkill(skillName);
    if (!skillContent) {
      console.log(`[SelfImprover] Evaluator Phase: Draft skill '${skillName}' not found`);
      return {
        score: 0,
        passed: false,
        feedback: `Draft skill '${skillName}' not found in ${getDraftSkillsDir()}`,
      };
    }

    // Build the user-role task message that contains the draft skill.
    // SKILL_EVALUATOR_PROMPT stays as the system prompt; the actual task
    // for this turn is the user message below.
    const userTurnPrompt = `Evaluate the following draft skill. Read the SKILL.md content and design + execute a real task to score it.\n\n---\n\n## Draft Skill Content:\n\n${skillContent}`;

    // Create a forked agent for evaluation
    const evaluatorAgent = await createSubAgent({
      apiKey: llmConfig.apiKey,
      baseURL: llmConfig.baseURL,
      model: llmConfig.model,
      provider: llmConfig.provider,
      workingDirectory: workingDirectory || process.cwd(),
      skillNudgeInterval: 0, // Disable self-improvement in the evaluator agent
    });

    // Prime evaluator with the evaluation task as the user-role message.
    // SKILL_EVALUATOR_PROMPT is the role/system instructions; the actual
    // task for this turn is the user message below.
    evaluatorAgent.setMessages([
      {
        role: 'user',
        content: userTurnPrompt,
        timestamp: Date.now(),
      },
    ]);

    try {
      let evaluationResult: EvaluationResult | null = null;

      console.log('[SelfImprover] Evaluator Phase: Running evaluator agent stream...');
      // Run the evaluator conversation.
      // The system prompt defines the evaluator role + scoring rubric; the
      // user message is the actual evaluation task for this turn. Passing
      // the system prompt as the first positional arg (the user prompt)
      // would be a critical bug — the LLM would treat the role
      // instructions as the user's question.
      for await (const event of evaluatorAgent.streamChat(userTurnPrompt, {
        systemPrompt: SKILL_EVALUATOR_PROMPT,
      })) {
        if (event.type === 'tool_use' && event.data.name === 'skill_manage') {
          const input = event.data.input as Record<string, unknown>;
          console.log(`[SelfImprover] Evaluator Phase: skill_manage called with action=${input.action}`);
          // The evaluator should call promote or reject
          // We capture this but rely on the agent's text response for the actual evaluation
        }

        if (event.type === 'text') {
          // Try to parse evaluation from the text response
          const text = event.data as string;
          const jsonMatch = text.match(/```json\s*(\{.*?\})\s*```/s) ||
                           text.match(/```\s*(\{.*?\})\s*```/s);

          if (jsonMatch) {
            try {
              const parsed = JSON.parse(jsonMatch[1]);
              if (typeof parsed.score === 'number' && typeof parsed.passed === 'boolean') {
                evaluationResult = {
                  score: parsed.score,
                  passed: parsed.passed,
                  feedback: parsed.feedback || '',
                  dimensions: parsed.dimensions,
                  executedTask: parsed.executed_task,
                };
                console.log(`[SelfImprover] Evaluator Phase: Parsed evaluation - score=${parsed.score}, passed=${parsed.passed}`);
              }
            } catch {
              // Not valid JSON, continue
            }
          }
        }
      }

      if (!evaluationResult) {
        console.log('[SelfImprover] Evaluator Phase: Could not parse evaluation result');
        // Fallback: extract from final message
        const messages = evaluatorAgent.getMessages();
        const lastAssistantMessage = messages.filter(m => m.role === 'assistant').pop();
        const content = typeof lastAssistantMessage?.content === 'string'
          ? lastAssistantMessage.content
          : '';

        return {
          score: 0,
          passed: false,
          feedback: `Could not parse evaluation result from agent response: ${content.slice(0, 500)}`,
        };
      }

      console.log(`[SelfImprover] Evaluator Phase: Final score=${evaluationResult.score}, passed=${evaluationResult.passed}`);
      return evaluationResult;
    } catch (error) {
      console.error(`[SelfImprover] Evaluator Phase error:`, error);
      return {
        score: 0,
        passed: false,
        feedback: error instanceof Error ? error.message : 'Unknown error in evaluator phase',
      };
    } finally {
      evaluatorAgent.interrupt();
    }
  }

  /**
   * Execute the Creator revision phase based on evaluator feedback
   */
  private async executeCreatorRevisingPhase(
    skillName: string,
    feedback: string,
    llmConfig: SelfImproverConfig,
    workingDirectory?: string
  ): Promise<CreatorResult> {
    // Read current skill content
    const skillContent = await readDraftSkill(skillName);
    if (!skillContent) {
      return {
        created: false,
        skillName,
        reason: `Draft skill '${skillName}' not found`,
      };
    }

    // Backup current version before revision
    await backupDraftSkill(skillName);

    // Build revision prompts. SKILL_CREATOR_PROMPT is the role/system
    // instructions (defines the skill_manage action vocabulary); the user
    // message is the actual revision task.
    const systemPrompt = SKILL_CREATOR_PROMPT.replace(
      '{EXISTING_SKILLS_PLACEHOLDER}',
      this.getExistingSkillsSummary() || 'No existing skills found.'
    );
    const userTurnPrompt = `Revise the existing draft skill below based on the evaluator's feedback. Use skill_manage(action='edit' or 'patch', name='${skillName}', ...) to apply your changes, then provide a brief summary of what you changed.

---
## Current SKILL.md Content:

${skillContent}

---
## Evaluator Feedback (you must address this):

${feedback}`;

    // Create a forked agent for revision
    const creatorAgent = await createSubAgent({
      apiKey: llmConfig.apiKey,
      baseURL: llmConfig.baseURL,
      model: llmConfig.model,
      provider: llmConfig.provider,
      workingDirectory: workingDirectory || process.cwd(),
      skillNudgeInterval: 0,
    });

    // Prime the agent with the revision task as the user-role message.
    creatorAgent.setMessages([
      {
        role: 'user',
        content: userTurnPrompt,
        timestamp: Date.now(),
      },
    ]);

    try {
      // Run the revision conversation.
      // The system prompt defines the role + skill_manage action vocabulary;
      // the user message is the actual revision task. Passing the system
      // prompt as the first positional arg (the user prompt) would be a
      // critical bug — the LLM would treat the role instructions as the
      // user's question.
      for await (const _event of creatorAgent.streamChat(userTurnPrompt, {
        systemPrompt,
      })) {
        // Just consume the stream - the agent calls skill_manage internally
      }

      return {
        created: true,
        skillName,
        skillContent: await readDraftSkill(skillName) || undefined,
        reason: `Skill '${skillName}' revised based on feedback`,
      };
    } catch (error) {
      return {
        created: false,
        skillName,
        reason: error instanceof Error ? error.message : 'Unknown error in revision phase',
      };
    } finally {
      creatorAgent.interrupt();
    }
  }

  /**
   * Execute the evaluator loop with iteration control
   */
  private async executeEvaluatorLoop(
    skillName: string,
    initialContent: string | undefined,
    llmConfig: SelfImproverConfig,
    workingDirectory?: string
  ): Promise<ImprovementResult> {
    let iteration = 0;
    let lastEvaluation: EvaluationResult | null = null;

    while (iteration < this.maxIterations) {
      // Execute Evaluator Agent
      const evaluationResult = await this.executeEvaluatorPhase(skillName, llmConfig, workingDirectory);
      lastEvaluation = evaluationResult;

      if (evaluationResult.passed) {
        // Success! Skill passed evaluation
        return {
          phase: ImprovementPhase.IDLE,
          creatorResult: { created: true, skillName, reason: 'Skill passed evaluation' },
          evaluationResult,
          finalSkillPath: `~/.duya/skills/${skillName}`,
          iterationCount: iteration + 1,
          maxIterations: this.maxIterations,
        };
      }

      iteration++;

      if (iteration >= this.maxIterations) {
        // Max iterations reached - fail
        return {
          phase: ImprovementPhase.IDLE,
          creatorResult: { created: true, skillName, reason: 'Max iterations reached' },
          evaluationResult,
          iterationCount: iteration,
          maxIterations: this.maxIterations,
          error: `Skill rejected after ${iteration} iterations. Feedback: ${evaluationResult.feedback}`,
        };
      }

      // Not passed but still have iterations - Creator revises
      const revisionResult = await this.executeCreatorRevisingPhase(
        skillName,
        evaluationResult.feedback,
        llmConfig,
        workingDirectory
      );

      if (!revisionResult.created) {
        return {
          phase: ImprovementPhase.IDLE,
          creatorResult: revisionResult,
          evaluationResult,
          iterationCount: iteration,
          maxIterations: this.maxIterations,
          error: `Revision failed: ${revisionResult.reason}`,
        };
      }
    }

    // Should not reach here
    return {
      phase: ImprovementPhase.IDLE,
      creatorResult: { created: true, skillName, reason: 'Unexpected loop exit' },
      evaluationResult: lastEvaluation || undefined,
      iterationCount: iteration,
      maxIterations: this.maxIterations,
      error: 'Unexpected loop exit',
    };
  }

  /**
   * Legacy method - spawn background review (maintains compatibility)
   */
  async spawnBackgroundReview(
    messagesSnapshot: Message[],
    llmConfig: SelfImproverConfig,
    workingDirectory?: string
  ): Promise<SkillReviewResult> {
    const result = await this.initiateSkillCreation(messagesSnapshot, llmConfig, workingDirectory);

    return {
      success: result.evaluationResult?.passed ?? false,
      actions: result.creatorResult?.skillName ? [`Skill '${result.creatorResult.skillName}' created`] : [],
      error: result.error,
    };
  }

  /**
   * Check if skill_manage is available in the tool set
   */
  static isSkillManageAvailable(validToolNames: Set<string>): boolean {
    return validToolNames.has('skill_manage');
  }
}

// ============================================================================
// Singleton instance
// ============================================================================

let defaultSelfImprover: SelfImprover | null = null;

/**
 * Get (or lazily create) the process-wide default SelfImprover.
 *
 * The default instance is the one that agents SHOULD use when they
 * want counters to persist across agent instances. Construction is
 * sync, but state load is async — callers that need the persisted
 * counters to be visible on the first check should `await
 * si.init()` after fetching the singleton.
 */
export function getDefaultSelfImprover(): SelfImprover {
  if (!defaultSelfImprover) {
    defaultSelfImprover = new SelfImprover();
  }
  return defaultSelfImprover;
}

export function resetDefaultSelfImprover(): void {
  defaultSelfImprover = null;
}
