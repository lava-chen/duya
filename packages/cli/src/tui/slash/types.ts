/**
 * packages/cli/src/tui/slash/types.ts
 *
 * Contract for the TUI slash commands implemented in this directory.
 *
 * The TUI is a thin HTTP client of the Host (see packages/cli/src/chat.ts):
 * it holds no agent runtime and no React/React-ink state, so a command can
 * only do two things — read Host state through the client, or drive the
 * terminal through the small `tui` surface below. Anything a command wants
 * from the outer chat loop (a new session record after `/model`) comes back
 * as a structured outcome instead of a callback, so the dispatch site stays
 * a single `switch`.
 */

import type { HostSessionRecord } from '@duya/agent-protocol';
import type { HostSessionHttpClient } from '@duya/host/http-client';
import type { TuiChoice } from '../TUIApp.js';

/** The slice of `TUIApp` a slash command may touch. */
export interface TuiSlashHost {
  printNotice(text: string): void;
  printError(message: string): void;
  choose(title: string, choices: readonly TuiChoice[]): Promise<string | null>;
  chooseFiltered?(
    title: string,
    choices: readonly TuiChoice[],
    options?: { readonly initialFilter?: string; readonly footer?: string },
  ): Promise<string | null>;
  promptText?(
    title: string,
    options?: { readonly initialValue?: string; readonly secret?: boolean; readonly placeholder?: string },
  ): Promise<string | null>;
  showPanel?(
    title: string,
    lines: readonly string[],
    options?: { readonly footer?: string; readonly scrollable?: boolean },
  ): void;
}

export interface TuiSlashContext {
  readonly client: HostSessionHttpClient;
  /** Snapshot of the session this command was typed into. */
  readonly session: HostSessionRecord;
  readonly tui: TuiSlashHost;
  /** True while a turn is streaming. Read-only commands still work. */
  readonly busy: boolean;
  /**
   * Actions the chat loop owns and a command cannot perform alone: they need
   * the loop's queue, transcript and status line. Omitted in tests and in any
   * context without a live loop — a command that needs one must say so rather
   * than pretend to have done it.
   */
  readonly actions?: TuiSlashActions;
}

export interface TuiSlashActions {
  /** Interrupt the streaming turn (same as Esc). */
  interrupt: () => void;
  /** Adopt another session: reload the transcript and the status line. */
  adoptSession: (sessionId: string) => Promise<void>;
  /** Leave the current session behind (archive/delete): start a fresh one. */
  startFreshSession: () => Promise<void>;
}

export type TuiSlashOutcome =
  | { readonly kind: 'handled' }
  /** The chat loop must adopt this session record (status line, next run). */
  | { readonly kind: 'session_updated'; readonly session: HostSessionRecord };

export type TuiSlashGroup = 'Model' | 'Settings' | 'Session info' | 'Session ops' | 'Export';

export interface TuiSlashCommandDef {
  readonly name: string;
  readonly aliases?: readonly string[];
  /** Shown in `/help` after the name, e.g. `[model]`. */
  readonly argsHint?: string;
  readonly description: string;
  readonly group: TuiSlashGroup;
  readonly run: (ctx: TuiSlashContext, args: string) => Promise<TuiSlashOutcome>;
}
