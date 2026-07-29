/**
 * ModeModifierRegistry — declarative mode resolution tests (plan 224 Phase 1.4).
 *
 * Covers:
 *   - Single mode resolution (plan-task, research, conductor)
 *   - Composable modes (research + conductor can both be active)
 *   - Mutually exclusive modes (plan-task conflicts with research and conductor)
 *   - Tool merging: inject (array + function form), block, allow, overrideFilter
 *   - Prompt merging: prefixes and suffixes concatenate in registration order
 *   - Unknown ids are silently dropped
 *   - applyModes end-to-end: hooks fire, prompt/tools/context composed correctly
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ModeModifierRegistry } from '../registry.js';
import { applyModes, runExitHooks, collectActiveModes } from '../apply-modes.js';
import type {
  ModeModifier,
  ModeModifierContext,
  ToolRegistration,
} from '../types.js';
import type { Tool } from '../../types.js';
import type { ToolExecutor } from '../../tool/registry.js';

// ── Test helpers ────────────────────────────────────────────────

function makeTool(name: string): ToolRegistration {
  const definition: Tool = {
    name,
    description: `test tool ${name}`,
    input_schema: {},
  };
  const executor: ToolExecutor = {
    execute: async () => ({ id: '1', name, result: '' }),
  };
  return { definition, executor };
}

function makeCtx(): ModeModifierContext {
  return {
    sessionId: 'test-session',
    workingDirectory: '/test',
    state: {},
  };
}

/** Minimal mode builder for tests — only sets id + kind + the given fields. */
function makeMode(
  id: string,
  overrides: Partial<ModeModifier> = {},
): ModeModifier {
  return {
    id,
    kind: 'message',
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────

describe('ModeModifierRegistry.resolve', () => {
  let registry: ModeModifierRegistry;

  beforeEach(() => {
    registry = new ModeModifierRegistry();
  });

  it('resolves a single mode', () => {
    const planTask = makeMode('plan-task', {
      exclusiveWith: ['research', 'conductor'],
      tools: { block: ['bash'] },
    });
    registry.register(planTask);

    const resolved = registry.resolve(['plan-task']);
    expect(resolved.modes.map((m) => m.id)).toEqual(['plan-task']);
    expect(resolved.tools.blocked).toEqual(['bash']);
  });

  it('drops unknown mode ids silently', () => {
    registry.register(makeMode('plan-task'));
    const resolved = registry.resolve(['plan-task', 'does-not-exist']);
    expect(resolved.modes.map((m) => m.id)).toEqual(['plan-task']);
  });

  it('composes research + conductor (no exclusiveWith declared between them)', () => {
    const research = makeMode('research', { tools: { block: ['bash'] } });
    const conductor = makeMode('conductor', {
      kind: 'session',
      tools: { inject: [makeTool('canvas_create')], overrideFilter: true },
    });
    registry.register(research);
    registry.register(conductor);

    const resolved = registry.resolve(['research', 'conductor']);
    expect(resolved.modes.map((m) => m.id)).toEqual(['research', 'conductor']);
    expect(resolved.tools.blocked).toEqual(['bash']);
    expect(resolved.tools.overrideFilter).toBe(true);
    expect(resolved.tools.injects).toHaveLength(1);
  });

  it('drops later mode when earlier one declares exclusiveWith', () => {
    // plan-task excludes both research and conductor
    const planTask = makeMode('plan-task', {
      exclusiveWith: ['research', 'conductor'],
    });
    const research = makeMode('research', {
      exclusiveWith: ['plan-task'],
    });
    const conductor = makeMode('conductor', {
      exclusiveWith: ['plan-task'],
      kind: 'session',
    });
    registry.register(planTask);
    registry.register(research);
    registry.register(conductor);

    // plan-task wins, research and conductor dropped
    const r1 = registry.resolve(['plan-task', 'research', 'conductor']);
    expect(r1.modes.map((m) => m.id)).toEqual(['plan-task']);

    // research first → research wins, plan-task dropped; conductor also dropped (excluded by research? no — research doesn't exclude conductor)
    const r2 = registry.resolve(['research', 'plan-task']);
    expect(r2.modes.map((m) => m.id)).toEqual(['research']);

    // conductor + research: both compose (neither excludes the other)
    const r3 = registry.resolve(['conductor', 'research']);
    expect(r3.modes.map((m) => m.id)).toEqual(['conductor', 'research']);
  });

  it('merges blocked tool lists across modes (union)', () => {
    const a = makeMode('a', { tools: { block: ['bash', 'edit'] } });
    const b = makeMode('b', { tools: { block: ['write', 'bash'] } });
    registry.register(a);
    registry.register(b);

    const resolved = registry.resolve(['a', 'b']);
    expect(resolved.tools.blocked.sort()).toEqual(['bash', 'edit', 'write']);
  });

  it('intersects allow-lists across modes', () => {
    const a = makeMode('a', { tools: { allow: ['read', 'grep', 'glob'] } });
    const b = makeMode('b', { tools: { allow: ['read', 'grep'] } });
    registry.register(a);
    registry.register(b);

    const resolved = registry.resolve(['a', 'b']);
    expect(resolved.tools.allowed?.sort()).toEqual(['grep', 'read']);
  });

  it('returns null allowed when no mode declares allow', () => {
    const a = makeMode('a', { tools: { block: ['bash'] } });
    registry.register(a);
    const resolved = registry.resolve(['a']);
    expect(resolved.tools.allowed).toBeNull();
  });

  it('preserves function-form inject without evaluating it', () => {
    let callCount = 0;
    const conductor = makeMode('conductor', {
      kind: 'session',
      tools: {
        inject: () => {
          callCount++;
          return [makeTool('canvas_create')];
        },
        overrideFilter: true,
      },
    });
    registry.register(conductor);

    const resolved = registry.resolve(['conductor']);
    // Function not called during resolve — ctx not available yet
    expect(callCount).toBe(0);
    expect(resolved.tools.injects).toHaveLength(1);
    expect(typeof resolved.tools.injects[0]).toBe('function');
  });

  it('collects prompt prefixes/suffixes in registration order', () => {
    const a = makeMode('a', { prompt: { prefix: 'A_PREFIX', suffix: 'A_SUFFIX' } });
    const b = makeMode('b', { prompt: { prefix: 'B_PREFIX' } });
    registry.register(a);
    registry.register(b);

    const resolved = registry.resolve(['a', 'b']);
    expect(resolved.prompt.prefixes).toEqual(['A_PREFIX', 'B_PREFIX']);
    expect(resolved.prompt.suffixes).toEqual(['A_SUFFIX']);
  });
});

// ── applyModes end-to-end ───────────────────────────────────────

describe('applyModes', () => {
  it('runs onEnter hooks in order, applies prompt + tools + context patch', async () => {
    const entered: string[] = [];
    const conductor = makeMode('conductor', {
      kind: 'session',
      tools: {
        inject: [makeTool('canvas_create')],
        overrideFilter: true,
      },
      prompt: { prefix: '[CONDUCTOR]' },
      hooks: {
        onEnter: (ctx) => {
          entered.push('conductor');
          ctx.state.conductorCanvasId = 'canvas-123';
          ctx.toolUseContextPatch = { conductorCanvasId: 'canvas-123' };
        },
      },
    });
    const registry = new ModeModifierRegistry();
    registry.register(conductor);

    const resolved = registry.resolve(['conductor']);
    const ctx = makeCtx();
    const result = await applyModes({
      basePrompt: 'BASE',
      baseTools: [makeTool('read')],
      baseToolUseContext: { sessionId: 'test-session' },
      ctx,
      resolved,
    });

    expect(entered).toEqual(['conductor']);
    expect(result.systemPrompt).toBe('[CONDUCTOR]BASE');
    expect(result.tools.map((t) => t.definition.name).sort()).toEqual(['canvas_create', 'read']);
    expect(result.toolUseContext.conductorCanvasId).toBe('canvas-123');
    expect(ctx.state.conductorCanvasId).toBe('canvas-123');
  });

  it('blocks tools but keeps injected tools (no overrideFilter)', async () => {
    const planTask = makeMode('plan-task', {
      tools: {
        block: ['bash', 'write'],
        allow: ['read', 'grep'],
      },
    });
    const registry = new ModeModifierRegistry();
    registry.register(planTask);

    const resolved = registry.resolve(['plan-task']);
    const result = await applyModes({
      basePrompt: 'BASE',
      baseTools: [makeTool('read'), makeTool('grep'), makeTool('bash'), makeTool('write'), makeTool('edit')],
      ctx: makeCtx(),
      resolved,
    });

    // allow-list applied to base tools: only read + grep survive
    // (block is also applied first, but allow is stricter)
    expect(result.tools.map((t) => t.definition.name).sort()).toEqual(['grep', 'read']);
  });

  it('overrideFilter bypasses block + allow on base tools', async () => {
    const conductor = makeMode('conductor', {
      kind: 'session',
      tools: {
        inject: [makeTool('canvas_create')],
        overrideFilter: true,
      },
    });
    const registry = new ModeModifierRegistry();
    registry.register(conductor);

    const resolved = registry.resolve(['conductor']);
    const result = await applyModes({
      basePrompt: 'BASE',
      baseTools: [makeTool('read'), makeTool('bash')],
      ctx: makeCtx(),
      resolved,
    });

    // overrideFilter=true: base tools kept as-is, injected tools appended
    expect(result.tools.map((t) => t.definition.name).sort()).toEqual(['bash', 'canvas_create', 'read']);
  });

  it('evaluates function-form inject with ctx', async () => {
    const conductor = makeMode('conductor', {
      kind: 'session',
      tools: {
        inject: (ctx) => [makeTool(`canvas_for_${ctx.sessionId}`)],
        overrideFilter: true,
      },
    });
    const registry = new ModeModifierRegistry();
    registry.register(conductor);

    const resolved = registry.resolve(['conductor']);
    const result = await applyModes({
      basePrompt: 'BASE',
      baseTools: [],
      ctx: makeCtx(),
      resolved,
    });

    expect(result.tools.map((t) => t.definition.name)).toEqual(['canvas_for_test-session']);
  });

  it('merges beforeStream patches (later modes override earlier)', async () => {
    const a = makeMode('a', {
      hooks: { beforeStream: () => ({ maxIterations: 10 }) },
    });
    const b = makeMode('b', {
      hooks: { beforeStream: () => ({ maxIterations: 20 }) },
    });
    const registry = new ModeModifierRegistry();
    registry.register(a);
    registry.register(b);

    const resolved = registry.resolve(['a', 'b']);
    const result = await applyModes({
      basePrompt: '',
      baseTools: [],
      ctx: makeCtx(),
      resolved,
    });

    expect(result.streamOpts.maxIterations).toBe(20);
  });

  it('composes prompt prefix/suffix (string + function form)', async () => {
    const a = makeMode('a', { prompt: { prefix: 'A_' } });
    const b = makeMode('b', {
      prompt: {
        prefix: (ctx, base) => `B(${ctx.sessionId})|${base}`,
        suffix: '_B_END',
      },
    });
    const registry = new ModeModifierRegistry();
    registry.register(a);
    registry.register(b);

    const resolved = registry.resolve(['a', 'b']);
    const result = await applyModes({
      basePrompt: 'BASE',
      baseTools: [],
      ctx: makeCtx(),
      resolved,
    });

    // a prefix first: "A_BASE"
    // then b prefix function: "B(test-session)|A_BASE"
    // then b suffix: "B(test-session)|A_BASE_B_END"
    expect(result.systemPrompt).toBe('B(test-session)|A_BASE_B_END');
  });
});

// ── runExitHooks ────────────────────────────────────────────────

describe('runExitHooks', () => {
  it('fires onExit only for kind=message modes', async () => {
    const exited: string[] = [];
    const messageMode = makeMode('msg', {
      kind: 'message',
      hooks: { onExit: () => { exited.push('msg'); } },
    });
    const sessionMode = makeMode('sess', {
      kind: 'session',
      hooks: { onExit: () => { exited.push('sess'); } },
    });
    const registry = new ModeModifierRegistry();
    registry.register(messageMode);
    registry.register(sessionMode);

    const resolved = registry.resolve(['msg', 'sess']);
    await runExitHooks(resolved, makeCtx());

    expect(exited).toEqual(['msg']);
  });
});

// ── collectActiveModes ──────────────────────────────────────────

describe('collectActiveModes', () => {
  it('translates mode + conductorMode into activeModes array', () => {
    expect(collectActiveModes({})).toEqual([]);
    expect(collectActiveModes({ mode: 'research' })).toEqual(['research']);
    expect(collectActiveModes({ conductorMode: true })).toEqual(['conductor']);
    expect(collectActiveModes({ mode: 'research', conductorMode: true })).toEqual([
      'research',
      'conductor',
    ]);
  });
});

// ── Orchestrator paradigm (Phase 1.5) ──────────────────────────

describe('ModeModifierRegistry.resolve — orchestrator paradigm', () => {
  let registry: ModeModifierRegistry;

  beforeEach(() => {
    registry = new ModeModifierRegistry();
  });

  it('preserves orchestrator field on resolved mode', () => {
    const orchExecute = async function* () { /* noop */ };
    const research = makeMode('research', {
      kind: 'message',
      exclusiveWith: ['plan-task'],
      orchestrator: { execute: orchExecute },
    });
    registry.register(research);

    const resolved = registry.resolve(['research']);
    expect(resolved.modes).toHaveLength(1);
    expect(resolved.modes[0].orchestrator).toBeDefined();
    expect(resolved.modes[0].orchestrator?.execute).toBe(orchExecute);
  });

  it('orchestrator mode still participates in exclusiveWith resolution', () => {
    const orchExecute = async function* () { /* noop */ };
    const research = makeMode('research', {
      exclusiveWith: ['plan-task'],
      orchestrator: { execute: orchExecute },
    });
    const planTask = makeMode('plan-task', {
      exclusiveWith: ['research'],
      tools: { block: ['bash'] },
    });
    registry.register(research);
    registry.register(planTask);

    // plan-task first → research dropped
    const r1 = registry.resolve(['plan-task', 'research']);
    expect(r1.modes.map((m) => m.id)).toEqual(['plan-task']);
    expect(r1.modes[0].orchestrator).toBeUndefined();

    // research first → plan-task dropped
    const r2 = registry.resolve(['research', 'plan-task']);
    expect(r2.modes.map((m) => m.id)).toEqual(['research']);
    expect(r2.modes[0].orchestrator).toBeDefined();
  });

  it('orchestrator mode can compose with modifier mode (no exclusiveWith)', () => {
    const orchExecute = async function* () { /* noop */ };
    const research = makeMode('research', {
      orchestrator: { execute: orchExecute },
    });
    const conductor = makeMode('conductor', {
      kind: 'session',
      tools: { inject: [makeTool('canvas_create')], overrideFilter: true },
    });
    registry.register(research);
    registry.register(conductor);

    const resolved = registry.resolve(['research', 'conductor']);
    expect(resolved.modes.map((m) => m.id)).toEqual(['research', 'conductor']);
    // Both modes present — streamChat is responsible for detecting the
    // orchestrator and taking over the stream.
    expect(resolved.modes[0].orchestrator).toBeDefined();
    expect(resolved.modes[1].tools?.overrideFilter).toBe(true);
  });

  it('orchestrator field is not evaluated during resolve (lazy like function-form inject)', () => {
    let callCount = 0;
    const research = makeMode('research', {
      orchestrator: {
        execute: async function* () {
          callCount++;
          yield { type: 'text', data: 'orchestrator event' };
        },
      },
    });
    registry.register(research);

    const resolved = registry.resolve(['research']);
    // execute generator not invoked during resolve
    expect(callCount).toBe(0);
    expect(resolved.modes[0].orchestrator).toBeDefined();
  });
});
