/** Compatibility adapter binding Agent context and registry effects. */

import {
  ToolExecutionPipeline as RuntimeToolExecutionPipeline,
  type CanUseToolFn,
  type ExecutorConfig,
  type IToolExecutionPipeline as RuntimePipelineContract,
  type MessageUpdate,
  type PathCanonicaliser,
  type ProgressCallback,
  type ToolCompleteCallback,
  type ToolErrorCallback,
  type ToolStartCallback,
  type DependencyResolver,
  type PathExtractorResolver,
} from '@duya/agent-runtime/tools/execution';
import type { ToolUse, ToolUseContext } from '@duya/host/worker-run-contracts';
import type { ToolRegistry } from '@duya/host/worker-tool-registry';
import {
  adaptAgentToolRegistry,
  createAgentToolExecutionPorts,
} from './streaming-tool-executor.js';

export type {
  CanUseToolFn,
  ExecutorConfig,
  MessageUpdate,
  ProgressCallback,
  ToolCompleteCallback,
  ToolErrorCallback,
  ToolStartCallback,
  DependencyResolver,
  PathExtractorResolver,
  PathCanonicaliser,
};

export interface IToolExecutionPipeline extends RuntimePipelineContract<ToolUseContext> {
  addTool(block: ToolUse): void;
}

export class ToolExecutionPipeline
  extends RuntimeToolExecutionPipeline<ToolUseContext>
  implements IToolExecutionPipeline {
  constructor(
    toolRegistry: ToolRegistry,
    canUseTool: CanUseToolFn,
    toolUseContext: ToolUseContext,
    config?: ExecutorConfig,
    options?: {
      dependencyResolver?: DependencyResolver;
      extractWritePaths?: PathExtractorResolver;
      extractReadPaths?: PathExtractorResolver;
      canonicaliser?: PathCanonicaliser;
    },
  ) {
    super(
      adaptAgentToolRegistry(toolRegistry),
      canUseTool,
      toolUseContext,
      config,
      createAgentToolExecutionPorts(toolUseContext, config),
      options,
    );
  }
}
