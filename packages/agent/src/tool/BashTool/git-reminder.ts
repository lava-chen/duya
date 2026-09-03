/**
 * Git command detection + dynamic reminder injection.
 *
 * Detects whether a BashTool command line invokes git and, if so, returns
 * a `<system-reminder>` block to be appended to the tool_result. The reminder
 * reinforces git identity / safety constraints that are otherwise baked into
 * the BashTool system prompt; injecting it only on git invocations saves
 * ~800 tokens of static prompt prefix per non-git turn.
 */
const GIT_REMINDER = `<system-reminder>
You are about to execute a git command. Follow these rules exactly:

**Identity (most important):** NEVER update the git config (user.name, user.email, etc.). Commit using whatever identity is already configured on this repository. If a commit would be authored under an unexpected identity, stop and ask the user.

**Hooks:** NEVER skip hooks (--no-verify, --no-gpg-sign) unless the user explicitly requests it.

**Branch protection:** NEVER force push to main/master. Warn the user if they request it.

**Destructive ops:** NEVER run destructive git commands (push --force, reset --hard, checkout --, restore --, clean -f, branch -D) unless the user explicitly requests these actions.

**No amend:** Always create NEW commits rather than amending. A failed pre-commit hook means the commit did NOT happen, so --amend would modify the PREVIOUS commit and risk destroying work.

**No auto-commit:** NEVER commit unless the user explicitly asks.

If any rule above conflicts with the user's request, surface the conflict and ask before proceeding.
</system-reminder>`;

/**
 * Tokenize a shell command into argv-style tokens. Handles simple quoting;
 * does not handle every edge case of POSIX shell parsing — sufficient for
 * detecting a leading `git` invocation.
 */
function tokenize(cmd: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * Return true if the command invokes `git` as a real binary (not as a
 * substring of an argument or a comment). Recognizes:
 *   - git ...
 *   - /usr/bin/git ...
 *   - git.exe ...
 *   - bash -c "git ..."
 *   - env VAR=val git ...
 */
export function isGitCommand(cmd: string): boolean {
  const tokens = tokenize(cmd);
  for (const tok of tokens) {
    // Skip env-var prefix tokens (KEY=VALUE)
    if (/^[A-Z_][A-Z0-9_]*=/.test(tok)) {
      continue;
    }
    // Match leading `git`, `git.exe`, or absolute/path/git[.exe]
    if (/(\/|\\)git(\.exe)?$/.test(tok) || tok === 'git' || tok === 'git.exe') {
      return true;
    }
    return false; // first non-env, non-git token = not a git command
  }
  return false;
}

/**
 * Build the dynamic git reminder block. Returns null for non-git commands
 * so the caller can cheaply no-op.
 */
export function buildGitReminder(cmd: string): string | null {
  if (!isGitCommand(cmd)) {
    return null;
  }
  return GIT_REMINDER;
}