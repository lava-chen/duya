/**
 * Command App Bridge
 *
 * The single interface between slash-command executors (pure-ish functions in
 * `executors/`) and the live desktop app. Executors never import React
 * components or reach into composer state directly — everything they can do
 * to the app goes through this bridge.
 *
 * The bridge is a module-level singleton registered by MessageInput (the
 * composer owns the props that back most of these actions). `null` when no
 * composer is mounted (e.g. unit tests) — `runSlashCommand` then refuses to
 * execute and returns an error result instead of throwing.
 *
 * ## Adding a capability
 *
 * 1. Add the method here with a doc comment.
 * 2. Implement it in MessageInput's bridge registration (`useEffect` near the
 *    bottom of the component) from existing props/handlers.
 * 3. Executors call `ctx.app.<method>()`.
 */

import type { ModeModifierId } from '@/types/mode-id';

/** Panels a slash command can open. Keep in sync with PanelZone/PAGE_REGISTRY. */
export type SlashCommandPanel =
  | 'code-review'
  | 'mcp'
  | 'memory'
  | 'automation'
  | 'sessions'
  | 'settings-providers'
  | 'settings'
  | 'skills';

export interface CommandAppBridge {
  // — Session —
  /** Forward a prompt to the agent (same path as pressing Enter). */
  sendPrompt(prompt: string): Promise<void> | void;
  /**
   * Snapshot of composer-visible session state, for info-style commands
   * (/status /cost /context /effort /permission ...) that need to display
   * the current value. Reads only — no store subscription, so executors
   * stay plain functions.
   */
  getSessionSnapshot(): {
    sessionId?: string;
    model?: string;
    effort?: string;
    permissionMode?: 'ask' | 'auto' | 'bypass';
    workingDirectory?: string | null;
    messageCount?: number;
    /**
     * A turn is currently streaming.
     *
     * The catalog's `availableWhileBusy` is a declaration; this is the fact it
     * is checked against. Without it a desktop command that mutates the
     * conversation would run mid-turn, while the same command in the CLI TUI
     * refuses with "press Esc first" — the same command, two different
     * answers, decided by which surface the user happened to be in.
     */
    isStreaming?: boolean;
  };
  /** Clear the current conversation (desktop semantic decided by the executor). */
  clearMessages(): void;
  /** Start a fresh session; resolves with old/new session ids. */
  resetSession(): Promise<{ oldSessionId: string; newSessionId: string }>;
  /** Interrupt the live turn (Esc equivalent). */
  stopTurn(): void;
  /**
   * Bring a session to the foreground of the desktop app: make it the active
   * thread and put the view back on the chat.
   *
   * The Desktop IS the desktop app, so there is nothing for `/app` to hand the
   * session to — this is the "re-open the session I am already in" gesture.
   * The implementation lives in the composer because switching sessions is the
   * store's `setActiveThread`, and the store is what actually moves the app.
   */
  focusSession(sessionId: string): void;
  /** Manually compact the current session's context (worker compaction). */
  compactContext(): void;
  /** Generate a conversation recap (same as the /recap popover action). */
  requestRecap(): Promise<{ success: boolean; recap: string | null; error?: string }>;

  // — Config —
  /** Switch the session model (pure model name; provider optional). */
  setSessionModel(model: string, providerId?: string): void;
  /** Set reasoning effort for the session (undefined = default). */
  setEffort(effort: string | undefined): void;
  /** Switch the permission mode (ask / auto / bypass). */
  setPermissionMode(mode: 'ask' | 'auto' | 'bypass'): void;
  /** Toggle a session/message mode (plan-task, research, goal). */
  toggleMode(mode: ModeModifierId): void;
  /** Open the composer's model/provider picker. */
  openModelPicker(): void;

  // — Panels —
  /** Open a side panel by id (window event based; no-op if not registered). */
  openPanel(panel: SlashCommandPanel): void;

  // — Dialogs & feedback —
  /** Prompt the user for a single line of text; null when cancelled. */
  promptInput(options: { title: string; placeholder?: string; initialValue?: string }): Promise<string | null>;
  /** Transient feedback (success/info/error). */
  toast(message: string, kind?: 'info' | 'success' | 'error'): void;
}

let activeBridge: CommandAppBridge | null = null;

export function setCommandAppBridge(next: CommandAppBridge | null): void {
  activeBridge = next;
}

export function getCommandAppBridge(): CommandAppBridge | null {
  return activeBridge;
}
