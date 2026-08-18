/**
 * Low-power mode resolution and propagation (plan 426 Phase 3).
 *
 * `performance.lowPower` in config.toml: 'auto' (default) | 'on' | 'off'.
 * - 'auto' detects low-spec hardware ONCE at startup
 *   (totalmem < 8GB || logical cores <= 4). No hot reload — the plan
 *   explicitly accepts staleness after hardware changes until restart.
 * - 'on' / 'off' are explicit overrides. Changing them updates main
 *   process services immediately; the agent server subprocess picks the
 *   new value up on its next restart (it reads DUYA_LOW_POWER at boot).
 *
 * Propagation:
 * - Main process services: call `isLowPowerEnabled()` (live value).
 * - Agent server + agent workers: inherit `DUYA_LOW_POWER` from
 *   process.env (agent-server-lifecycle.ts spreads process.env).
 * - Renderer: reads `performance.lowPower` via the config port and
 *   resolves 'auto' itself with the same hardware rule (see
 *   src/stores/low-power-store.ts).
 */
import * as os from 'os';
import { getLogger, LogComponent } from '../logging/logger';
import { getConfigStore } from '../config/store-instance';

const logger = getLogger();

const LOW_SPEC_TOTAL_MEM_BYTES = 8 * 1024 * 1024 * 1024;
const LOW_SPEC_CPU_CORES = 4;

/** Pure hardware check — exposed for renderer parity and tests. */
export function detectLowSpecHardware(): boolean {
  return os.totalmem() < LOW_SPEC_TOTAL_MEM_BYTES || os.cpus().length <= LOW_SPEC_CPU_CORES;
}

export type LowPowerMode = 'auto' | 'on' | 'off';

/** Resolve the configured mode to an effective enabled flag. */
export function resolveLowPower(mode: LowPowerMode | undefined): boolean {
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return detectLowSpecHardware();
}

let initialized = false;
let cachedEnabled = false;

function applyMode(mode: LowPowerMode | undefined, reason: string): void {
  const enabled = resolveLowPower(mode);
  if (enabled === cachedEnabled && initialized) return;
  cachedEnabled = enabled;
  if (enabled) process.env.DUYA_LOW_POWER = '1';
  else delete process.env.DUYA_LOW_POWER;
  logger.info(
    enabled ? 'Low-power mode enabled' : 'Low-power mode disabled',
    { mode: mode ?? 'auto', hardwareLowSpec: detectLowSpecHardware(), reason },
    LogComponent.ConfigManager,
  );
}

/**
 * Compute the effective low-power state once, subscribe to config
 * changes, and mirror the result into `process.env.DUYA_LOW_POWER` so
 * child processes (agent server, spawned workers) inherit it.
 *
 * Call early in app startup — before spawnAgentServer().
 */
export function initLowPower(): void {
  if (initialized) return;
  const store = getConfigStore();
  initialized = true;

  applyMode(store.getByPath('performance.lowPower') as LowPowerMode | undefined, 'startup');
  store.subscribe(() => {
    applyMode(
      getConfigStore().getByPath('performance.lowPower') as LowPowerMode | undefined,
      'config-change',
    );
  });
}

/** Live low-power state for main process services. */
export function isLowPowerEnabled(): boolean {
  if (!initialized) return detectLowSpecHardware();
  return cachedEnabled;
}
