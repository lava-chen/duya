/**
 * bridge-assembly.ts — the worker db bridge's Bot service handle (S1).
 *
 * The bridge dispatches per action and has no async lifecycle of its own, so
 * the service is assembled once per bridge instance and the journal repair
 * runs on FIRST DISPATCH — the dispatch path is async, which constructor
 * repair cannot be. A pending intent is therefore rolled forward by the
 * first bot command after a crash, which is exactly the "next writer
 * completes what the last writer started" contract; a read-only Host that
 * never dispatches a bot action has nothing to roll forward.
 *
 * The legacy `config:agents:*` actions and the new `bot:*` actions share ONE
 * service instance: two service instances over the same `config.toml` would
 * be two writers again.
 */

import { openHostBotService, type BotService, type BotServicePorts } from './service.js';
import type { RunControlPlaneLogger } from '../run-control-plane.js';

export interface BotBridgeAssemblyOptions {
  configRoot?: string | undefined;
  logger?: RunControlPlaneLogger | undefined;
}

/** Adapt the bridge logger to the service's narrow warn/info surface. */
function serviceLogger(logger: RunControlPlaneLogger | undefined): BotServicePorts['logger'] {
  if (!logger) return undefined;
  return {
    warn: (message, context) => logger.warn?.(message, context),
    info: (message, context) => logger.info?.(message, context),
  };
}

export function createHostWorkerBotService(options: BotBridgeAssemblyOptions) {
  let servicePromise: Promise<BotService> | null = null;

  return {
    /** Assembled once; the first call runs the journal repair. */
    service(): Promise<BotService> {
      if (servicePromise === null) {
        const root = options.configRoot; // string | undefined — the service resolves the default
        servicePromise = openHostBotService(root, serviceLogger(options.logger));
      }
      return servicePromise;
    },
  };
}
