/**
 * packages/cli/src/tui/slash/app.ts
 *
 * `/app` — hand this session over to the desktop app.
 *
 * ## Why this command exists
 *
 * The CLI and the desktop app talk to the same Host and share the same
 * sessions, but they are two different programs: a conversation started in
 * the terminal is awkward to continue in a window, and the other way round
 * is worse. `/app` is the explicit handover — the CLI asks the Host to open
 * THIS session in the desktop app, and the desktop app picks it up there.
 *
 * ## Why the CLI asks the Host
 *
 * The TUI is a pure HTTP client of the Host (see packages/cli/src/chat.ts).
 * The handover is therefore a Host call — `POST /v1/local/session-handoff`
 * with the session id — and not something the CLI tries to do by reaching
 * for the desktop app itself. The Host owns the session, so the Host is
 * what decides whether the handover is possible.
 *
 * ## "This Host cannot answer" is not a failed handover
 *
 * A Host without the handover route answers 404
 * `session_handoff_unavailable`. That is not "the handover failed" — it is
 * "this Host cannot answer the question", and the two are rendered
 * differently. A refusal that said "the handover failed" would blame the
 * desktop app for a route the Host never had.
 */

import type { TuiSlashCommandDef, TuiSlashContext } from './types.js';
import { describeError, hostErrorCode, showPanel } from './shared.js';

const FOOTER = 'Esc close';

/**
 * The slice of the Host client this command depends on.
 *
 * `openInDesktopApp(sessionId)` ships on `HostSessionHttpClient` together
 * with the Host's handover route. It is declared here as a structural
 * interface so this file states the contract it calls instead of trusting
 * a payload shape; a client that does not carry the method cannot hand
 * anything over, and that is a fact the command can report rather than a
 * crash it cannot.
 */
interface SessionHandoffCapableClient {
  openInDesktopApp(sessionId: string): Promise<unknown>;
}

/**
 * What the handover answer says.
 *
 * `undefined` means the answer is not a handover answer at all — a
 * different fact from a handover that was refused.
 */
function readHandoff(payload: unknown): 'ok' | 'refused' | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
  const ok = (payload as { readonly ok?: unknown }).ok;
  if (ok === true) return 'ok';
  if (ok === false) return 'refused';
  return undefined;
}

const APP_COMMAND: TuiSlashCommandDef = {
  name: 'app',
  description: 'Hand this session over to the desktop app',
  group: 'Session ops',
  async run(ctx: TuiSlashContext) {
    // The Host's handover route lands `openInDesktopApp` on the client. A
    // client without it cannot hand anything over, and the command says so
    // rather than calling into nothing.
    const client: Partial<SessionHandoffCapableClient> = ctx.client;
    if (typeof client.openInDesktopApp !== 'function') {
      ctx.tui.printError(
        'This CLI cannot hand the session over: its Host client does not offer the handover route.',
      );
      return { kind: 'handled' };
    }

    let payload: unknown;
    try {
      payload = await client.openInDesktopApp(ctx.session.id);
    } catch (error) {
      // A Host without the handover route cannot answer. That is not the
      // same as a failed handover, and it is rendered differently.
      if (hostErrorCode(error) === 'session_handoff_unavailable') {
        showPanel(ctx, 'Open in the desktop app', [
          'This Host does not serve the session handover, so it cannot answer.',
          '',
          '  That is different from a failed handover — here the request was',
          '  never accepted by an authority that could perform it.',
          '',
          '  Source: Host session handover (POST /v1/local/session-handoff),',
          '  404 session_handoff_unavailable.',
        ], { footer: FOOTER, scrollable: true });
        return { kind: 'handled' };
      }
      ctx.tui.printError(`Could not hand the session over: ${describeError(error)}`);
      return { kind: 'handled' };
    }

    const outcome = readHandoff(payload);
    if (outcome === undefined) {
      ctx.tui.printError(
        'Could not hand the session over: the Host answered with something that is not a handover answer.',
      );
      return { kind: 'handled' };
    }
    if (outcome === 'refused') {
      ctx.tui.printError(`The Host refused to hand session ${ctx.session.id} over to the desktop app.`);
      return { kind: 'handled' };
    }

    ctx.tui.printNotice(`Handed session ${ctx.session.id} to the desktop app.`);
    return { kind: 'handled' };
  },
};

export const APP_COMMANDS: readonly TuiSlashCommandDef[] = [APP_COMMAND];
