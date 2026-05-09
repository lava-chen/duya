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

import type { Message, AgentOptions } from './types.js';
import { readDraftSkill, backupDraftSkill, getDraftSkillsDir } from './skills/SkillDraftManager.js';
import { getSkillRegistry } from './skills/registry.js';

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
async function createSubAgent(options: AgentOptions): Promise<InstanceType<typeof import('./index.js').duyaAgent>> {
  const { duyaAgent } = await import('./index.js');
  return new duyaAgent(options);
}

export class SelfImprover {
  private itersSinceSkill = 0;
  private toolCallsSinceSkill = 0;
  private skillNudgeInterval: number;
  private enabled = false;
  private maxIterations = MAX_REVISION_ITERATIONS;

  constructor(skillNudgeInterval?: number) {
    this.skillNudgeInterval = skillNudgeInterval ?? DEFAULT_SKILL_NUDGE_INTERVAL;
    this.enabled = this.skillNudgeInterval > 0;
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
   * Called after each iteration completes to track turn count
   * Also tracks tool calls for more accurate triggering
   */
  onIterationComplete(validToolNames: Set<string>, toolCallCountThisTurn: number): void {
    if (!this.enabled) return;

    if (this.skillNudgeInterval > 0 && validToolNames.has('skill_manage')) {
      this.itersSinceSkill++;
      this.toolCallsSinceSkill += toolCallCountThisTurn;
      console.log(`[SelfImprover] Turn completed. itersSinceSkill=${this.itersSinceSkill}, toolCallsSinceSkill=${this.toolCallsSinceSkill}, threshold=${this.skillNudgeInterval}`);
    }
  }

  /**
   * Called when skill_manage is actually used
   */
  onSkillManageUsed(): void {
    console.log(`[SelfImprover] skill_manage used, resetting counters`);
    this.itersSinceSkill = 0;
    this.toolCallsSinceSkill = 0;
  }

  /**
   * Check if skill review should be triggered
   * Triggered when EITHER turns OR tool calls reach the threshold
   */
  shouldReview(): boolean {
    if (!this.enabled) return false;
    const shouldTrigger = this.itersSinceSkill >= this.skillNudgeInterval || this.toolCallsSinceSkill >= this.skillNudgeInterval * 3;
    if (shouldTrigger) {
      console.log(`[SelfImprover] Triggering skill review: iters=${this.itersSinceSkill}, toolCalls=${this.toolCallsSinceSkill}, threshold=${this.skillNudgeInterval}`);
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

    const reviewMessages: Message[] = [
      {
        role: 'user',
        content: `Analyze the following conversation and decide if a skill should be created or an existing skill improved:\n\n${SKILL_REVIEW_PROMPT}`,
        timestamp: Date.now(),
      },
      // Include conversation history as context
      ...messagesSnapshot,
    ];

    // Create a forked agent for skill creation
    const creatorAgent = await createSubAgent({
      apiKey: llmConfig.apiKey,
      baseURL: llmConfig.baseURL,
      model: llmConfig.model,
      provider: llmConfig.provider,
      workingDirectory: workingDirectory || process.cwd(),
      skillNudgeInterval: 0, // Disable self-improvement in the creator agent
    });

    let skillName: string | undefined;
    let skillContent: string | undefined;
    let actionType: 'draft' | 'edit' | 'patch' | undefined;

    try {
      console.log('[SelfImprover] Creator Phase: Running creator agent stream...');
      // Run the creator conversation
      for await (const event of creatorAgent.streamChat(systemPrompt)) {
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

    // Build evaluation prompt with skill content
    const evaluationPrompt = `${SKILL_EVALUATOR_PROMPT}\n\n---\n\n## Draft Skill Content:\n\n${skillContent}`;

    // Create a forked agent for evaluation
    const evaluatorAgent = await createSubAgent({
      apiKey: llmConfig.apiKey,
      baseURL: llmConfig.baseURL,
      model: llmConfig.model,
      provider: llmConfig.provider,
      workingDirectory: workingDirectory || process.cwd(),
      skillNudgeInterval: 0, // Disable self-improvement in the evaluator agent
    });

    try {
      let evaluationResult: EvaluationResult | null = null;

      console.log('[SelfImprover] Evaluator Phase: Running evaluator agent stream...');
      // Run the evaluator conversation
      for await (const event of evaluatorAgent.streamChat(evaluationPrompt)) {
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

    // Build revision prompt
    const revisionPrompt = `You are a skill creator. Revise the existing draft skill based on evaluator feedback.

---
## Current SKILL.md Content:

${skillContent}

---
## Evaluator Feedback (you must address this):

${feedback}

---
## Your Task

Revise the SKILL.md above to address the evaluator's feedback.
- Use skill_manage(action='edit', name='${skillName}', content=<revised-full-content>) for full rewrites
- Use skill_manage(action='patch', name='${skillName}', old_string='...', new_string='...') for targeted fixes

Provide a summary of what you changed.`;

    // Create a forked agent for revision
    const creatorAgent = await createSubAgent({
      apiKey: llmConfig.apiKey,
      baseURL: llmConfig.baseURL,
      model: llmConfig.model,
      provider: llmConfig.provider,
      workingDirectory: workingDirectory || process.cwd(),
      skillNudgeInterval: 0,
    });

    try {
      // Run the revision conversation
      for await (const _event of creatorAgent.streamChat(revisionPrompt)) {
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

export function getDefaultSelfImprover(): SelfImprover {
  if (!defaultSelfImprover) {
    defaultSelfImprover = new SelfImprover();
  }
  return defaultSelfImprover;
}

export function resetDefaultSelfImprover(): void {
  defaultSelfImprover = null;
}
