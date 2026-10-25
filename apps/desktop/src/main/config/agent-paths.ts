/**
 * agent-paths.ts — Bot storage path derivation.
 *
 * The path rules live in `@duya/host/config-agents`: the directory layout
 * (`<duyaRoot>/agents/<id>/…`) is shared by the Desktop config store and the
 * standalone Host, and no module may join agent paths by hand.
 *
 * Layout:
 *   <duyaRoot>/agents/<agentId>/profile.json   — runtime identity source
 *   <duyaRoot>/agents/<agentId>/settings.json  — mutable settings (host)
 *   <duyaRoot>/agents/<agentId>/state/         — reserved
 *   <duyaRoot>/agents/<agentId>/memory/        — reserved
 */

import { getDuyaAgentsRoot } from '@duya/host/config-agents';
import { getConfigStore } from './store-instance.js';

export {
  getBotDeletedAgentDir,
  getBotDeletedDir,
  getBotMemoryDir,
  getBotProfilePath,
  getBotSessionsDir,
  getBotSessionLogPath,
  getBotSettingsPath,
  getBotStateDir,
  getDuyaAgentsRoot,
  resolveDuyaAgentDir,
} from '@duya/host/config-agents';

/**
 * `~/.duya/agents` resolved through the ConfigStore singleton, so dev and
 * packaged installs share one tree and tests that inject a temp store via
 * `_setConfigStoreForTest` get an isolated one automatically (plan 526).
 */
export function getSharedAgentsRoot(): string {
  return getDuyaAgentsRoot(getConfigStore().getConfigDir());
}
