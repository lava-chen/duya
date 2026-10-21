/**
 * The per-REQUEST cancellation scope: one model call, its own deadline, and
 * both released when that call settles.
 *
 * ## What this is
 *
 * The runtime's copy of a discipline the legacy loop already keeps
 * (`DuyaAgent.ts:2252-2266`, released in a `finally` at `:3398-3403`). It exists
 * because `llmRequestTimeoutMs` has no home in this package: measured, the name
 * and the primitive it needs (`createChildAbortController`) appear ZERO times
 * across `packages/agent-runtime`, so a turn loop migrated onto this engine
 * would have nowhere to put a per-request cap and would silently lose it.
 *
 * The purpose is the legacy's own words (`DuyaAgent.ts:2246-2251`): end a
 * single model call that overruns EVEN WHILE THE STREAM IS STILL PRODUCING DATA
 * -- a thinking stream that never converges -- so a hung turn fails fast
 * instead of consuming the whole run budget. A run-level ceiling cannot do this:
 * it is either never reached or already spent, and the signal it would use
 * outlives the request it would have to kill.
 *
 * ## Why the parent is an `AbortSignal` and NOT an `AbortController`
 *
 * Because a signal cannot be aborted by the holder of a signal, and that is the
 * property this whole file exists to protect. The run's authority outlives every
 * request inside it: `RunEngineImpl.execute` builds ONE controller per run
 * (`run-engine.ts:237`) and both `handle.stop` and the caller's signal reach it
 * (`:238`, `:267`). Given the CONTROLLER, "on timeout, abort the run" would be a
 * one-token change with no type error and no failing test -- the child would be
 * built from a handle that can do exactly that, and the whole run would die at
 * the first slow request. Given the signal, that mistake is UNREPRESENTABLE:
 * there is no object in scope here with an `abort` method that reaches the run.
 *
 * That is why the third mutation proof for this slice cannot even be written
 * against this module, and the assertion in `request-timeout-cap.test.ts` that
 * covers the same property is stated against the ENGINE, which does hold the
 * controller.
 *
 * ## Why this is not a port
 *
 * Because a port is a CAPABILITY a host supplies, and this is CONFIGURATION the
 * caller already has. Plan 600 S2 b3a named the failure mode for the other
 * choice -- "a sibling port would mean a second optional binding a host could
 * forget", and forgetting is how the answer is silently lost (`ports.ts:738-748`).
 * That argument does not transfer, and the difference is worth stating rather
 * than assuming:
 *
 *  - A forgotten `TurnOutputPort` binding LOSES DATA. The engine still runs, and
 *    the tool result simply never reaches the host's transcript.
 *  - A forgotten cap LOSES A GUARDRAIL. Nothing the run depends on disappears;
 *    the worst case is the pre-cap behaviour, which is what runs do today.
 *
 * So the asymmetry that made `recordAssistantMessage` a method rather than a
 * sibling port does not hold here, and `port-guards.ts` asserts the decision
 * structurally: a cancellation port added to `RunEnginePorts` turns the build
 * red, so the "cap as a second optional binding" shape cannot quietly return.
 *
 * ## Why the timeout is the child's, never the parent's
 *
 * Same reason, one level down. The legacy aborts the child
 * (`requestController?.abort(...)`, `DuyaAgent.ts:2259`) and the parent survives
 * it, which is what keeps the run stoppable and re-armable afterwards. Aborting
 * the parent instead would turn "this request was slow" into "this run is over",
 * and the run-level signal is the one resource a later turn still needs.
 */

/**
 * One model's worth of cancellation, and the release of everything it owns.
 *
 * `dispose()` is REQUIRED rather than optional and is called on every exit path
 * of the request, including the throwing one. Two resources leak if it is
 * skipped: the timer, which holds the process open, and the parent's `abort`
 * listener, which keeps every earlier request reachable for the life of the run.
 */
export interface RequestScope {
  /**
   * What the model port is given. The run's own signal when no cap is
   * configured -- deliberately the SAME OBJECT, so an uncapped request has no
   * child controller and no listener to leak.
   */
  readonly signal: AbortSignal;
  /** Idempotent. Clears the timer and detaches the parent listener. */
  dispose(): void;
}

/**
 * Open the cancellation scope for one model call.
 *
 * ## Absence is a VALUE, not a missing branch
 *
 * `timeoutMs` absent, non-numeric, non-finite, or `<= 0` all mean the same
 * thing -- no cap -- and all of them take the no-cap path, which creates NO
 * timer and NO child. That is the legacy rule verbatim: the timer is armed
 * inside `if (options?.llmRequestTimeoutMs && options.llmRequestTimeoutMs > 0)`
 * (`DuyaAgent.ts:2255`), so `0`, a negative number and `undefined` all leave the
 * request uncapped. The `Number.isFinite` case has no legacy counterpart and
 * exists because this function takes a `number | undefined` from a port boundary
 * where a host may have coerced: `NaN` compares false against `> 0`, so it would
 * fall through to the capped path and arm a timer that never fires, which is
 * strictly worse than no timer at all.
 */
export function openRequestScope(signal: AbortSignal, timeoutMs: number | undefined): RequestScope {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    // No child, no timer, nothing to release. `dispose` is still a function
    // because the caller's `finally` must not have to know which kind it got.
    return { signal, dispose: () => {} };
  }

  const child = new AbortController();
  let detach: () => void;

  if (signal.aborted) {
    // Born aborted, and NOT disposed-of-early: a request opened on a dead run
    // must not be handed an un-aborted signal, or a caller could conclude the
    // request is live when the run stopped before it began. The legacy gets this
    // for free from `createChildAbortController` (`abort/index.ts:23-26`).
    child.abort(signal.reason);
    detach = () => {};
  } else {
    const onParentAbort = (): void => child.abort(signal.reason);
    signal.addEventListener('abort', onParentAbort, { once: true });
    detach = (): void => signal.removeEventListener('abort', onParentAbort);
  }

  const timer = setTimeout(() => {
    // The CHILD, and only the child. See the file header.
    child.abort(new Error(`LLM request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  let released = false;
  return {
    signal: child.signal,
    dispose(): void {
      // Idempotent, because both the request's own exit and the throwing path
      // call it and a double `clearTimeout` is harmless while a double
      // `removeEventListener` on an already-detached handler is merely noise.
      if (released) return;
      released = true;
      clearTimeout(timer);
      detach();
    },
  };
}
