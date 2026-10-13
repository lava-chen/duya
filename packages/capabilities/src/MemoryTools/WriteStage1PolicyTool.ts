import * as path from 'node:path';
import { BaseTool } from '../BaseTool.js';
import type { ToolResult } from '../contracts/tool.js';
import type { MemoryToolFilePort } from './ports.js';

/**
 * Rewrites the Stage 1 extractor policy and increments its version sidecar.
 * Only the editable policy file is touched; the hard contract remains in code.
 */
export class WriteStage1PolicyTool extends BaseTool {
  readonly name = 'write_stage1_policy';
  readonly description =
    'Rewrite the Stage 1 extractor policy file (stage1_policy.md) under the memory-config/ directory and bump its .version sidecar. Input `content` is the new policy text. The policy must NOT contradict the immutable hard contract (JSON-only output, 12 claim types, canonical_key rules).';
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'New policy Markdown content.' },
    },
    required: ['content'],
  };

  constructor(private readonly files: MemoryToolFilePort) {
    super();
  }

  async execute(input: Record<string, unknown>, workingDirectory?: string): Promise<ToolResult> {
    const id = crypto.randomUUID();
    const content = String(input.content ?? '');

    if (!workingDirectory) {
      return { id, name: this.name, result: 'No working directory available.', error: true };
    }

    const dir = path.join(workingDirectory, 'memory-config');
    const policyPath = path.join(dir, 'stage1_policy.md');
    const versionPath = `${policyPath}.version`;

    try {
      await this.files.ensureDirectory(dir);
      const versionText = await this.files.readTextFileIfExists(versionPath);
      let version = 0;
      if (versionText !== undefined) {
        const parsed = parseInt(versionText.trim(), 10);
        if (Number.isFinite(parsed) && parsed >= 0) version = parsed;
      }
      await this.files.writeTextFile(policyPath, content);
      await this.files.writeTextFile(versionPath, String(version + 1));
    } catch (error) {
      return {
        id,
        name: this.name,
        result: `Write failed: ${error instanceof Error ? error.message : String(error)}`,
        error: true,
      };
    }

    return { id, name: this.name, result: 'Wrote stage1_policy.md and bumped version' };
  }
}
