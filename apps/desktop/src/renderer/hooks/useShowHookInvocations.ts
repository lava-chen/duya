// Plan 437: small selector hook for the Settings \u2192 Hooks toggle that
// controls whether hook rows render in the chat flow. Keeps the
// streaming / reload paths honest: when the user opts out, both fresh
// rounds and reloaded history drop the rows.

import { useSettings } from './useSettings';

/**
 * True when hook rows should be rendered. Reads `showHookInvocations`
 * from the settings store; defaults to true when the setting is absent
 * (older sessions).
 */
export function useShowHookInvocations(): boolean {
  const { settings } = useSettings();
  return settings.showHookInvocations !== false;
}