import { ASSISTANT_MODES, type AssistantMode } from '@duya/agent-protocol';
import { BaseTool } from './BaseTool.js';
import type { ToolResult, ToolUseContext } from './contracts/tool.js';

export type AgentMode = AssistantMode;
export type PlanFileSeedStatus = 'empty' | 'non_empty' | 'missing';
export const ALL_MODES: AgentMode[] = [...ASSISTANT_MODES];
export const SWITCH_MODE_TOOL_NAME = 'SwitchMode';
export const ENTER_PLAN_MODE_TOOL_NAME = 'EnterPlanMode';
export const EXIT_PLAN_MODE_TOOL_NAME = 'ExitPlanMode';
export const SWITCH_MODE_TOOL_DESCRIPTION = 'Switch the agent between different behavioral modes (plan, explore, verify, code-review, general)';
export const ENTER_PLAN_MODE_TOOL_DESCRIPTION = 'Enter plan mode to review and analyze code';
export const EXIT_PLAN_MODE_TOOL_DESCRIPTION = 'Exit plan mode';

export function getSwitchModeToolPrompt(): string {
  return `Use this tool to switch between different behavioral modes. Each mode changes what tools are available and provides guidance on the task type.

## Available Modes

### general (default)
General purpose mode with full tool access. Use for normal implementation tasks.

### plan
Read-only planning mode. Use when you need to:
- Explore a codebase before making changes
- Design an implementation approach
- Analyze architecture and dependencies
- Plan a refactoring or major change

In plan mode, you can only read files and use exploration tools. Use Task tool with action "create" to outline your plan.

### explore
Fast read-only exploration mode. Use when you need to:
- Quickly find files or code patterns
- Answer questions about the codebase
- Investigate a specific area of the code

### verify
Read-only verification mode. Use when you need to:
- Verify that implementation is correct
- Run tests and check outputs
- Validate bug fixes

### code-review
Read-only code review mode. Use when you need to:
- Review code for bugs, security issues
- Check code quality and best practices
- Provide feedback on implementation

## When to Use This Tool

**Good reasons to switch modes:**
- You need to understand a complex codebase before implementing
- You're starting a multi-file refactoring
- You want to verify someone's implementation
- You're asked to "plan" or "think about" something complex
- You need to explore before you can design

**Bad reasons to switch modes:**
- Simple single-file changes (just do it)
- Bug fixes with clear root cause (just fix it)
- Tasks you've already explored

## Usage Example

\`\`\`
{
  "mode": "plan",
  "reason": "Need to design approach for database migration"
}
\`\`\`

Always provide a "reason" field explaining why you're switching modes. This helps the user understand your thinking.`;
}

export function getEnterPlanModeToolPrompt(): string {
  return `Use this tool to enter plan mode.

## When to Use This Tool

- When you need to understand a complex codebase before making changes
- When you want to analyze code structure and dependencies
- When planning a refactoring or major change
- When the user asks you to "plan" or "think about" something

## Plan Mode Features

- Provides a structured environment for code analysis
- Helps identify affected files and potential issues
- Allows for careful step-by-step reasoning
- Creates a task list to track the planned work

## Notes

- Plan mode is read-only by default
- You can use Task tool with action "create" to plan out work
- Use ExitPlanMode when you're done planning
`;
}

export function getExitPlanModeToolPrompt(): string {
  return `Use this tool to exit plan mode.

## When to Use This Tool

- When you've finished planning and want to start implementation
- When you want to leave the planning environment
- When the user confirms your plan and you're ready to proceed

## Notes

- Make sure you've completed your planning before exiting
- Any tasks created in plan mode will remain
- You can re-enter plan mode at any time
`;
}

export const MODE_DESCRIPTIONS: Record<AgentMode, string> = {
  general: 'General purpose mode with full tool access',
  plan: 'Planning mode - read-only exploration and design',
  explore: 'Exploration mode - quick read-only code search',
  verify: 'Verification mode - read-only testing and validation',
  'code-review': 'Code review mode - read-only code inspection',
};

const READONLY_MODE_BANNED_TOOLS = new Set([
  'Write',
  'Edit',
  'touch',
  'rm',
  'mv',
  'cp',
  'mkdir',
  'Task',
]);

const ALWAYS_ALLOWED_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'Bash',
  'Agent',
  'Task',
  'task',
  'EnterPlanMode',
  'ExitPlanMode',
  'SwitchMode',
  'Brief',
  'Browser',
  'SessionSearch',
  'Config',
  'duya_cli',
  'Skill',
  'Vision',
]);

export interface ModeConfig {
  readOnly: boolean;
  bannedTools: Set<string>;
  systemPromptSuffix: string;
}

export const MODE_CONFIGS: Record<AgentMode, ModeConfig> = {
  general: {
    readOnly: false,
    bannedTools: new Set(),
    systemPromptSuffix: '',
  },
  plan: {
    readOnly: true,
    bannedTools: READONLY_MODE_BANNED_TOOLS,
    systemPromptSuffix: `

=== CRITICAL: READ-ONLY MODE ===
You are in PLAN mode. You are STRICTLY PROHIBITED from:
- Creating or modifying files (no Write, Edit, touch, mkdir)
- Deleting files (no rm)
- Moving or copying files (no mv, cp)

Your role is EXCLUSIVELY to explore the codebase and design implementation plans. Use Task tool with action "create" to plan your work.`,
  },
  explore: {
    readOnly: true,
    bannedTools: READONLY_MODE_BANNED_TOOLS,
    systemPromptSuffix: `

=== CRITICAL: READ-ONLY MODE ===
You are in EXPLORE mode. You are STRICTLY PROHIBITED from:
- Creating or modifying files (no Write, Edit, touch, mkdir)
- Deleting files (no rm)
- Moving or copying files (no mv, cp)

Your role is EXCLUSIVELY to explore and search the codebase. Be thorough and efficient.`,
  },
  verify: {
    readOnly: true,
    bannedTools: READONLY_MODE_BANNED_TOOLS,
    systemPromptSuffix: `

=== CRITICAL: READ-ONLY MODE ===
You are in VERIFY mode. You are STRICTLY PROHIBITED from:
- Creating or modifying files (no Write, Edit, touch, mkdir)
- Deleting files (no rm)
- Moving or copying files (no mv, cp)

Your role is EXCLUSIVELY to verify implementation correctness. Run tests, check outputs, and try to break things.`,
  },
  'code-review': {
    readOnly: true,
    bannedTools: READONLY_MODE_BANNED_TOOLS,
    systemPromptSuffix: `

=== CRITICAL: READ-ONLY MODE ===
You are in CODE REVIEW mode. You are STRICTLY PROHIBITED from:
- Creating or modifying files (no Write, Edit, touch, mkdir)
- Deleting files (no rm)
- Moving or copying files (no mv, cp)

Your role is EXCLUSIVELY to review code for quality, bugs, security issues, and best practices.`,
  },
};

export function isToolAllowedInMode(toolName: string, mode: AgentMode): boolean {
  const config = MODE_CONFIGS[mode];
  if (!config.readOnly) return true;
  if (ALWAYS_ALLOWED_TOOLS.has(toolName)) return true;
  if (config.bannedTools.has(toolName)) return false;
  return true;
}

export function filterToolsByMode<T extends { name: string }>(tools: T[], mode: AgentMode): T[] {
  if (mode === 'general') return tools;
  return tools.filter((tool) => isToolAllowedInMode(tool.name, mode));
}

export interface ModeToolPort {
  getCurrentMode(): AgentMode;
  setAgentMode(mode: AgentMode): void;
  isReadOnlyMode(): boolean;
  transitionPlanMode(event: 'activate_from_tool' | 'exit_approved'): void;
  resolvePlanFilePath(sessionId: string): string;
  probeOrCreateEmptyPlanFile(sessionId: string): Promise<PlanFileSeedStatus>;
}

export class SwitchModeTool extends BaseTool {
  readonly name = SWITCH_MODE_TOOL_NAME;
  readonly description = SWITCH_MODE_TOOL_DESCRIPTION;
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: [...ALL_MODES],
        description: 'The mode to switch to',
      },
      reason: {
        type: 'string',
        description: 'Why you are switching modes',
      },
    },
    required: ['mode'],
  };

  constructor(private readonly port: ModeToolPort) {
    super();
  }

  getPrompt(): string {
    return getSwitchModeToolPrompt();
  }

  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    const mode = input.mode as AgentMode;
    if (!ALL_MODES.includes(mode)) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          error: `Invalid mode: ${mode}. Valid modes: ${ALL_MODES.join(', ')}`,
        }),
        error: true,
      };
    }

    const previousMode = this.port.getCurrentMode();
    const reason = input.reason as string | undefined;
    this.port.setAgentMode(mode);

    const contextWithAppState = context as (ToolUseContext & {
      setAppState?: (update: (state: Record<string, unknown>) => Record<string, unknown>) => void;
    }) | undefined;
    contextWithAppState?.setAppState?.((previous) => ({ ...previous, agentMode: mode }));

    const config = MODE_CONFIGS[mode];
    const result: Record<string, unknown> = {
      previousMode,
      currentMode: mode,
      readOnly: config.readOnly,
      message: getModeSwitchMessage(mode, previousMode, reason),
    };
    if (config.systemPromptSuffix) result.guidance = config.systemPromptSuffix.trim();

    return {
      id: crypto.randomUUID(),
      name: this.name,
      result: JSON.stringify(result),
    };
  }
}

function getModeSwitchMessage(mode: AgentMode, previousMode: AgentMode, reason?: string): string {
  const reasonText = reason ? ` Reason: ${reason}` : '';
  if (mode === previousMode) return `Already in ${mode} mode.${reasonText}`;

  const transitions: Record<string, string> = {
    'general->plan': 'Switched to PLAN mode. You can now explore and design.',
    'general->explore': 'Switched to EXPLORE mode. You can now search and investigate.',
    'general->verify': 'Switched to VERIFY mode. You can now run tests and verify.',
    'general->code-review': 'Switched to CODE REVIEW mode. You can now review code.',
    'plan->general': 'Exited plan mode. Ready for implementation.',
    'explore->general': 'Exited explore mode.',
    'verify->general': 'Exited verify mode.',
    'code-review->general': 'Exited code review mode.',
    'plan->explore': 'Switched from plan to explore mode.',
    'plan->verify': 'Switched from plan to verify mode.',
    'plan->code-review': 'Switched from plan to code review mode.',
    'explore->plan': 'Switched from explore to plan mode.',
    'explore->verify': 'Switched from explore to verify mode.',
    'explore->code-review': 'Switched from explore to code review mode.',
    'verify->plan': 'Switched from verify to plan mode.',
    'verify->explore': 'Switched from verify to explore mode.',
    'verify->code-review': 'Switched from verify to code review mode.',
    'code-review->plan': 'Switched from code review to plan mode.',
    'code-review->explore': 'Switched from code review to explore mode.',
    'code-review->verify': 'Switched from code review to verify mode.',
  };
  return transitions[`${previousMode}->${mode}`] ?? `Switched to ${mode} mode.${reasonText}`;
}

export class EnterPlanModeTool extends BaseTool {
  readonly name = ENTER_PLAN_MODE_TOOL_NAME;
  readonly description = ENTER_PLAN_MODE_TOOL_DESCRIPTION;
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {},
    required: [],
  };

  constructor(private readonly port: ModeToolPort) {
    super();
  }

  getPrompt(): string {
    return getEnterPlanModeToolPrompt();
  }

  async execute(_input: Record<string, unknown>, _workingDirectory?: string, context?: ToolUseContext): Promise<ToolResult> {
    const sessionId = context?.options?.sessionId ?? 'default';
    const planFile = this.port.resolvePlanFilePath(sessionId);

    if (this.port.isReadOnlyMode()) {
      const seed = await this.port.probeOrCreateEmptyPlanFile(sessionId);
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({ message: 'Already in plan mode', planMode: true, planFile, seed }),
      };
    }

    this.port.setAgentMode('plan');
    this.port.transitionPlanMode('activate_from_tool');
    const seed = await this.port.probeOrCreateEmptyPlanFile(sessionId);
    return {
      id: crypto.randomUUID(),
      name: this.name,
      result: JSON.stringify({
        message: 'Entered plan mode. Use Task tool with action "create" to plan your work.',
        planMode: true,
        planFile,
        seed,
      }),
    };
  }
}

export class ExitPlanModeTool extends BaseTool {
  readonly name = EXIT_PLAN_MODE_TOOL_NAME;
  readonly description = EXIT_PLAN_MODE_TOOL_DESCRIPTION;
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {},
    required: [],
  };

  constructor(private readonly port: ModeToolPort) {
    super();
  }

  getPrompt(): string {
    return getExitPlanModeToolPrompt();
  }

  async execute(): Promise<ToolResult> {
    if (!this.port.isReadOnlyMode()) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({ message: 'Not in plan mode', planMode: false }),
      };
    }

    this.port.setAgentMode('general');
    this.port.transitionPlanMode('exit_approved');
    return {
      id: crypto.randomUUID(),
      name: this.name,
      result: JSON.stringify({ message: 'Exited plan mode. Ready for implementation.', planMode: false }),
    };
  }
}
