import * as fs from 'node:fs';
import * as path from 'node:path';
import { BaseTool } from '../BaseTool.js';
import type { ToolResult } from '../../types.js';

/**
 * WriteStage1PolicyTool — rewrites the Stage 1 extractor policy file
 * (`stage1_policy.md`) and monotonically increments its `.version` sidecar
 * (Plan 405 two-layer contract). Only the agent-editable policy layer is
 * touched; STAGE1_HARD_CONTRACT stays immutable in code.
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

  async execute(input: Record<string, unknown>, workingDirectory?: string): Promise<ToolResult> {
    const id = crypto.randomUUID();
    const content = String(input.content ?? '');

    if (!workingDirectory) {
      return { id, name: this.name, result: 'No working directory available.', error: true };
    }

    // Policy lives under memory-config/ relative to the memory root.
    const dir = path.join(workingDirectory, 'memory-config');
    const policyPath = path.join(dir, 'stage1_policy.md');
    const versionPath = `${policyPath}.version`;

    try {
      fs.mkdirSync(dir, { recursive: true });
      let version = 0;
      if (fs.existsSync(versionPath)) {
        const parsed = parseInt(fs.readFileSync(versionPath, 'utf8').trim(), 10);
        if (Number.isFinite(parsed) && parsed >= 0) version = parsed;
      }
      fs.writeFileSync(policyPath, content, 'utf8');
      fs.writeFileSync(versionPath, String(version + 1), 'utf8');
    } catch (e) {
      return { id, name: this.name, result: `Write failed: ${(e as Error).message}`, error: true };
    }

    return { id, name: this.name, result: 'Wrote stage1_policy.md and bumped version' };
  }
}
