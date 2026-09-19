/**
 * task-verification — subagent completion contract (plan 554, minimax
 * `task-verification.ts` parity).
 *
 * Three pieces:
 *  1. `VERDICT_CONTRACT` — appended to delegated sub-agent prompts so the
 *     child's final reply ends with exactly one machine-parseable
 *     `VERDICT: PASS | FAIL | PARTIAL` line. The parent gets a typed
 *     verdict instead of having to interpret prose.
 *  2. `parseModelVerdict` — the STRICT parent-side parser. Exactly one
 *     well-formed verdict line in the whole reply; markdown decoration,
 *     extra tokens, or multiple verdict lines all count as "no verdict"
 *     (`undefined`), never as a guessed one. Distinct from the goal
 *     evaluator's lenient fallback parser (`modes/goal/goal-evaluator.ts`),
 *     which must degrade conservatively for verification panels — here an
 *     absent verdict simply means "unparsed", not "failed".
 *  3. File-change observation — best-effort `git status --porcelain`
 *     snapshots before/after a child run, diffed into added/removed
 *     entries. This is an observation, NOT a sandbox: the child can touch
 *     files outside the repo or race the snapshot. Report wording says so.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Max porcelain lines retained per snapshot (bounded context). */
const MAX_FILE_CHANGE_LINES = 50;

export type SubagentVerdict = 'pass' | 'fail' | 'partial';

/**
 * Prompt block appended to delegated sub-agent prompts. Read-only explorer
 * agents (Explore/Plan) are exempted by the caller — a search report has
 * no pass/fail semantics.
 */
export const VERDICT_CONTRACT = [
  '',
  'Completion contract: when you finish this task, your final reply must end',
  'with exactly one line in the following form (no markdown, no extra words',
  'on that line):',
  '  VERDICT: PASS    — the task is fully done and verified',
  '  VERDICT: FAIL    — you could not complete the task',
  '  VERDICT: PARTIAL — some progress, but the task is not fully done',
  'The verdict line is parsed mechanically; a missing or malformed one reads',
  'as "no verdict" on the parent side.',
].join('\n');

/**
 * Read-only agent types exempt from the VERDICT contract: their replies
 * are findings reports, not completion claims.
 */
export function wantsVerdictContract(agentType: string): boolean {
  return !/^(explore|plan)$/i.test((agentType ?? '').trim());
}

/** Strictly parse the single well-formed verdict line from a reply. */
export function parseModelVerdict(text: string | undefined | null): SubagentVerdict | undefined {
  if (!text) return undefined;
  const matches = text.match(/^\s*VERDICT:\s*(PASS|FAIL|PARTIAL)\s*$/gim);
  if (!matches || matches.length !== 1) return undefined;
  const token = matches[0]!.trim().split(/:\s*/i)[1]!.toUpperCase();
  return token === 'PASS' ? 'pass' : token === 'FAIL' ? 'fail' : 'partial';
}

/**
 * Best-effort `git status --porcelain` snapshot of `cwd`. Returns undefined
 * when git is unavailable or the directory is not a repo — callers treat
 * that as "no observation", never as "no changes".
 */
export async function captureGitFileChanges(
  cwd: string | undefined,
): Promise<string[] | undefined> {
  if (!cwd) return undefined;
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain', '--untracked-files=normal'],
      { cwd, timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true },
    );
    const lines = stdout.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
    return lines.slice(0, MAX_FILE_CHANGE_LINES);
  } catch {
    return undefined;
  }
}

export interface FileChangeDiff {
  /** Porcelain lines present after the run but not before. */
  added: string[];
  /** Porcelain lines present before the run but not after. */
  removed: string[];
}

export function diffFileChanges(
  before: string[] | undefined,
  after: string[] | undefined,
): FileChangeDiff | undefined {
  if (!before || !after) return undefined;
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const added = after.filter((l) => !beforeSet.has(l));
  const removed = before.filter((l) => !afterSet.has(l));
  if (added.length === 0 && removed.length === 0) return { added: [], removed: [] };
  return { added, removed };
}

/**
 * Compact parent-report block appended to a delegated sub-agent's result so
 * the parent model gets the mechanical facts (verdict + observed file
 * changes) alongside the child's prose. Bounded and plain-text.
 */
export function buildSubagentParentReport(input: {
  verdict?: SubagentVerdict;
  fileChange?: FileChangeDiff;
}): string | undefined {
  const parts: string[] = [];
  parts.push(`model_verdict: ${input.verdict ?? 'none'}`);
  if (input.fileChange && (input.fileChange.added.length > 0 || input.fileChange.removed.length > 0)) {
    const total = input.fileChange.added.length + input.fileChange.removed.length;
    parts.push(
      `file_change (best-effort observation, not a sandbox): ${total} entr${total === 1 ? 'y' : 'ies'}` +
        ` (+${input.fileChange.added.length} / -${input.fileChange.removed.length})`,
    );
    for (const line of [...input.fileChange.added, ...input.fileChange.removed].slice(0, 20)) {
      parts.push(`  ${line}`);
    }
  }
  const report = parts.join('\n');
  return report;
}
