/**
 * electron/services/terminal/index.ts
 *
 * Public surface of the terminal service.
 */

export {
  getTerminalManager,
  newTerminalId,
  TerminalManager,
} from './TerminalManager';
export type {
  TerminalShell,
  TerminalHandle,
  TerminalSpawnOptions,
  TerminalOutputEvent,
  TerminalExitEvent,
  TerminalSnapshot,
  TerminalSuggestion,
  TerminalEvent,
  TerminalEventListener,
} from './TerminalManager';
