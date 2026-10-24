/**
 * Host catalog assembly with filesystem-backed conditional skill activation.
 *
 * Catalog storage, replace-set semantics, snapshots, and tool dispatch now
 * live in @duya/agent-runtime. This file keeps the legacy Agent import path
 * working while wiring the existing conditional-skill side effect.
 */
import { ToolRegistry as RuntimeToolRegistry } from '@duya/agent-runtime/tools/catalog';
import type { ToolExecutor as RuntimeToolExecutor } from '@duya/agent-runtime/tools/catalog';
import type { RiskTier } from '@duya/agent-runtime/authorization/permissions/policy';
import { activateConditionalSkills, getPendingConditionalSkillCount } from './skills/conditionalSkills.js';
import type { Tool, ToolResult, ToolUseContext } from './worker-run-contracts.js';
import { checkCheckoutToolWrite } from './workspace/tool-write-gate.js';

export type { ToolExposure } from '@duya/agent-runtime/tools/catalog/catalog-types';
export type {
  ReplaceableOwner,
  ToolHintMeta,
  ToolMeta,
  ToolMetaInput,
  ToolOwner,
  ToolRegistryOptions,
} from '@duya/agent-runtime/tools/catalog';
export { MCPRegistryReplaceError } from '@duya/agent-runtime/tools/catalog';

export interface ToolExecutor extends RuntimeToolExecutor<ToolUseContext, ToolResult> {}

const conditionalSkillEffects = {
  getPendingCount: getPendingConditionalSkillCount,
  activate: (filePaths: readonly string[], workingDirectory?: string) =>
    activateConditionalSkills([...filePaths], workingDirectory),
};

export class ToolRegistry extends RuntimeToolRegistry<Tool, ToolResult, ToolUseContext, ToolExecutor> {
  constructor() {
    super({ conditionalSkillEffects });
  }

  override async execute(
    name: string,
    input: Record<string, unknown>,
    workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult | null> {
    const denial = await checkCheckoutToolWrite({ toolName: name, input, workingDirectory, sessionId: context?.options.sessionId });
    if (denial) {
      return {
        id: crypto.randomUUID(), name, error: true, result: denial.message,
        metadata: { errorCode: denial.code, reason: denial.reason },
      };
    }
    return super.execute(name, input, workingDirectory, context);
  }
}

export default ToolRegistry;
