/**
 * bot-change-notifier — broadcasts `config:bots:changed` to every renderer
 * window after a bot config/identity mutation (Plan 483 sidebar contract).
 *
 * Emission points: the config:agents:* mutation handlers (db-handlers.ts —
 * create / update / delete / updateBotProfile / avatar upload+clear) and the
 * bot-identity:rpc success paths (bot-identity-rpc.ts — a bot editing its
 * own name/avatar through update_state). The sidebar's useBotContacts hook
 * subscribes via the preload `configAgents.onBotsChanged` bridge and
 * re-runs listBots on each broadcast.
 *
 * Electron is resolved lazily at call time: unit tests import the callers
 * in a plain node environment where `require('electron')` resolves to the
 * installer stub — the guard degrades to a no-op instead of crashing.
 */

const BOTS_CHANGED_CHANNEL = 'config:bots:changed';

export function notifyBotsChanged(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as typeof import('electron');
    const getAllWindows = electron?.BrowserWindow?.getAllWindows?.bind(electron.BrowserWindow);
    if (typeof getAllWindows !== 'function') return;
    for (const win of getAllWindows()) {
      if (win && !win.isDestroyed()) {
        win.webContents.send(BOTS_CHANGED_CHANNEL);
      }
    }
  } catch {
    // Not running inside electron main (unit tests) — nothing to notify.
  }
}
