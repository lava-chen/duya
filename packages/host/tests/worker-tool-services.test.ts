import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GetTaskOutputTool, KillTaskTool } from '@duya/capabilities/background-task-tool';
import { SkillTool } from '@duya/capabilities/skill-tool';
import { EnterPlanModeTool, ExitPlanModeTool, SwitchModeTool } from '@duya/capabilities/mode-tools';
import { BashTaskRegistry } from '../src/managed-shell/task-registry.js';
import { BackgroundAgentLifecycle } from '../src/worker-subagents/background-lifecycle.js';
import { getSkillRegistry, resetSkillRegistry } from '../src/skills/registry.js';
import type { PromptSkill } from '../src/skills/types.js';
import { createWorkerBackgroundTaskPort, type WorkerBackgroundTaskSources } from '../src/worker-tool-services/background-task.js';
import { createWorkerModeSwitchService, type WorkerModeSwitchDependencies } from '../src/worker-tool-services/mode-switch.js';
import { createWorkerSkillToolPort } from '../src/worker-tool-services/skill.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'duya-worker-tool-services-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  resetSkillRegistry();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Host worker tool-service bindings', () => {
  it('routes task snapshots and kills to the Host-owned agent and managed-shell registries', async () => {
    const outputDir = makeTempDir();
    const outputFile = join(outputDir, 'shell.log');
    writeFileSync(outputFile, 'shell output line\n');
    const lifecycle = new BackgroundAgentLifecycle();
    const shellRegistry = new BashTaskRegistry({
      store: {
        persist: async () => {},
        rehydrate: async () => [],
      },
    });
    shellRegistry.register({
      id: 'shell-1',
      pid: 999_999,
      outputFile,
      command: 'npm run build',
      status: 'running',
      startTime: Date.now(),
    });
    const stopTask = vi.spyOn(shellRegistry, 'stopTask').mockResolvedValue({
      success: true,
      message: 'Task shell-1 stopped',
    });
    const sources: WorkerBackgroundTaskSources = {
      getAgentLifecycle: () => lifecycle,
      getShellRegistry: () => shellRegistry,
    };
    const port = createWorkerBackgroundTaskPort(sources);

    const snapshot = JSON.parse((await new GetTaskOutputTool(port).execute({ task_ids: ['shell-1'] })).result) as {
      results: Array<{ status: string; output: string }>;
    };
    expect(snapshot.results[0].status).toBe('running');
    expect(snapshot.results[0].output).toContain('shell output line');

    const killed = JSON.parse((await new KillTaskTool(port).execute({ task_id: 'shell-1' })).result) as {
      outcome: string;
      message: string;
    };
    expect(killed).toMatchObject({ outcome: 'killed', message: 'Task shell-1 stopped' });
    expect(stopTask).toHaveBeenCalledWith('shell-1');
    shellRegistry.removeTask('shell-1');
  });

  it('binds Skill to the actual Host registry, preserving model visibility and prompt arguments', async () => {
    const registry = getSkillRegistry();
    const skill: PromptSkill = {
      type: 'prompt',
      name: 'pdf',
      description: 'PDF instructions',
      source: 'bundled',
      getPromptForCommand: async (args) => `PDF: ${args}`,
    };
    registry.register(skill);
    registry.register({
      ...skill,
      name: 'manual-only',
      disableModelInvocation: true,
    });

    const tool = new SkillTool(createWorkerSkillToolPort());
    const loaded = JSON.parse((await tool.execute({ skill: '/pdf', args: 'merge' })).result) as Record<string, unknown>;
    expect(loaded).toMatchObject({ commandName: 'pdf', status: 'inline', content: 'PDF: merge' });
    const unknown = JSON.parse((await tool.execute({ skill: 'missing' })).result) as { availableSkills: string[] };
    expect(unknown.availableSkills).toEqual(['pdf']);
  });

  it('seeds without truncating existing plan files and forwards mode transitions to the tracker port', async () => {
    const files = new Map<string, string>();
    const events: string[] = [];
    const dependencies: WorkerModeSwitchDependencies = {
      resolvePlanFilePath: (sessionId) => `C:/test/${sessionId}/plan.md`,
      transitionPlanMode: (event) => { events.push(event); },
      readFile: async (path) => {
        const value = files.get(path);
        if (value === undefined) {
          const error = new Error('missing') as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          throw error;
        }
        return value;
      },
      mkdir: async () => {},
      writeFile: async (path, data) => { files.set(path, data); },
    };
    const service = createWorkerModeSwitchService(dependencies);
    const context = { toolUseId: 'tool-1', options: { sessionId: 'session-1' } };

    const entered = JSON.parse((await new EnterPlanModeTool(service).execute({}, undefined, context)).result) as {
      seed: string;
      planFile: string;
    };
    expect(entered).toEqual({
      message: 'Entered plan mode. Use Task tool with action "create" to plan your work.',
      planMode: true,
      planFile: 'C:/test/session-1/plan.md',
      seed: 'empty',
    });
    files.set(entered.planFile, 'preserve this plan');
    const reentered = JSON.parse((await new EnterPlanModeTool(service).execute({}, undefined, context)).result) as {
      seed: string;
    };
    expect(reentered.seed).toBe('non_empty');
    expect(files.get(entered.planFile)).toBe('preserve this plan');

    const switched = await new SwitchModeTool(service).execute({ mode: 'verify' });
    expect(JSON.parse(switched.result)).toMatchObject({ currentMode: 'verify', readOnly: true });
    const exited = JSON.parse((await new ExitPlanModeTool(service).execute()).result) as { planMode: boolean };
    expect(exited.planMode).toBe(false);
    expect(events).toEqual(['activate_from_tool', 'exit_approved']);
  });
});
