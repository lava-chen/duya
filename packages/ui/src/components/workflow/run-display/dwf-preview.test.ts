import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { parseDwfPreviewSteps } from './dwf-preview';

// The ts module is injected (renderer lazy-imports it, tests pass it directly)
// so every helper below goes through the same `p()` adapter.
const p = (script: string) => parseDwfPreviewSteps(script, ts);

describe('parseDwfPreviewSteps', () => {
  it('returns empty for empty or wf-less scripts', () => {
    expect(p('')).toEqual({ steps: [], diagnostics: [] });
    expect(p('const x = 1;\nexport default async (wf) => x;').steps).toEqual([]);
  });

  it('cuts stage columns at wf.phase and maps agent/tool calls in order', () => {
    const script = [
      "await wf.tool('Bash', { cmd: 'ls' });",
      "await wf.phase('collect');",
      "const a = await wf.agent('agent:速览员', '看仓库');",
      "const b = await wf.agent('agent:依赖员', '看依赖');",
      "await wf.phase('publish');",
      "await wf.publish('report.md', out);",
    ].join('\n');
    const { steps } = p(script);

    expect(steps[0]).toMatchObject({ id: 'preview-001-tool', nodeKind: 'tool', label: 'Bash' });
    expect(steps[1]).toMatchObject({ nodeKind: 'phase', label: 'collect' });
    expect(steps[2]).toMatchObject({ nodeKind: 'agent', label: 'agent:速览员' });
    expect(steps[3]).toMatchObject({ nodeKind: 'agent' });
    expect(steps[4]).toMatchObject({ nodeKind: 'phase', label: 'publish' });
    expect(steps[5]).toMatchObject({ nodeKind: 'tool', label: 'report.md' });
    expect(steps.every((s) => s.status === 'pending')).toBe(true);
  });

  it('maps gui, browser and decide without string first args', () => {
    const { steps } = p("await wf.gui({ target_app: 'x' });\nawait wf.browser({ steps: [] });\nawait wf.decide(q, {});");
    expect(steps[0]).toMatchObject({ nodeKind: 'gui' });
    expect(steps[1]).toMatchObject({ nodeKind: 'browser' });
    expect(steps[2]).toMatchObject({ nodeKind: 'decision' });
  });

  it('truncates long approve prompts for the human chip', () => {
    const long = 'x'.repeat(60);
    const { steps } = p(`await wf.approve('${long}', { onTimeout: 'fail' });`);
    expect(steps[0].nodeKind).toBe('human');
    expect(steps[0].label!.length).toBeLessThanOrEqual(25);
    expect(steps[0].label!.endsWith('…')).toBe(true);
  });

  it('marks optional / on_stuck:skip nodes with a skip suffix (AST-read options)', () => {
    const { steps } = p([
      "await wf.tool('Bash', { cmd: 'ls' }, { optional: true });",
      "await wf.gui({ target_app: 'x' }, { on_stuck: 'skip' });",
      "await wf.tool('Bash', { cmd: 'pwd' });",
    ].join('\n'));
    expect(steps[0].label).toBe('Bash ·skip');
    expect(steps[1].label).toBe('·skip');
    expect(steps[2].label).toBe('Bash');
  });

  it('ignores wf.* calls inside comments, strings and non-wf receivers', () => {
    const script = [
      '// await wf.tool("Ghost");',
      '/* await wf.phase("ghost"); */',
      "const s = \"await wf.tool('GhostString')\";",
      'helper.wf.tool("NotMine");',
      "await wf.tool('Bash');",
    ].join('\n');
    const { steps } = p(script);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ label: 'Bash' });
  });

  it('visits calls nested inside wf.map callbacks in source order', () => {
    const script = [
      "await wf.map(items, async (item) => {",
      "  await wf.agent('agent:研究员', item);",
      "});",
      "await wf.phase('done');",
    ].join('\n');
    const { steps } = p(script);
    expect(steps.map((s) => s.nodeKind)).toEqual(['agent', 'phase']);
  });

  it('reports unknown wf primitives as line-numbered diagnostics', () => {
    const script = "await wf.tool('Bash');\nawait wf.teleport('moon');";
    const { steps, diagnostics } = p(script);
    expect(steps).toHaveLength(1);
    expect(diagnostics).toEqual([{ line: 2, message: 'unknown wf primitive: wf.teleport()' }]);
  });

  it('surfaces syntax errors instead of silently rendering a partial rail', () => {
    const { steps, diagnostics } = p("await wf.tool('Bash'\nconst = ;");
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.every((d) => d.line >= 1 && typeof d.message === 'string')).toBe(true);
  });
});
