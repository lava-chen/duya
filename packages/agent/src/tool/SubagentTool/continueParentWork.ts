/**
 * Backgound subagent spawn guidance — aligned to Grok's
 * `should_continue_parent_work` heuristics.
 *
 * When the parent agent spawns a background subagent, we want it to NOT sit
 * idle polling the child. Two complementary prompts cover both cases:
 *   - The parent still has unfinished exec work → tell it to keep working
 *     ("Do not only poll the child. Continue unfinished parent work now.").
 *   - The parent has nothing left but to wait on the child → tell it to yield
 *     the turn and rely on the async completion notification instead of
 *     self-imposed `sleep`/poll loops.
 *
 * The decision is heuristic over the parent's recent user asks, mirroring
 * Grok: only append the CTA when the latest ask (or the two before it) shows
 * unfinished parent exec work besides the delegated child job.
 */

/** Plain-text CTA when the parent still has unfinished work. */
export const BACKGROUND_SUBAGENT_CONTINUE_PARENT_WORK: string =
  'Do not only poll the child. Continue unfinished parent work now.'

/** Guidance when the parent has nothing left but to wait on the child. */
export const BACKGROUND_SUBAGENT_IDLE_NOTICE: string =
  'You will be notified automatically when the subagent completes. Do not wait or poll for it.'

/** How many asks before the latest may still count as leftover parent exec. */
const PRIOR_EXEC_LOOKBACK = 2

/**
 * Whether background-spawn text should tell the parent to keep its own work
 * going. `userAsks` are recent parent user texts (oldest → newest), not
 * including this spawn's tool call. `childDescription` / `childPrompt` are the
 * spawn being acknowledged.
 *
 * Returns true only when the latest ask (or either of the two before it) shows
 * unfinished parent exec work besides the delegated child job. No asks → false.
 */
export function shouldContinueParentWork(
  userAsks: string[],
  childDescription: string,
  childPrompt: string,
): boolean {
  const child = `${childDescription}\n${childPrompt}`
  const last = userAsks[userAsks.length - 1]
  if (last === undefined) return false
  const prior = userAsks.slice(0, -1)
  const skip = Math.max(0, prior.length - PRIOR_EXEC_LOOKBACK)
  const recentPrior = prior.slice(skip)
  if (recentPrior.some((a) => blobHasExec(a))) return true
  if (blobHasExec(last) && (blobIsDelegate(last) || blobIsDelegate(child))) return true
  if (blobHasExec(last) && !blobIsDelegate(last)) return true
  // "while waiting, spawn …" — parent still has the waiting work.
  const lastLower = last.toLowerCase()
  if (lastLower.includes('while waiting') || lastLower.includes('whilst waiting')) return true
  return false
}

function blobHasExec(text: string): boolean {
  const t = text.toLowerCase()
  const NEEDLES: string[] = [
    'smoke',
    'op_chain',
    'ci fail',
    'ci failure',
    'still fail',
    'still fails',
    'failing',
    'pytest',
    'cargo test',
    'npm test',
    'deploy',
    'bringup',
    'implement',
    'unfinished',
    'rebase',
    'nondetermin',
    'fix the ',
    'fix these ',
    'fix all ',
    'check ',
    ' bug',
    'bugs',
    'run the test',
    'run tests',
    'pass/fail',
    'integration test',
    'pr check',
    'ci check',
  ]
  return NEEDLES.some((n) => t.includes(n))
}

function blobIsDelegate(text: string): boolean {
  const t = text.toLowerCase()
  const NEEDLES: string[] = [
    'spawn an agent',
    'spawn a subagent',
    'spawn a agent',
    'spawn subagent',
    'spawn agent',
    'spawn as many',
    'review this pr',
    'review the pr',
    'review this pull',
    'code review',
    'peer review',
    'subagent review',
    'independent review',
    'reviewer',
  ]
  return NEEDLES.some((n) => t.includes(n))
}