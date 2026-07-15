import { describe, expect, it } from 'vitest';
import { definition as createDefinition } from '../../src/tool/CanvasConductor/CanvasCreateElementTool.js';
import { definition as batchDefinition } from '../../src/tool/CanvasConductor/CanvasBatchCreateTool.js';
import { KNOWLEDGE_SECTIONS } from '../../src/tool/CanvasConductor/knowledge-sections.js';
import { buildConductorPrompt } from '../../src/tool/CanvasConductor/prompt.js';

describe('conductor canvas design guidance', () => {
  it('keeps single-element creation guidance compact and readable', () => {
    const description = String(createDefinition.description);
    expect(description).toContain('compact label 2.5x1');
    expect(description).toContain('20-24px');
    expect(description).not.toContain('Minimum usable sticky size is 3x2');
  });

  it('distinguishes editable native maps from finished diagrams', () => {
    const description = String(batchDefinition.description);
    expect(description).toContain('native-node mind maps');
    expect(description).toContain('ONE widget/dynamic');
    expect(description).toContain('0.5-0.75 unit gaps');
    expect(description).toContain('Default every connector to routingMode="elbow"');
    expect(description).toContain('share one clean trunk/bus');
  });

  it('injects the same compact tiers into the mode prompt and knowledge', () => {
    const prompt = buildConductorPrompt();
    expect(prompt).toContain('root 3.5x1.25 at 24px');
    expect(prompt).toContain('Never use h=2 for a one-line branch label');
    expect(KNOWLEDGE_SECTIONS['mindmap-layout']).toContain('Root: 3.5x1.25, fontSize 24');
    expect(KNOWLEDGE_SECTIONS['mindmap-layout']).toContain('Do not add a separate oversized title banner');
  });

  it('defaults editable diagrams to organized elbow routing', () => {
    const prompt = buildConductorPrompt();
    expect(String(createDefinition.description)).toContain('routingMode defaults to "elbow"');
    expect(prompt).toContain("Default to routingMode: 'elbow'");
    expect(prompt).toContain('shared trunk/bus');
    expect(KNOWLEDGE_SECTIONS['connector-style']).toContain('Curve is opt-in');
    expect(KNOWLEDGE_SECTIONS['connector-style']).toContain('Shared Trunk / Bus Routing');
    expect(KNOWLEDGE_SECTIONS['connector-style']).not.toContain('Stroke Width');
    expect(KNOWLEDGE_SECTIONS['flowchart-layout']).toContain('Architecture Fan-out / Shared Bus');
  });
});
