/**
 * System location registry — bridge between init message and prompt builder.
 *
 * The main process sends the user's authoritative locale/timezone as part of
 * the `init` IPC. The agent subprocess stores it here at startup, and the
 * PromptManager reads it when assembling the system prompt. The value is
 * session-stable, so we keep it as a single mutable module variable.
 */

export interface SystemLocation {
  locale: string;
  localeCountryCode: string | null;
  timezone: string;
}

let current: SystemLocation | null = null;

export function setSystemLocation(value: SystemLocation | null): void {
  current = value;
}

export function getSystemLocation(): SystemLocation | null {
  return current;
}
