import { describe, expect, it } from 'vitest';
import { parseDwfPreviewSteps } from './dwf-preview';

describe('parseDwfPreviewSteps', () => {
  it('returns [] for empty or wf-less scripts', () => {
    expect(parseDwfPreviewSteps('')).toEqual([]);
    expect(parseDwfPreviewSteps('const x = 1;\nexport default async (wf) => x;')).toEqual([]);
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
    const steps = parseDwfPreviewSteps(script);

    expect(steps[0]).toMatchObject({ id: 'preview-001-tool', nodeKind: 'tool', label: 'Bash' });
    expect(steps[1]).toMatchObject({ nodeKind: 'phase', label: 'collect' });
    expect(steps[2]).toMatchObject({ nodeKind: 'agent', label: 'agent:速览员' });
    expect(steps[3]).toMatchObject({ nodeKind: 'agent' });
    expect(steps[4]).toMatchObject({ nodeKind: 'phase', label: 'publish' });
    expect(steps[5]).toMatchObject({ nodeKind: 'tool', label: 'report.md' });
    expect(steps.every((s) => s.status === 'pending')).toBe(true);
  });

  it('maps gui and decide without string first args', () => {
    const steps = parseDwfPreviewSteps("await wf.gui({ target_app: 'x' });\nawait wf.decide(q, {});");
    expect(steps[0]).toMatchObject({ nodeKind: 'gui' });
    expect(steps[1]).toMatchObject({ nodeKind: 'decision' });
  });

  it('truncates long approve prompts for the human chip', () => {
    const long = 'x'.repeat(60);
    const [step] = parseDwfPreviewSteps(`await wf.approve('${long}', { onTimeout: 'fail' });`);
    expect(step.nodeKind).toBe('human');
    expect(step.label!.length).toBeLessThanOrEqual(25);
    expect(step.label!.endsWith('…')).toBe(true);
  });

  it('ignores calls inside full-line and block comments', () => {
    const script = [
      '// await wf.tool("Ghost");',
      '/* await wf.phase("ghost"); */',
      "await wf.tool('Bash');",
    ].join('\n');
    const steps = parseDwfPreviewSteps(script);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ label: 'Bash' });
  });

  it('handles template-literal and escaped quote arguments', () => {
    const steps = parseDwfPreviewSteps("await wf.phase(`发布 ${args.tag}`);\nawait wf.tool('Bash\\'s');");
    expect(steps[0]).toMatchObject({ nodeKind: 'phase' });
    expect(steps[1]).toMatchObject({ label: "Bash's" });
  });

  it('feeds StageColumns-compatible shapes (structurally a StageStep)', () => {
    const steps = parseDwfPreviewSteps("await wf.phase('a');\nawait wf.agent('agent:x','p');");
    expect(steps[0]).toEqual(
      expect.objectContaining({ id: expect.any(String), label: 'a', status: 'pending', nodeKind: 'phase' }),
    );
    expect(steps[1]).toEqual(
      expect.objectContaining({ id: expect.any(String), status: 'pending', nodeKind: 'agent' }),
    );
  });
});
