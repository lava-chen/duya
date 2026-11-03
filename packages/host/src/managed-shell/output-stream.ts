/**
 * The per-command output channel a RUNNING shell writes into.
 *
 * ## Why this exists as its own module
 *
 * A managed command's stdout goes to a file, not to this process
 * (`managed-shell.ts`, `stdio: ['ignore', fd.fd, fd.fd]`), so the bytes only
 * become observable if somebody reads that file while the command runs. The
 * reader is the shell task; the interested parties are runs, and a run lives one
 * layer above (`worker-engine-driver`) and must not be reachable from here.
 * A taskId-keyed pub/sub is the whole coupling either direction needs.
 *
 * ## Why it is keyed by taskId and not by sessionId
 *
 * `taskId` IS the tool call id for a managed shell command: the engine's call
 * becomes `ToolUseContext.toolUseId` (`ToolExecutionPipeline.ts:354`), which
 * `BashTool.ts:398` uses verbatim as the task id. Keying on it therefore needs
 * no mapping table and cannot cross two runs that share a session — a subagent
 * and its parent dispatch different call ids, so each hears only its own
 * commands. Keying on `sessionId` would make the parent replay its child's
 * output under a call id it never issued.
 *
 * ## What this channel is NOT
 *
 * Not durable and not a queue. Subscribers are live-only and a dropped slice is
 * unrecoverable, which is exactly what the protocol says about
 * `tool.output_delta` (`durability: 'ephemeral'`): the authoritative text is the
 * tool's RESULT, and this stream only exists so a row can show something while
 * the command runs.
 */

/** One slice of what a running command has printed since the last slice. */
export interface ShellOutputSlice {
  readonly taskId: string;
  readonly delta: string;
}

export type ShellOutputListener = (slice: ShellOutputSlice) => void;

const listeners = new Map<string, Set<ShellOutputListener>>();

/**
 * Start listening to one command's output.
 *
 * Returns the unsubscribe, and an idempotent one: calling it twice, or after the
 * listener was already removed, is a no-op rather than an error — a run's
 * teardown path has more than one exit and none of them should throw here.
 */
export function onShellOutput(taskId: string, listener: ShellOutputListener): () => void {
  if (taskId === '') return () => { /* nothing to key on */ };
  let set = listeners.get(taskId);
  if (set === undefined) {
    set = new Set();
    listeners.set(taskId, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(taskId);
    if (current === undefined) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(taskId);
  };
}

/**
 * Whether anybody wants this command's bytes.
 *
 * The poller asks this once, before it starts. A command nobody is watching must
 * not pay a timer and a file read four times a second — the common case, since
 * Desktop has no live shell surface and a backgrounded task has already stopped
 * being looked at.
 */
export function hasShellOutputListener(taskId: string): boolean {
  return listeners.get(taskId)?.size ? true : false;
}

/** Hand one slice to whoever asked for this command. Listeners never see each other. */
export function emitShellOutput(slice: ShellOutputSlice): void {
  const set = listeners.get(slice.taskId);
  if (set === undefined || set.size === 0) return;
  // A listener that throws must not cost the other listeners their slice, and
  // must not stop the poller: the command is still running and its output is
  // still going to the same file either way.
  for (const listener of [...set]) {
    try {
      listener(slice);
    } catch {
      /* one broken subscriber is not this channel's failure */
    }
  }
}

/**
 * Drop every subscriber.
 *
 * For tests and for a host shutdown. Production teardown uses the unsubscribe
 * each `onShellOutput` returned, so that a leak shows up as one dangling key
 * rather than as a cleared room nobody can debug.
 */
export function resetShellOutputListeners(): void {
  listeners.clear();
}
