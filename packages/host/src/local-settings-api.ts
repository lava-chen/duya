import type { HostLocalSettingsApiV1 } from '@duya/agent-protocol/session-api';
import type { MainSettingsStore } from '@duya/data/main-settings-store';

/** Keep potentially sensitive settings on the authenticated local Host surface. */
export function createHostLocalSettingsApi(
  settings: Pick<MainSettingsStore, 'getString' | 'getAllStrings' | 'setString'>,
): HostLocalSettingsApiV1 {
  return {
    async getSetting(key) {
      return settings.getString(key);
    },
    async getSettings() {
      return settings.getAllStrings();
    },
    async setSetting(key, value) {
      settings.setString(key, value);
    },
  };
}
