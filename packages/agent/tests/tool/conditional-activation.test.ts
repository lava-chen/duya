/**
 * Conditional-skill activation wiring through ToolRegistry.execute.
 *
 * Contract:
 *  - Pending conditional skills are withheld from listModelInvocable()
 *    (and therefore from the <available_skills> catalog) until a tool
 *    execution touches a matching file path.
 *  - A successful tool call whose input carries file_path / notebook_path /
 *    path feeds those paths to activateConditionalSkills.
 *  - On activation, the result gains a pendingContext transient note so the
 *    model learns the skill is now available on the next provider turn.
 *  - Failed tool calls and tools without path-bearing inputs never trigger
 *    activation; an existing pendingContext is never overwritten.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '../../src/tool/registry.js';
import type { ToolExecutor } from '../../src/tool/registry.js';
import type { ToolResult, ToolUseContext } from '../../src/types.js';
import type { PromptSkill } from '../../src/skills/types.js';
import {
  getSkillRegistry,
  resetSkillRegistry,
} from '../../src/skills/registry.js';
import {
  clearConditionalSkills,
  registerConditionalSkill,
} from '../../src/skills/conditionalSkills.js';

function makeConditionalSkill(name: string, paths: string[]): PromptSkill {
  return {
    type: 'prompt',
    name,
    description: `${name} description`,
    source: 'user',
    paths,
    async getPromptForCommand() {
      return 'instructions';
    },
  };
}

/** Mirror loader.ts registration for path-gated skills. */
function registerPending(skill: PromptSkill): PromptSkill {
  registerConditionalSkill(skill);
  getSkillRegistry().register(skill);
  return skill;
}

function noopExecutor(result?: Partial<ToolResult>): ToolExecutor {
  return {
    async execute(): Promise<ToolResult> {
      return {
        id: 'test-id',
        name: 'Test',
        result: 'ok',
        ...result,
      };
    },
  };
}

const context = (): ToolUseContext =>
  ({
    toolUseId: 'ctx',
    abortController: new AbortController(),
    getAppState: () => ({}),
    setAppState: () => {},
    options: { tools: [], commands: [], mainLoopModel: '', mcpClients: [] },
  }) as unknown as ToolUseContext;

describe('ToolRegistry conditional-skill activation', () => {
  let workDir: string;

  beforeEach(() => {
    resetSkillRegistry();
    clearConditionalSkills();
    workDir = mkdtempSync(join(tmpdir(), 'duya-cond-'));
  });

  afterEach(() => {
    resetSkillRegistry();
    clearConditionalSkills();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('withholds pending conditional skills from listModelInvocable', () => {
    const registry = getSkillRegistry();
    const conditional = makeConditionalSkill('docker-deploy', ['Dockerfile*']);
    conditional.isConditional = true;
    const normal = makeConditionalSkill('plain', []);
    delete normal.paths;
    registry.register(conditional);
    registry.register(normal);

    const names = registry.listModelInvocable().map((s) => s.name);
    expect(names).not.toContain('docker-deploy');
    expect(names).toContain('plain');
  });

  it('activates a conditional skill when a tool touches a matching file', async () => {
    const dockerfile = join(workDir, 'Dockerfile');
    writeFileSync(dockerfile, 'FROM node\n');

    const skill = registerPending(makeConditionalSkill('docker-deploy', ['Dockerfile*']));

    const registry = new ToolRegistry();
    registry.register(
      { name: 'Read', description: '', input_schema: {} },
      noopExecutor(),
    );

    const result = await registry.execute(
      'Read',
      { file_path: dockerfile },
      workDir,
      context(),
    );

    expect(result).not.toBeNull();
    expect(skill.isConditional).toBe(false);
    expect(await result!.pendingContext).toContain('docker-deploy');
    expect(getSkillRegistry().listModelInvocable().map((s) => s.name))
      .toContain('docker-deploy');
  });

  it('resolves relative file_path inputs against the working directory', async () => {
    writeFileSync(join(workDir, 'Dockerfile'), 'FROM node\n');

    const skill = registerPending(makeConditionalSkill('docker-deploy', ['Dockerfile*']));

    const registry = new ToolRegistry();
    registry.register(
      { name: 'Read', description: '', input_schema: {} },
      noopExecutor(),
    );

    await registry.execute('Read', { file_path: './Dockerfile' }, workDir, context());

    expect(skill.isConditional).toBe(false);
  });

  it('does not activate on failed tool results', async () => {
    const skill = makeConditionalSkill('docker-deploy', ['Dockerfile*']);
    skill.isConditional = true;
    getSkillRegistry().register(skill);

    const registry = new ToolRegistry();
    registry.register(
      { name: 'Read', description: '', input_schema: {} },
      noopExecutor({ error: true }),
    );

    await registry.execute(
      'Read',
      { file_path: join(workDir, 'Dockerfile') },
      workDir,
      context(),
    );

    expect(skill.isConditional).toBe(true);
  });

  it('does not activate when the input has no path-bearing keys', async () => {
    const skill = makeConditionalSkill('docker-deploy', ['Dockerfile*']);
    skill.isConditional = true;
    getSkillRegistry().register(skill);

    const registry = new ToolRegistry();
    registry.register(
      { name: 'Bash', description: '', input_schema: {} },
      noopExecutor(),
    );

    await registry.execute('Bash', { command: 'echo hi' }, workDir, context());

    expect(skill.isConditional).toBe(true);
  });

  it('does not overwrite an executor-provided pendingContext', async () => {
    writeFileSync(join(workDir, 'Dockerfile'), 'FROM node\n');

    const skill = registerPending(makeConditionalSkill('docker-deploy', ['Dockerfile*']));

    const ownContext = Promise.resolve('executor context');
    const registry = new ToolRegistry();
    registry.register(
      { name: 'Read', description: '', input_schema: {} },
      noopExecutor({ pendingContext: ownContext }),
    );

    const result = await registry.execute(
      'Read',
      { file_path: join(workDir, 'Dockerfile') },
      workDir,
      context(),
    );

    expect(result!.pendingContext).toBe(ownContext);
    // Activation still happened even though the note was not attached.
    expect(skill.isConditional).toBe(false);
  });
});
