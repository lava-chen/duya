/**
 * SwitchModeTool Prompt
 * Guides the agent on when and how to use mode switching
 */

export const DESCRIPTION = 'Switch the agent between different behavioral modes (plan, explore, verify, code-review, general)'

export function getPrompt(): string {
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

Always provide a "reason" field explaining why you're switching modes. This helps the user understand your thinking.`
}