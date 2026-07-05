import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBuiltinRegistry } from '../../../src/tool/builtin.js';
import { StreamingToolExecutor } from '../../../src/tool/StreamingToolExecutor.js';
import type { Message, ToolUseContext } from '../../../src/types.js';

describe('write/edit tool flow', () => {
  it('creates a file and then edits it through StreamingToolExecutor', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'duya-write-edit-flow-'));
    const filePath = 'nested/sample.txt';
    const absolutePath = join(tmp, filePath);
    const initialContent = 'alpha\nbeta\ngamma\n';
    const editedContent = 'alpha\nbeta edited\ngamma\n';

    try {
      const registry = createBuiltinRegistry();
      let appState: Record<string, unknown> = {
        toolPermissionContext: { mode: 'bypassPermissions' },
      };
      const context: ToolUseContext = {
        toolUseId: 'ctx-write-edit-flow',
        abortController: new AbortController(),
        getAppState: () => appState,
        setAppState: (updater) => {
          appState = typeof updater === 'function' ? updater(appState) : updater;
        },
        options: {
          tools: [],
          commands: [],
          mainLoopModel: 'test-model',
          mcpClients: [],
          workingDirectory: tmp,
        },
      };

      const canUseTool = async () => ({ allowed: true, behavior: 'allow' as const });
      const config = {
        progressIntervalMs: 10,
        maxExecutionTimeMs: 30_000,
        enableRetry: false,
        workerTools: [],
      };

      const writeExecutor = new StreamingToolExecutor(registry, canUseTool, context, config);
      writeExecutor.addTool({
        id: 'tool-write-flow',
        name: 'write',
        input: { file_path: filePath, content: initialContent },
      });
      const writeMessages: Message[] = [];
      for await (const update of writeExecutor.getRemainingResults()) {
        writeMessages.push(update.message);
      }

      expect(await readFile(absolutePath, 'utf-8')).toBe(initialContent);
      expect(writeMessages.some((message) => {
        return message.role === 'tool' && String(message.content).includes('Successfully wrote');
      })).toBe(true);

      const editExecutor = new StreamingToolExecutor(registry, canUseTool, context, config);
      editExecutor.addTool({
        id: 'tool-edit-flow',
        name: 'edit',
        input: { file_path: filePath, old_string: 'beta', new_string: 'beta edited' },
      });
      const editMessages: Message[] = [];
      for await (const update of editExecutor.getRemainingResults()) {
        editMessages.push(update.message);
      }

      expect(await readFile(absolutePath, 'utf-8')).toBe(editedContent);
      expect(editMessages.some((message) => {
        return message.role === 'tool' && String(message.content).includes('Successfully edited');
      })).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
