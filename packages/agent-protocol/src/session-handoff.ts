/**
 * Handing the current session over to the desktop app.
 *
 * ## What a handoff is
 *
 * The TUI owns the session; the desktop app is where the user wants to
 * continue it. A handoff is therefore a REQUEST to the desktop, not a state
 * change the Host performs: the Host carries the request, the desktop main
 * process forwards it to the renderer, and the renderer switches to the
 * session. The Host never claims the session moved — it reports whether the
 * request was accepted.
 *
 * ## Why the capability is optional
 *
 * A TUI that owns its own Host has no desktop app to hand the session to.
 * Such a Host answers 404 `session_handoff_unavailable`. "This Host cannot
 * do that" and "the handoff failed" are different statements, and the caller
 * has to be able to tell them apart.
 */

/** Which session the desktop app should switch to. */
export interface HostSessionHandoffInput {
  readonly sessionId: string;
}

/** The outcome of a handoff attempt. */
export type HostSessionHandoffResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * The Host capability that hands a session over to the desktop app.
 *
 * Injected by the desktop main process. A Host without it answers 404
 * `session_handoff_unavailable`.
 */
export interface HostSessionHandoffApiV1 {
  openInDesktopApp(input: HostSessionHandoffInput): Promise<HostSessionHandoffResult>;
}
