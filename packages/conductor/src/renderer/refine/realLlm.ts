/**
 * Real LLM call for the conductor refine loop.
 *
 * Routes through the host-supplied `ConductorAgent.callRefine`
 * (see `@duya/conductor/renderer/host`). The host owns the
 * transport (Agent Server HTTP+SSE); the renderer package only
 * needs the typed callback. If the host has not been mounted,
 * we surface a clear error so the panel can show it to the
 * user instead of silently no-oping.
 *
 * The exported function preserves the old `(args) => Promise<…>`
 * signature so `RefinePanel` does not have to be changed in
 * this phase. The `widgetId` field in `RealLlmArgs` is used
 * only to compose the session id; everything else passes
 * through.
 */

import { getConductorHostOrNull } from "..//host";
import type { RefineLlmResponse } from "./types";

export interface RealLlmArgs {
  userRequest: string;
  widgetType: string;
  currentData: Record<string, unknown>;
  iteration: number;
  maxIterations: number;
  screenshotBase64: string;
  widgetId: string;
}

export interface RealRefineResponse {
  done: boolean;
  rationale: string;
  data: Record<string, unknown>;
  warnings: string[];
}

export async function realRefineLlm(args: RealLlmArgs): Promise<RealRefineResponse> {
  const host = getConductorHostOrNull();
  if (!host) {
    throw new Error(
      "ConductorHost is not mounted. Wrap the conductor tree in <ConductorHostProvider> (see src/conductor-host-provider.tsx).",
    );
  }

  const sessionId = `refine-${args.widgetId}-${Date.now()}`;
  const response: RefineLlmResponse = await host.agent.callRefine({
    sessionId,
    userRequest: args.userRequest,
    widgetType: args.widgetType,
    currentData: args.currentData,
    iteration: args.iteration,
    maxIterations: args.maxIterations,
    screenshotBase64: args.screenshotBase64,
  });

  return {
    done: response.done,
    rationale: response.rationale.slice(0, 500),
    data: response.data,
    warnings: response.warnings,
  };
}
