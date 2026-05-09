/**
 * BashTool Prompt
 * Comprehensive prompt for shell command execution
 * Adapted from claude-code-haha with duya-specific customizations
 */

import { prependBullets } from '../../prompts/constants/promptSections.js'

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
  return 120000 // 2 minutes
}

/**
 * Maximum timeout in milliseconds
 */
export function getMaxTimeoutMs(): number {
  return 600000 // 10 minutes
}

// ============================================================
// Background Commands
// ============================================================

function getBackgroundUsageNote(): string | null {
  return "You can use the `run_in_background` parameter to run the command in the background. Only use this if you don't need the result immediately and are OK being notified when the command completes later. You do not need to check the output right away - you'll be notified when it finishes. You do not need to use '&' at the end of the command when using this parameter."
}

// ============================================================
// Git Instructions
// ============================================================

function getGitCommitInstructions(): string {
  return `# Committing changes with git

Only create commits when explicitly requested by the user. If unclear, ask first. When the user asks you to create a commit, follow these steps carefully:

You can call multiple tools in a single response. When multiple independent pieces of information are requested and all commands are likely to succeed, run multiple tool calls in parallel for optimal performance.

**Git Safety Protocol:**
- NEVER update the git config
- NEVER run destructive git commands (push --force, reset --hard, checkout --, restore --, clean -f, branch -D) unless the user explicitly requests these actions
- NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it
- NEVER run force push to main/master, warn the user if they request it
- **CRITICAL: Always create NEW commits rather than amending** - when a pre-commit hook fails, the commit did NOT happen, so --amend would modify the PREVIOUS commit which may result in destroying work
- When staging files, prefer adding specific files by name rather than using "git add -A" or "git add ." which can accidentally include sensitive files (.env, credentials) or large binaries
- NEVER commit changes unless the user explicitly asks you to

1. Run the following bash commands in parallel:
   - \`git status\` to see all untracked files (never use -uall flag)
   - \`git diff\` to see both staged and unstaged changes
   - \`git log\` to see recent commit messages for style reference

2. Analyze all staged changes and draft a commit message:
   - Summarize the nature of the changes (new feature, enhancement, bug fix, refactoring, test, docs, etc.)
   - Ensure the message accurately reflects the changes and their purpose
   - Draft a concise (1-2 sentences) commit message that focuses on "why" not "what"
   - Do not commit files that likely contain secrets (.env, credentials.json, etc.)

3. Run the following commands in parallel:
   - Add relevant untracked files to staging area
   - Create the commit with a message via HEREDOC for proper formatting

4. Run \`git status\` after the commit to verify success

**Example commit format:**
\`\`\`bash
git commit -m "$(cat <<'EOF'
   Add user authentication feature

   Implement JWT-based auth with refresh token rotation.
   EOF
)"
\`\`\`

**Important:**
- NEVER run additional commands to read or explore code beyond git commands
- Do not push to the remote unless the user explicitly asks
- If there are no changes to commit, do not create an empty commit`
}

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

  const maxTimeout = getMaxTimeoutMs()
  const defaultTimeout = getDefaultTimeoutMs()

  const instructionItems: Array<string | string[]> = [
    'If your command will create new directories or files, first use this tool to run `ls` to verify the parent directory exists.',
    'Always quote file paths that contain spaces with double quotes (e.g., cd "path with spaces/file.txt")',
    'Try to maintain your current working directory by using absolute paths and avoiding `cd`. Use `cd` only if the user explicitly requests it.',
    `You may specify an optional timeout in milliseconds (up to ${maxTimeout}ms / ${maxTimeout / 60000} minutes). Default timeout is ${defaultTimeout}ms (${defaultTimeout / 60000} minutes).`,
    ...(backgroundNote !== null ? [backgroundNote] : []),
    'When issuing multiple commands:',
    multipleCommandsSubitems,
    'For git commands:',
    gitSubitems,
    'Avoid unnecessary `sleep` commands:',
    sleepSubitems,
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
    getGitCommitInstructions(),
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

  const maxTimeout = getMaxTimeoutMs()
  const defaultTimeout = getDefaultTimeoutMs()

  const instructionItems: Array<string | string[]> = [
    'If your command will create new directories or files, first verify the parent directory exists.',
    'Always quote file paths that contain spaces.',
    'Use absolute paths to maintain your current working directory.',
    `Timeout: up to ${maxTimeout}ms. Default: ${defaultTimeout}ms.`,
    ...(backgroundNote !== null ? [backgroundNote] : []),
    'For git commands:',
    gitSubitems,
    'Avoid `sleep` commands:',
    sleepSubitems,
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
