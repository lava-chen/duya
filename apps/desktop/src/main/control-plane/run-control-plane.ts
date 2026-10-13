import type { ControlPlaneRequest } from '@duya/host/control-plane-service';
import type { HostRunApiV1 } from '@duya/agent-protocol';
import { getDesktopHostRunApi } from '../cli/desktop-host-api';
import { getLogger, LogComponent } from '../logging/logger';
import { createDesktopHostRunApiAdapter } from './host-run-api-adapter';

export type { ControlPlaneRequest } from '@duya/host/control-plane-service';

/**
 * Test seam for the same reason `ControlPlaneService` carries
 * `_resetControlPlaneForTesting`: the measurement files (`h8-2`,
 * `run-create-ack-real-bridge`) exercise the REAL dispatch chain against a
 * REAL SQLite RunStore without a running Host process. Production always
 * falls through to `getDesktopHostRunApi`.
 */
let runApiForTesting: HostRunApiV1 | null = null;

export function __setDesktopHostRunApiForTesting(api: HostRunApiV1 | null): void {
  runApiForTesting = api;
}

function createRequest(): ControlPlaneRequest {
  return createDesktopHostRunApiAdapter(runApiForTesting ?? getDesktopHostRunApi());
}

async function dispatch(action: string, payload: Record<string, unknown>): Promise<unknown | undefined> {
  try {
    return await createRequest()(action, payload);
  } catch (error) {
    getLogger().error(
      'Control Plane Host Run API request failed',
      error instanceof Error ? error : new Error(String(error)),
      { action },
      LogComponent.DB,
    );
    throw error;
  }
}

export async function createRun(payload: Record<string, unknown>): Promise<unknown> {
  return dispatch('run:create', payload);
}

export async function appendRunEvents(payload: Record<string, unknown>): Promise<unknown> {
  return dispatch('run:append', payload);
}

export async function completeRun(payload: Record<string, unknown>): Promise<unknown> {
  return dispatch('run:complete', payload);
}

export async function getRun(payload: Record<string, unknown>): Promise<unknown> {
  return dispatch('run:get', payload);
}

export async function getRunEvents(payload: Record<string, unknown>): Promise<unknown> {
  return dispatch('run:events', payload);
}

export async function listSessionRuns(payload: Record<string, unknown>): Promise<unknown> {
  return dispatch('run:list-session', payload);
}

export async function dispatchControlPlaneAction(
  action: string,
  payload: Record<string, unknown>,
): Promise<unknown | undefined> {
  return dispatch(action, payload);
}
