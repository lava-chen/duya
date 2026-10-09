/**
 * The permission overlay.
 *
 * ## Why an overlay and not a transcript line
 *
 * A permission request is a QUESTION, and the transcript is a record of what
 * already happened. Putting a question in the record means the user has to
 * scroll to find out whether they already answered it, and an answered
 * request looks exactly like an unanswered one. It also has to take focus, or
 * the keystroke that answers it goes into the prompt instead.
 *
 * ## The answering caveat, stated rather than hidden
 *
 * Measured from `headless-run-host.ts`: a headless run has NO permission
 * coordinator — `permissionResponder` is absent, which the module's own header
 * documents as "a `permission.requested` in a headless run has nobody to
 * answer it", reported as `permissionExpiryClock: 'absent'`.
 *
 * So on THIS path the overlay is reachable in principle but may never be
 * shown, because nothing answers the request even if the user picks. The
 * overlay is therefore honest about capability: it reports whether a responder
 * is wired, and when one is not, saying so is better than rendering a prompt
 * whose every answer has the same outcome.
 */

/** A permission decision the user can make. */
export type PermissionDecision = 'once' | 'always' | 'deny';

export interface OverlayRequest {
  readonly requestId: string;
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly reason: string;
  readonly blockedPath?: string;
}

/** Render the tool input compactly, without a full JSON dump. */
function summariseInput(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return input;
  try {
    const json = JSON.stringify(input);
    return json.length > 240 ? `${json.slice(0, 237)}...` : json;
  } catch {
    return String(input);
  }
}

/** The overlay's body, as blessed tags. */
export function renderOverlay(
  request: OverlayRequest,
  answerable: boolean,
): string {
  const lines: string[] = [];
  lines.push(`{bold}{yellow-fg}Permission required{/yellow-fg}{/bold}`);
  lines.push(`tool: {cyan-fg}${request.toolName}{/cyan-fg}`);

  const input = summariseInput(request.toolInput);
  if (input !== '') lines.push(`input: {gray-fg}${input}{/gray-fg}`);
  if (request.reason !== '') lines.push(`reason: {gray-fg}${request.reason}{/gray-fg}`);
  if (request.blockedPath !== undefined && request.blockedPath !== '') {
    lines.push(`path: {gray-fg}${request.blockedPath}{/gray-fg}`);
  }

  if (answerable) {
    lines.push('');
    lines.push('{bold}(y)es{/bold}  {bold}(n)o{/bold}  {bold}(a)lways{/bold}  {gray-fg}esc: cancel{/gray-fg}');
  } else {
    // See the module comment: without a responder every key does the same
    // thing, so the overlay says so instead of pretending to offer a choice.
    lines.push('');
    lines.push('{red-fg}no permission responder is attached to this run; this request cannot be answered here{/red-fg}');
  }

  return lines.join('\n');
}

export class OverlayState {
  private current: OverlayRequest | null = null;
  private resolver: ((decision: PermissionDecision | null) => void) | null = null;

  /** True while the overlay is on screen. */
  get isActive(): boolean {
    return this.current !== null;
  }

  /** The request on screen, if any. */
  get request(): OverlayRequest | null {
    return this.current;
  }

  /** Body to render, or `null` when the overlay is closed. */
  body(answerable: boolean): string | null {
    return this.current === null ? null : renderOverlay(this.current, answerable);
  }

  /** Show a request; `onDecision` settles when the user answers or cancels. */
  show(request: OverlayRequest, onDecision: (decision: PermissionDecision | null) => void): void {
    this.current = request;
    this.resolver = onDecision;
  }

  /**
   * Answer the current request.
   *
   * A decision made with no request open is ignored rather than thrown: the
   * key handler is bound to the screen, so a stray keypress after close would
   * otherwise take down the turn.
   */
  decide(decision: PermissionDecision | null): void {
    const settle = this.resolver;
    this.current = null;
    this.resolver = null;
    settle?.(decision);
  }
}
