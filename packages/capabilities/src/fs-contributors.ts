/**
 * Filesystem capability → tooling `ToolContributor` projection.
 *
 * This is the description half only: each FS tool is projected into the
 * `tools` slot of `@duya/tooling`'s ExtensionRegistry as an
 * `ExtensionToolDefinition` (name / description / JSON input schema). The
 * executor stays with the instance the host registers into its own
 * `ToolRegistry` — a contributor contributes a definition, the host owns
 * execution (see `contributors.ts` slot 2 in `@duya/tooling`).
 *
 * Instances constructed here are used ONLY to derive the schema via
 * `BaseTool.toTool()`; they are not the instances the runtime executes.
 */

import type { ToolContributor } from '@duya/tooling';

import { ReadTool } from './ReadTool/ReadTool.js';
import { WriteTool } from './WriteTool/WriteTool.js';
import { EditTool } from './EditTool/EditTool.js';
import { GlobTool } from './GlobTool/GlobTool.js';
import { GrepTool } from './GrepTool/GrepTool.js';
import { ApplyPatchTool } from './ApplyPatchTool/ApplyPatchTool.js';

/**
 * One `ToolContributor` per filesystem tool, in builtin registration order
 * (read → write → grep → edit → apply_patch → glob, mirroring
 * `packages/agent/src/tool/builtin.ts`).
 */
export function createFileSystemToolContributors(): ToolContributor[] {
  const tools = [
    new ReadTool(),
    new WriteTool(),
    new GrepTool(),
    new EditTool(),
    new ApplyPatchTool(),
    new GlobTool(),
  ];

  return tools.map((tool) => {
    const definition = tool.toTool();
    return {
      id: `capabilities.fs.${definition.name}`,
      capabilities: ['tools'],
      toolId: definition.name,
      definition: {
        name: definition.name,
        description: definition.description,
        inputSchema: definition.input_schema,
      },
    };
  });
}
