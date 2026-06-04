/**
 * packages/agent/src/cli/program/context.ts
 *
 * Context helpers shared between the descriptor-driven Commander
 * wiring (`build-program.ts`) and the agent tool bridge
 * (`build-agent-runner.ts`).
 */

import type { OutputFormat } from '../api/format.js';
import { parseFormat } from '../api/format.js';

export interface CliContext {
  format: OutputFormat;
  yes: boolean;
}

export function buildContext(opts: { format?: string; yes?: boolean }): CliContext {
  return {
    format: parseFormat(opts.format),
    yes: opts.yes === true,
  };
}
