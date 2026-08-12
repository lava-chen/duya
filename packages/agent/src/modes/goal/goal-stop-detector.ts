/**
 * Goal premature-stop detector (grok goal_stop_detector.rs, duya-ized).
 *
 * The model is judged to be bailing out when the LAST non-empty paragraph
 * of its turn-final text starts with one of the surrender / hand-off
 * signals below. On a hit the harness injects a bail-specific continuation
 * nudge instead of the generic one, so a "giving up" ending cannot
 * silently end the goal while open work remains.
 *
 * Ported without a regex dependency (duya avoids native deps in this
 * path): each pattern is a line-anchored prefix matcher with the same
 * semantics as grok's anchored regexes. The patterns are intentionally
 * conservative — a broad catch-all would fire on routine work narration
 * ("Once the test settles I'll iterate") and drown the real bail signal.
 *
 * Returned labels mirror grok's `PATTERN_*` constants so dashboards can
 * audit precision/recall of the panel.
 */

/** The bail signals, in declaration (priority) order. */
export const STOP_PATTERNS = [
  'unable_to_proceed',
  'giving_up',
  'stopping_here',
  'agents_in_flight',
  'check_back_later',
  'verdict_line',
  'commit_push_pr',
  'ready_for_review',
  'please_deflection',
] as const;

export type StopPattern = (typeof STOP_PATTERNS)[number];

/** Bail: "I can't proceed / continue / make progress / complete this". */
const RE_UNABLE_TO_PROCEED =
  /^I (?:can(?:'?t|not)|am unable to) (?:proceed|continue|make (?:any )?progress|complete|fix this)\b/i;

/** Bail: "Giving up" / "The task is not actionable". */
const RE_GIVING_UP =
  /^(?:Giving up|I(?:'m| am) giving up|The task is not actionable)\b/i;

/** Bail: "Stopping here" / "Parked the branch" / "Paused here". */
const RE_STOPPING_HERE =
  /^(?:Stopping here|I've stopped here|Parked (?:the|this) branch|Paused here)(?:\.|,|;|$| for | — | -| until| pending| since| because)/i;

/** Bail: "N agents in flight" / "Loop active" / "Waiting for the cron". */
const RE_AGENTS_IN_FLIGHT =
  /^(?:(?:\*\*)?[1-9]\d* (?:agent|cron|task|fork|job|worker|PR|check)s? (?:in flight|remaining|active|still (?:running|working)|pending|running|launched)\b|(?:Continuous )?(?:[Ll]oop|[Cc]rons?|[Bb]abysit) (?:active|healthy|continuing|running|will keep|continues)\b|Waiting for (?:the )?(?:agent|cron|task|fork|worker|job|remaining|them)s?\b|Agents? will report back\b|Waiting\.?$)/;

/** Bail: "I'll check back / retry / poll later". */
const RE_CHECK_BACK_LATER =
  /^(?:I will|I'll|Will) (?:check back|re-?check|poll|look again|retry|re-?run|try again) (?:in\b|again\b|(?:when|once|after|until)\s+(\S+))/i;

/** Bail: a self-sign-off `VERDICT: PASS|FAIL` line. */
const RE_VERDICT_LINE = /^VERDICT: (?:PASS|FAIL)\b/i;

/** Bail: "Pushed ..." / "Committed ..." / "Opened PR #N". */
const RE_COMMIT_PUSH_PR =
  /^(?:Pushed (?:to `|`[0-9a-f]{7,})|Committed as `?[0-9a-f]{7,}\b|Commit: `?[0-9a-f]{7,}\b|(?:Opened|Created) PR #?\d)/i;

/** Bail: "Ready for review / to merge / to ship". */
const RE_READY_FOR_REVIEW = /^Ready (?:for review|to (?:upload|merge|ship|land))\b/i;

/** Bail: "Please <verb> X for me" user-deflection. */
const RE_PLEASE_DEFLECTION =
  /^Please (?:start|run|provide|grant|export|add|install|configure|give me|paste|point me|set (?:the |up |`?[A-Z][A-Z0-9_]+\b))/i;

/**
 * Check-back-later post-filter (grok `check_back_later_matches`): the
 * broad matcher captures the trailing token after `when|once|after|until`;
 * `you`/`your` + boundary means a deferral BACK TO THE USER, which is NOT
 * a self-bail. `in`/`again` branches are unconditional bails.
 */
function checkBackLaterMatches(line: string): boolean {
  const m = line.match(RE_CHECK_BACK_LATER);
  if (!m) return false;
  const target = m[1];
  if (!target) return true; // `in` / `again` — always a bail
  return !isUserPronoun(target);
}

function isUserPronoun(token: string): boolean {
  const lower = token.toLowerCase();
  for (const stem of ['your', 'you']) {
    if (lower.startsWith(stem)) {
      const rest = lower.slice(stem.length);
      const next = rest[0];
      if (!next || (!/[a-z0-9_]/.test(next) && next !== '_')) return true;
    }
  }
  return false;
}

function lineMatches(label: StopPattern, line: string): boolean {
  switch (label) {
    case 'unable_to_proceed':
      return RE_UNABLE_TO_PROCEED.test(line);
    case 'giving_up':
      return RE_GIVING_UP.test(line);
    case 'stopping_here':
      return RE_STOPPING_HERE.test(line);
    case 'agents_in_flight':
      return RE_AGENTS_IN_FLIGHT.test(line);
    case 'check_back_later':
      return checkBackLaterMatches(line);
    case 'verdict_line':
      return RE_VERDICT_LINE.test(line);
    case 'commit_push_pr':
      return RE_COMMIT_PUSH_PR.test(line);
    case 'ready_for_review':
      return RE_READY_FOR_REVIEW.test(line);
    case 'please_deflection':
      return RE_PLEASE_DEFLECTION.test(line);
  }
}

/**
 * Return the first bail pattern matched by the LAST non-empty paragraph
 * of `text` (grok: only the turn-final paragraph is judged, so a mid-turn
 * "I can't continue without your input" is not a bail). Returns undefined
 * when no signal matches.
 */
export function matchedStopPattern(text: string): StopPattern | undefined {
  const paragraphs = (text ?? '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const last = paragraphs[paragraphs.length - 1];
  if (!last) return undefined;
  // Judge the final paragraph line by line (first matching line wins).
  const lines = last.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    for (const label of STOP_PATTERNS) {
      if (lineMatches(label, trimmed)) return label;
    }
  }
  return undefined;
}

/** Convenience boolean wrapper (production callers use matchedStopPattern). */
export function looksLikePrematureStop(text: string): boolean {
  return matchedStopPattern(text) !== undefined;
}

/** Bail-specific continuation nudge, replacing the generic one. */
export function prematureStopNudge(pattern: StopPattern): string {
  switch (pattern) {
    case 'unable_to_proceed':
    case 'giving_up':
      return 'You signaled you cannot proceed, but the goal still has open work. Do not give up — change approach or break the blocker into smaller steps, and keep the todo list current.';
    case 'stopping_here':
      return 'You stopped before the goal was complete. Continue working — pick the next plan step or todo item and keep going.';
    case 'agents_in_flight':
    case 'check_back_later':
      return 'Background work is not a reason to stop the goal. Continue with the next actionable step now; you can incorporate background results as they arrive.';
    case 'verdict_line':
      return 'You signed off with a verdict line, but the harness has not verified completion. Do not self-sign-off — call update_goal(completed: true) only when the objective is actually achieved.';
    case 'commit_push_pr':
    case 'ready_for_review':
      return 'Committing/pushing or marking ready-for-review does not complete the goal. Continue verifying the whole objective before reporting completion.';
    case 'please_deflection':
      return 'Do not deflect the remaining work back to the user. Continue driving the goal yourself toward the next concrete step.';
  }
}
