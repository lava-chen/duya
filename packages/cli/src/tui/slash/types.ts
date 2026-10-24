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
import type { CommandLocale } from '@duya/command-catalog';
import type { HostSessionHttpClient } from '@duya/host/http-client';
import type { TuiChoice, TuiSettingsRow } from '../TUIApp.js';
import type { ActionDef } from '../actions.js';

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
  /**
   * Live settings list: Enter cycles a value in place and the effect lands
   * before the list closes. Resolves when the user leaves it.
   */
  openSettings?(options: {
    readonly title: string;
    readonly rows: readonly TuiSettingsRow[];
    readonly footer: string;
    readonly onActivate: (id: string) => readonly TuiSettingsRow[] | void;
  }): Promise<void>;
  /** Move the preferences the running TUI can move, and repaint. */
  applyTuiPreferences?(patch: {
    readonly effort?: string | null;
    readonly locale?: CommandLocale;
    /** `null` follows the environment — the `system` theme row. */
    readonly theme?: string | null;
    readonly showThinking?: boolean;
    readonly expandBlocks?: boolean;
    readonly showToolResults?: boolean;
    readonly completionRows?: number;
    readonly inputRows?: number;
  }): void;
  /** The live preferences, so a menu row can describe what is actually in force. */
  liveTuiPreferences?(): {
    readonly theme: string;
    readonly showThinking: boolean;
    readonly expandBlocks: boolean;
    readonly showToolResults: boolean;
    readonly completionRows: number;
    readonly inputRows: number;
  };
  /** The effective key bindings, so `/hotkeys` quotes what is really bound. */
  effectiveKeyBindings?(): readonly ActionDef[];
  /** Repaint now — used after a preference that the TUI itself does not hold. */
  refresh?(): void;
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
  /**
   * Re-read the durable transcript and repaint it.
   *
   * Not `adoptSession`: the session did not change, only its contents did
   * (`/compact` rewrote the timeline), so this says nothing about a
   * switch. The caller names the session it wants re-read.
   */
  reloadTranscript: (sessionId: string) => Promise<void>;
}

export type TuiSlashOutcome =
  | { readonly kind: 'handled' }
  /** The chat loop must adopt this session record (status line, next run). */
  | { readonly kind: 'session_updated'; readonly session: HostSessionRecord }
  /**
   * The chat loop must adopt this reasoning effort for subsequent runs.
   *
   * Effort is not part of the session record — the Host takes it per run — so it
   * cannot ride `session_updated`. `null` means "let the model decide", which is
   * also what the composer's neutral border means.
   */
  | { readonly kind: 'effort_changed'; readonly effort: string | null };

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
