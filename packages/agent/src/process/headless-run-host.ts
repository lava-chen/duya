/**
 * Compatibility facade for the Host-owned headless run adapter.
 *
 * Legacy callers still pass the already-created agent. New Host compositions
 * use the required `createSession` factory directly.
 */

import type { duyaAgent } from '../agent/DuyaAgent.js';
import {
  HeadlessRunHost as HostHeadlessRunHost,
  createHeadlessExecutionChannel,
  createHeadlessRunHost as createHostHeadlessRunHost,
  type HeadlessEngineWiring as HostHeadlessEngineWiring,
  type HeadlessFinalMessage as HostHeadlessFinalMessage,
  type HeadlessRun as HostHeadlessRun,
  type HeadlessRunHostOptions as HostHeadlessRunHostOptions,
  type HeadlessRunIntent as HostHeadlessRunIntent,
} from '@duya/host/worker-headless-run-host';

export type HeadlessAgent = duyaAgent;
export type HeadlessRunSession = import('@duya/host/worker-headless-run-host').HeadlessRunSession;
export type HeadlessEngineWiring = HostHeadlessEngineWiring;
export type HeadlessFinalMessage = HostHeadlessFinalMessage;
export type HeadlessRun = HostHeadlessRun;
export type HeadlessRunIntent = HostHeadlessRunIntent;

export type HeadlessRunHostOptions = Omit<HostHeadlessRunHostOptions, 'createSession'> & {
  readonly agent: HeadlessAgent;
};

/** Legacy class surface retained while CLI composition moves to Host. */
export class HeadlessRunHost extends HostHeadlessRunHost {
  readonly #legacyAgent: HeadlessAgent;

  constructor(options: HeadlessRunHostOptions) {
    const { agent, ...hostOptions } = options;
    super({ ...hostOptions, createSession: () => agent });
    this.#legacyAgent = agent;
  }

  get agent(): HeadlessAgent {
    return this.#legacyAgent;
  }

  override probe() {
    return super.probe();
  }

  override start(intent: HostHeadlessRunIntent) {
    return super.start(intent);
  }
}

/** Preserve the old channel factory name and parameter shape for Agent callers. */
export function createAgentExecutionChannel(
  agent: HeadlessAgent,
  wiring?: HeadlessEngineWiring,
) {
  return createHeadlessExecutionChannel(agent, wiring);
}

export { createHeadlessExecutionChannel, HostHeadlessRunHost as HostOwnedHeadlessRunHost };
export { buildHeadlessManifest } from '@duya/host/worker-headless-run-host';

export function createHeadlessRunHost(options: HeadlessRunHostOptions): HeadlessRunHost {
  return new HeadlessRunHost(options);
}
