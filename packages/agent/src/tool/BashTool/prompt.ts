/**
 * BashTool Prompt
 * Comprehensive prompt for shell command execution
 * Adapted from claude-code-haha with duya-specific customizations
 */

import { prependBullets } from '../../prompts/constants/promptSections.js'
import {
  BASH_DEFAULT_TIMEOUT_MS,
  BASH_MAX_FOREGROUND_TIMEOUT_MS,
  BASH_MAX_TIMEOUT_MS,
  BASH_SOFT_YIELD_MS,
} from './constants.js'

export const BASH_TOOL_NAME = 'Bash'

// Tool name constants for consistency
const GLOB_TOOL_NAME = 'Glob'
const GREP_TOOL_NAME = 'Grep'
const FILE_READ_TOOL_NAME = 'Read'
const FILE_EDIT_TOOL_NAME = 'Edit'
const FILE_WRITE_TOOL_NAME = 'Write'

/**
 * Default timeout in milliseconds
 */
export function getDefaultTimeoutMs(): number {
  return BASH_DEFAULT_TIMEOUT_MS
}

/**
 * Maximum timeout in milliseconds. Kept as the absolute floor (background-only);
 * foreground is capped tighter via {@link BASH_MAX_FOREGROUND_TIMEOUT_MS}.
 */
export function getMaxTimeoutMs(): number {
  return BASH_MAX_TIMEOUT_MS
}

/**
 * Foreground command ceiling. Pushed into the model-facing prompt so the
 * runtime cap is mirrored in the model-facing contract.
 */
export function getMaxForegroundTimeoutMs(): number {
  return BASH_MAX_FOREGROUND_TIMEOUT_MS
}

// ============================================================
// Background Commands
// ============================================================

/**
 * Model-facing guidance for when to use `run_in_background`. Foreground
 * commands block until they finish or hit the timeout ceiling, so anything
 * known to be long-running should opt in explicitly.
 */
function getBackgroundUsageNote(): string | null {
  return [
    `You can use the \`run_in_background\` parameter to run the command in the background. Only use this if you don't need the result immediately and are OK being notified when the command completes later. You do not need to check the output right away — you'll be notified when it finishes. Use \`get_task_output\` with the returned task ID to fetch results on demand, and \`kill_task\` to terminate a background task if needed. You do not need to use '&' at the end of the command when using this parameter.`,
    `A foreground command that is still running after ${BASH_SOFT_YIELD_MS}ms (${BASH_SOFT_YIELD_MS / 1000}s) is auto-promoted to a background task without being restarted: the call returns its task ID and you are notified when it finishes. Do not re-run a command that was auto-promoted — check it with \`get_task_output\` or wait for the notification. A promoted command is bounded by ${BASH_MAX_TIMEOUT_MS}ms (${BASH_MAX_TIMEOUT_MS / 60_000} minutes).`,
    `Do not increase \`timeout\` to mask a hung foreground command. The foreground ceiling is ${BASH_MAX_FOREGROUND_TIMEOUT_MS}ms (${BASH_MAX_FOREGROUND_TIMEOUT_MS / 60_000} minutes); for anything longer, opt into \`run_in_background: true\` and let the runtime watchdog handle it.`,
  ].join(' ')
}

// ============================================================
function getGitPRInstructions(): string {
  return `# Creating pull requests

Use \`gh\` command via Bash for ALL GitHub-related tasks including issues, pull requests, checks, and releases.

1. Run the following bash commands in parallel to understand the current state:
   - \`git status\` to see untracked files (never use -uall flag)
   - \`git diff\` to see staged and unstaged changes
   - \`git log\` and \`git diff [base-branch]...HEAD\` to understand the full commit history

2. Analyze all changes and draft a PR:
   - Keep the PR title short (under 70 characters)
   - Use description/body for details, not the title
   - Review ALL commits that will be included, not just the latest

3. Run the following commands in parallel:
   - Create new branch if needed
   - Push to remote with -u flag if needed
   - Create PR using \`gh pr create\`

**Example PR format:**
\`\`\`bash
gh pr create --title "feat: add user authentication" --body "$(cat <<'EOF'
## Summary
- Add JWT-based authentication
- Implement refresh token rotation

## Test plan
- [ ] Verify login works with valid credentials
- [ ] Verify token refresh works
- [ ] Run existing test suite
EOF
)"
\`\`\``
}

function getGitSubitems(): string[] {
  return [
    'Prefer to create a new commit rather than amending an existing commit.',
    'Before running destructive operations (e.g., git reset --hard, git push --force, git checkout --), consider whether there is a safer alternative. Only use destructive operations when truly the best approach.',
    'Never skip hooks (--no-verify) or bypass signing (--no-gpg-sign, -c commit.gpgsign=false) unless the user explicitly asks. If a hook fails, investigate and fix the underlying issue.',
  ]
}

// ============================================================
// Sleep & Polling Instructions
// ============================================================

function getSleepSubitems(): string[] {
  return [
    'Do not sleep between commands that can run immediately — just run them.',
    'If your command is long running and you would like to be notified when it finishes — use `run_in_background`. No sleep needed.',
    'Do not retry failing commands in a sleep loop — diagnose the root cause.',
    'If waiting for a background task you started with `run_in_background`, you will be notified when it completes — do not poll.',
    'If you must poll an external process, use a check command (e.g., `gh run view`) rather than sleeping first.',
    'If you must sleep, keep the duration short (1-5 seconds) to avoid blocking the user.',
  ]
}

// ============================================================
// Multiple Commands
// ============================================================

function getMultipleCommandsSubitems(): string[] {
  return [
    `If commands are independent and can run in parallel, make multiple ${BASH_TOOL_NAME} tool calls in a single message. Example: if you need to run "git status" and "git diff", send a single message with two ${BASH_TOOL_NAME} tool calls in parallel.`,
    `If commands depend on each other and must run sequentially, use a single ${BASH_TOOL_NAME} call with '&&' to chain them together.`,
    "Use ';' only when you need to run commands sequentially but don't care if earlier commands fail.",
    'DO NOT use newlines to separate commands (newlines are ok in quoted strings).',
  ]
}

// ============================================================
// Tool Preferences
// ============================================================

function getToolPreferenceItems(): string[] {
  return [
    `File search: Use ${GLOB_TOOL_NAME} (NOT find or ls)`,
    `Content search: Use ${GREP_TOOL_NAME} (NOT grep or rg)`,
    `Read files: Use ${FILE_READ_TOOL_NAME} (NOT cat/head/tail)`,
    `Edit files: Use ${FILE_EDIT_TOOL_NAME} (NOT sed/awk)`,
    `Write files: Use ${FILE_WRITE_TOOL_NAME} (NOT echo >/cat <<EOF)`,
    'Communication: Output text directly (NOT echo/printf)',
  ]
}

// ============================================================
// Danger Warning
// ============================================================

function getDangerWarningItems(): string[] {
  return [
    'Always verify the command before executing, especially for destructive operations.',
    'For file operations, confirm the correct path to avoid accidental data loss.',
    'When in doubt, ask the user to confirm before proceeding with risky commands.',
  ]
}

// ============================================================
// Windows Encoding & Path Guidance
// ============================================================

function getWindowsEncodingItems(): string[] {
  return [
    'On Windows, the shell environment is UTF-8. When writing Chinese or other non-ASCII characters:',
    '  - Use `printf` instead of `echo` for writing files with Chinese content (e.g., `printf \'{"name":"陈炫羽"}\' > file.json`)',
    '  - Use `python -X utf8` or set `PYTHONUTF8=1` env var when running Python scripts that output Chinese',
    '  - For file paths: use forward slashes (`/c/Users/...`) in Git Bash, or use native Windows paths with proper quoting. Git Bash handles both.',
    '  - Avoid `>nul` redirect syntax — use `/dev/null` instead (Git Bash does not understand `nul`)',
    '  - If output is truncated, use more specific commands (e.g., `head -n 20`, `grep`) or redirect to a file',
  ]
}

// ============================================================
// Main Prompt
// ============================================================

/**
 * Get the complete BashTool prompt
 */
export function getBashPrompt(): string {
  const toolPreferenceItems = getToolPreferenceItems()
  const avoidCommands = '`find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo`'
  const multipleCommandsSubitems = getMultipleCommandsSubitems()
  const gitSubitems = getGitSubitems()
  const sleepSubitems = getSleepSubitems()
  const backgroundNote = getBackgroundUsageNote()
  const dangerWarningItems = getDangerWarningItems()
  const windowsEncodingItems = getWindowsEncodingItems()

  const maxTimeout = getMaxTimeoutMs()
  const maxForegroundTimeout = getMaxForegroundTimeoutMs()
  const defaultTimeout = getDefaultTimeoutMs()

  const instructionItems: Array<string | string[]> = [
    'If your command will create new directories or files, first use this tool to run `ls` to verify the parent directory exists.',
    'Always quote file paths that contain spaces with double quotes (e.g., cd "path with spaces/file.txt")',
    'Try to maintain your current working directory by using absolute paths and avoiding `cd`. Use `cd` only if the user explicitly requests it.',
    `You may specify an optional timeout in milliseconds. Foreground: default ${defaultTimeout}ms, ceiling ${maxForegroundTimeout}ms (${maxForegroundTimeout / 60000} minutes). Background (run_in_background=true): up to ${maxTimeout}ms (${maxTimeout / 60000} minutes).`,
    ...(backgroundNote !== null ? [backgroundNote] : []),
    'When issuing multiple commands:',
    multipleCommandsSubitems,
    'For git commands:',
    gitSubitems,
    'Avoid unnecessary `sleep` commands:',
    sleepSubitems,
    'For Windows encoding/path handling:',
    windowsEncodingItems,
  ]

  return [
    'Executes a given bash command and returns its output.',
    '',
    "The working directory persists between commands, but shell state does not. The shell environment is initialized from the user's profile (bash or zsh).",
    '',
    `IMPORTANT: Avoid using this tool to run ${avoidCommands} commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience:`,
    '',
    ...prependBullets(toolPreferenceItems),
    `While the ${BASH_TOOL_NAME} tool can do similar things, it's better to use the built-in tools as they provide a better user experience and make it easier to review tool calls.`,
    '',
    '# Instructions',
    ...prependBullets(instructionItems),
    '',
    '# Command Safety',
    ...prependBullets(dangerWarningItems),
    '',
    getGitPRInstructions(),
  ].join('\n')
}

/**
 * Get a simplified BashTool prompt (shorter version)
 */
export function getSimplePrompt(): string {
  const toolPreferenceItems = getToolPreferenceItems()
  const avoidCommands = '`find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo`'
  const gitSubitems = getGitSubitems()
  const sleepSubitems = getSleepSubitems()
  const backgroundNote = getBackgroundUsageNote()
  const windowsEncodingItems = getWindowsEncodingItems()

  const maxTimeout = getMaxTimeoutMs()
  const maxForegroundTimeout = getMaxForegroundTimeoutMs()
  const defaultTimeout = getDefaultTimeoutMs()

  const instructionItems: Array<string | string[]> = [
    'If your command will create new directories or files, first verify the parent directory exists.',
    'Always quote file paths that contain spaces.',
    'Use absolute paths to maintain your current working directory.',
    `Timeout: foreground default ${defaultTimeout}ms, ceiling ${maxForegroundTimeout}ms; background up to ${maxTimeout}ms.`,
    ...(backgroundNote !== null ? [backgroundNote] : []),
    'For git commands:',
    gitSubitems,
    'Avoid `sleep` commands:',
    sleepSubitems,
    'For Windows encoding/path handling:',
    windowsEncodingItems,
  ]

  return [
    'Executes a bash command and returns its output.',
    '',
    `IMPORTANT: Avoid ${avoidCommands} commands. Use dedicated tools instead:`,
    '',
    ...prependBullets(toolPreferenceItems),
    '',
    '# Instructions',
    ...prependBullets(instructionItems),
  ].join('\n')
}
