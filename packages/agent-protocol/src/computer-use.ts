/**
 * Transport-neutral Computer Use tool and IPC contracts.
 *
 * Keep these values free of executor, Electron, and OS dependencies so the
 * Agent worker and Desktop Main share one wire definition.
 */

export const COMPUTER_USE_TOOL_NAME = 'computer_use';

export const COMPUTER_USE_ACTIONS = [
  'capture',
  'click',
  'type',
  'key',
  'scroll',
  'drag',
  'set_value',
  'wait',
  'zoom',
  'tree',
  'invoke',
] as const;

export const COMPUTER_USE_ACTION_LIST: readonly string[] = COMPUTER_USE_ACTIONS;

export type ComputerUseAction = (typeof COMPUTER_USE_ACTIONS)[number];

export const COMPUTER_USE_CONTEXT_TOOL_NAME = 'computer_use_context';

export const COMPUTER_USE_CONTEXT_ACTIONS = ['list_apps', 'focus_app'] as const;

export type ComputerUseContextAction = (typeof COMPUTER_USE_CONTEXT_ACTIONS)[number];

export const COMPUTER_USE_DECIDE_TOOL_NAME = 'computer_use_decide';

export type ComputerUseExecuteAction = ComputerUseAction | ComputerUseContextAction;

export const COMPUTER_USE_IPC_CHANNEL = 'computer-use:execute';

export const COMPUTER_USE_APPROVAL_CHANNEL = 'computer-use:approval';

export const ComputerUseErrorCode = {
  SCHEMA_INVALID: 'SCHEMA_INVALID',
  NO_IPC: 'NO_IPC',
  IPC_EXCEPTION: 'IPC_EXCEPTION',
  BACKEND_UNAVAILABLE: 'BACKEND_UNAVAILABLE',
  TIMEOUT: 'TIMEOUT',
  USER_REJECTED: 'USER_REJECTED',
  APPROVAL_TIMEOUT: 'APPROVAL_TIMEOUT',
  REDACTED_FIELD: 'REDACTED_FIELD',
  BLOCKED: 'BLOCKED',
  APP_BLOCKED: 'APP_BLOCKED',
  STRUCTURAL_UNAVAILABLE: 'STRUCTURAL_UNAVAILABLE',
  UNKNOWN: 'UNKNOWN',
} as const;

export type ComputerUseErrorCode =
  (typeof ComputerUseErrorCode)[keyof typeof ComputerUseErrorCode];

/** Read-back returned for state-changing actions. */
export interface ComputerUseActionResult {
  ok: boolean;
  reason?: string;
  durationMs?: number;
  verdict?: {
    effect: 'confirmed' | 'unverifiable' | 'suspected_noop';
    verified: { elementChanged: boolean; newFocusedEntity: unknown | null };
    escalation?: { recommended: 're-capture' | 'raise' | 'foreground'; reason: string };
    readbackMs?: number;
    fallbackUsed?: boolean;
  };
}

/** Result envelope returned by the computer-use:execute IPC channel. */
export interface ComputerUseToolEnvelope<T = unknown> {
  success: boolean;
  action: ComputerUseExecuteAction;
  data?: T;
  error?: { code: ComputerUseErrorCode; message: string };
}
