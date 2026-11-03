/**
 * Per-tool result formatting and grouping — the "renderer follows the tool"
 * layer.
 *
 * ## Why this exists
 *
 * The transcript used to render every tool result as one muted blob. Two
 * consequences, both visible on screen:
 *
 *  - `grep` returns a structured report (`{success,matches,total,truncated}`),
 *    so the reader got raw JSON where three lines of `path:line  content`
 *    would have said the same thing in a shape they could scan.
 *  - every `read`, `glob` and `grep` call took a full row of its own, so one
 *    exploration pass scrolled the transcript.
 *
 * This module answers both, without teaching the renderer about any specific
 * tool: the tool NAME picks a formatter and a group family
 * (`toolGroupKey`), and `transcript-view` stays generic. That is the same
 * arrangement the reference UIs use — pi and claude-code colocate a renderer
 * with each tool definition; DeepSeek groups explore-family cells.
 *
 * ## Pass-through is the default
 *
 * A tool this module does not know returns its result untouched, because the
 * renderer still has one generic treatment worth keeping: a result that looks
 * like a diff is colourised. Formatters must therefore only ever return
 * something when they are CONFIDENT the result is theirs, and `null` when they
 * are not — a half-parsed report rendered as prose is worse than JSON.
 */

import { formatTaskDuration, isSubagentTool } from './subagent.js';

/** The status a tool block carries, mirrored from `ToolBlock`. */
export type ToolStatus = 'running' | 'ok' | 'error' | 'unknown';

/** Tools whose consecutive calls read as one exploration pass. */
const EXPLORE_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'glob',
  'grep',
  // Legacy names, kept so an older transcript still groups.
  'read_file',
  'search_files',
]);

/**
 * The tool name a command the USER ran carries.
 *
 * A name of its own, so the reader can tell whose command produced the output:
 * the agent's `bash` and the user's `!` command share a body renderer but
 * never a grouping family, never a wording and never a cache key.
 *
 * Deliberately not `shell`: a plugin or MCP tool could carry that name, and a
 * card that says "You ran" must mean the command the USER ran.
 */
export const LOCAL_SHELL_TOOL = 'local_shell';

/**
 * The grouping family of the commands the user ran themselves.
 *
 * Its own family, so a local command never folds into the agent's shell batch
 * — "Ran 2 commands" must mean two commands the AGENT ran.
 */
export const LOCAL_SHELL_FAMILY = 'user-shell';

/**
 * The output lines a command the user ran may show.
 *
 * Far more than an agent call gets: the output is what the user asked for, and
 * codex gives its user-shell cells the same headroom.
 */
export const LOCAL_SHELL_RESULT_LINES = 50;

/** Tools that run a shell command. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(['bash', 'powershell', 'terminal', LOCAL_SHELL_TOOL]);

/**
 * The key two adjacent tool blocks must share to render as a group.
 *
 * Explore-family tools group ACROSS names — a `glob` followed by a `read` is
 * the same search pass, and rendering them as three separate heads is what
 * made exploration scroll. Shell-family tools likewise (a `powershell` after a
 * `bash`). Everything else only groups with its own name.
 */
export function toolGroupKey(name: string): string {
  if (name === LOCAL_SHELL_TOOL) return LOCAL_SHELL_FAMILY;
  if (EXPLORE_TOOLS.has(name)) return 'explore';
  if (SHELL_TOOLS.has(name)) return 'shell';
  return name;
}

/** True when the tool runs a shell command. */
export function isShellTool(name: string): boolean {
  return SHELL_TOOLS.has(name);
}

/** True when the command was run by the user, not by the agent. */
export function isLocalShellTool(name: string): boolean {
  return name === LOCAL_SHELL_TOOL;
}

/**
 * The command a shell tool was invoked with, UNCLIPPED.
 *
 * The head preview is clipped to keep one line, but the evidence line inside
 * the body must show the whole command: a clipped command in the body is a
 * lie about what ran.
 */
export function shellCommandOf(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const command = (input as { command?: unknown }).command;
  return typeof command === 'string' && command.trim() !== '' ? command : undefined;
}

/** The line `BashTool` prepends to a failed command's output. */
const EXIT_CODE_LINE = /^\[Exit code: -?\d+\]$/u;

/**
 * Whether this output line is the exit-code line `BashTool` prepends.
 *
 * Exported because two renderers need the same answer for different reasons:
 * the selection below hoists the line out of a tail, and the transcript paints
 * it in the error colour instead of the muted one. Testing for it twice, with
 * two regexes, is how one of them drifts.
 */
export function isExitCodeLine(line: string): boolean {
  return EXIT_CODE_LINE.test(line.trim());
}

/**
 * Choose the lines of a shell result worth showing.
 *
 * Success shows head-tail: the conclusion of a successful command is usually
 * its LAST line, and its first lines say what it was doing. Failure shows the
 * tail, because that is where the error is. The exit code is hoisted above
 * whatever is selected — it is the one fact a failure must never lose, and the
 * line `BashTool` prints it on is the first, which a tail selection drops.
 */
export function selectShellOutput(result: string, status: ToolStatus, budget: number): string[] {
  const lines = result.split('\n').filter((line, index, all) => line !== '' || index < all.length - 1);
  if (lines.length === 0) return ['(no output)'];

  const exitLine = status === 'error'
    ? lines.find((line) => isExitCodeLine(line))
    : undefined;
  const body = exitLine === undefined ? lines : lines.filter((line) => line !== exitLine);
  const head: string[] = exitLine === undefined ? [] : [exitLine];

  if (body.length <= budget) return [...head, ...body];

  if (status === 'error') {
    const tail = body.slice(body.length - budget);
    return [...head, `… ${body.length - tail.length} earlier lines hidden`, ...tail];
  }

  const headPart = body.slice(0, Math.max(1, budget - 1));
  const tailPart = body.slice(-1);
  const hidden = body.length - headPart.length - tailPart.length;
  return [...head, ...headPart, `… ${hidden} lines hidden`, ...tailPart];
}

/**
 * Format a tool result for the transcript, or return it unchanged.
 *
 * Only `grep`, `glob` and the subagent spawn have a formatter today; everything
 * else is pass-through so the renderer's diff colourising still applies.
 */
export function formatToolResult(name: string, result: string): string {
  if (name === 'grep') {
    const formatted = formatGrepReport(result);
    if (formatted !== null) return formatted;
  }
  if (name === 'glob') {
    const formatted = formatGlobReport(result);
    if (formatted !== null) return formatted;
  }
  if (isSubagentTool(name)) {
    const formatted = formatSubagentReport(result);
    if (formatted !== null) return formatted;
  }
  return result;
}

/** Parse a result that should be a JSON object, or `null`. */
function parseReport(result: string): Record<string, unknown> | null {
  const trimmed = result.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The failure shape `grep` and `glob` both emit — `{success:false, error}`.
 * Returns the message, or `null` when this is not a failed report.
 */
function failureOf(report: Record<string, unknown>): string | null {
  if (report['success'] !== false) return null;
  const error = report['error'];
  return typeof error === 'string' && error !== '' ? error : 'the tool failed';
}

/**
 * `grep`'s JSON report as prose.
 *
 * `total` is preferred over `matches.length` for the header: `total` is the
 * true number of matching lines, while `matches` may have been capped, and
 * reporting the capped count as the total is how a partial search reads as a
 * complete one.
 */
function formatGrepReport(result: string): string | null {
  const report = parseReport(result);
  if (report === null) return null;
  const failure = failureOf(report);
  if (failure !== null) return `error: ${failure}`;
  const matches = report['matches'];
  if (!Array.isArray(matches)) return null;

  const total = typeof report['total'] === 'number' ? report['total'] : matches.length;
  const truncated = report['truncated'] === true;
  const lines = [`${total} match${total === 1 ? '' : 'es'} found${truncated ? ' (truncated)' : ''}`];
  for (const entry of matches) {
    if (typeof entry !== 'object' || entry === null) continue;
    const match = entry as { file?: unknown; line?: unknown; content?: unknown };
    const file = typeof match['file'] === 'string' ? match['file'] : '';
    const line = typeof match['line'] === 'number' ? match['line'] : 0;
    const content = typeof match['content'] === 'string' ? match['content'] : '';
    lines.push(`${file}:${line}  ${content}`);
  }
  return lines.join('\n');
}

/**
 * `glob`'s report as prose.
 *
 * A success is already human text (`N files matched\n\n<paths>`); the only
 * thing worth removing is the blank padding line, which on a five-line budget
 * costs a whole row of output. A failure is JSON and becomes one `error:`.
 */
function formatGlobReport(result: string): string | null {
  const report = parseReport(result);
  if (report !== null) {
    const failure = failureOf(report);
    return failure === null ? null : `error: ${failure}`;
  }
  if (!result.includes('\n\n')) return null;
  const chunks = result.split(/\n{2,}/u).filter((chunk) => chunk.trim() !== '');
  return chunks.join('\n');
}

/** `940`, `12.3k`, `1.2M` — the same thresholds the footer uses. */
function compactTokens(count: number): string {
  const value = Math.max(0, Math.round(count));
  if (value < 1000) return String(value);
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** A finite number from a parsed receipt, or 0. */
function receiptNumber(report: Record<string, unknown>, key: string): number {
  const value = report[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * A subagent receipt as a report, or `null` when this is not one.
 *
 * ## Why the receipt is not shown as JSON
 *
 * The `task` tool returns a typed receipt — status, counts, duration, tokens,
 * and above all `content`, which is the child's ANSWER. Rendered raw, the whole
 * thing is one line of JSON in which the answer is the tail of a key, and the
 * reader has to parse punctuation to find the only part they wanted. The header
 * line is the receipt's own numbers, the body is the answer.
 *
 * ## `running` is not a failure and not a completion
 *
 * A background spawn returns immediately with `status: 'running'`; calling that
 * `completed` would be a claim about work that has not happened, and calling it
 * `failed` would be worse. The word is printed as it came, and the elapsed
 * fields are simply absent because the run has not produced them yet.
 */
function formatSubagentReport(result: string): string | null {
  const report = parseReport(result);
  if (report === null) return null;
  const content = typeof report['content'] === 'string' ? report['content'].trim() : '';
  const error = typeof report['error'] === 'string' ? report['error'].trim() : '';
  // A receipt without either half is not the shape this formatter knows; the
  // raw result is then the honest thing to print.
  if (content === '' && error === '') return null;

  const status = typeof report['status'] === 'string' ? report['status'] : '';
  const headline: string[] = [];
  if (status === 'running' || report['background'] === true) headline.push('background');
  else if (status !== '') headline.push(status);

  const tools = receiptNumber(report, 'totalToolUseCount');
  if (tools > 0) headline.push(`${tools} tool${tools === 1 ? '' : 's'}`);
  const duration = receiptNumber(report, 'totalDurationMs');
  if (duration > 0) headline.push(formatTaskDuration(duration));
  const tokens = receiptNumber(report, 'totalTokens');
  if (tokens > 0) headline.push(`${compactTokens(tokens)} tokens`);

  const lines: string[] = [];
  if (headline.length > 0) lines.push(headline.join(' · '));
  if (error !== '') lines.push(`error: ${error}`);
  if (content !== '') lines.push(content);

  const warnings = report['warnings'];
  if (Array.isArray(warnings)) {
    for (const warning of warnings) {
      if (typeof warning === 'string' && warning.trim() !== '') lines.push(`warning: ${warning.trim()}`);
    }
  }
  return lines.join('\n');
}
