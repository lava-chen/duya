import { describe, expect, it } from 'vitest';
import { definition as createDefinition } from '../../src/tool/CanvasConductor/CanvasCreateElementTool.js';
import { getCanvasConductorTools } from '../../src/tool/CanvasConductor/index.js';
import { KNOWLEDGE_SECTIONS } from '../../src/tool/CanvasConductor/knowledge-sections.js';
import { buildConductorPrompt } from '../../src/tool/CanvasConductor/prompt.js';
import { validateElementInput } from '../../src/tool/CanvasConductor/validate.js';

describe('conductor canvas design guidance', () => {
  it('keeps single-element creation guidance compact and readable', () => {
    const description = String(createDefinition.description);
    expect(description).toContain('compact label 2.5x1');
    expect(description).toContain('20-24px');
    expect(description).not.toContain('Minimum usable sticky size is 3x2');
  });

  it('does not register the batch creation tool', () => {
    const toolNames = getCanvasConductorTools().map(({ definition }) => definition.name);
    expect(toolNames).toHaveLength(13);
    expect(toolNames).not.toContain('canvas_batch_create');
    expect(toolNames).toContain('canvas_create_element');
  });

  it('keeps the mode prompt native-first while retaining compact guidance', () => {
    const prompt = buildConductorPrompt();
    expect(prompt).toContain('Editable Native Canvas First');
    expect(prompt).toContain('widget/dynamic is a last resort');
    expect(prompt).toContain('one element at a time with canvas_create_element');
    expect(prompt).not.toContain('canvas_batch_create');
    expect(prompt).toContain('Do not create new stickies');
    expect(KNOWLEDGE_SECTIONS['mindmap-layout']).toContain('Root: 3.5x1.25, fontSize 24');
    expect(KNOWLEDGE_SECTIONS['mindmap-layout']).toContain('Do not add a separate oversized title banner');
  });

  it('defaults editable diagrams to organized elbow routing', () => {
    const prompt = buildConductorPrompt();
    expect(String(createDefinition.description)).toContain('routingMode defaults to "elbow"');
    expect(prompt).toContain('Default to elbow routing for diagrams');
    expect(KNOWLEDGE_SECTIONS['connector-style']).toContain('Curve is opt-in');
    expect(KNOWLEDGE_SECTIONS['connector-style']).toContain('Shared Trunk / Bus Routing');
    expect(KNOWLEDGE_SECTIONS['connector-style']).not.toContain('Stroke Width');
    expect(KNOWLEDGE_SECTIONS['flowchart-layout']).toContain('Architecture Fan-out / Shared Bus');
  });

  it('keeps travel composition in on-demand knowledge rather than the base prompt', () => {
    const prompt = buildConductorPrompt();
    const travelGuide = KNOWLEDGE_SECTIONS['travel-guide'];
    expect(prompt).toContain('canvas_get_knowledge for the matching section');
    expect(prompt).not.toContain('weather mini-card');
    expect(travelGuide).toContain('one native/image with a verified map');
    expect(travelGuide).toContain('2–4 native/link cards');
    expect(travelGuide).toContain('weather mini-card');
    expect(travelGuide).toContain('only text boxes is incomplete');
  });

  it('accepts native text for direct element creation', () => {
    expect(validateElementInput('native/text', { x: 1, y: 1, w: 4, h: 1 }, { text: 'Title' })).toEqual({
      valid: true,
      errors: [],
    });
  });

  it('accepts an editable native table and documents it for the agent', () => {
    expect(String(createDefinition.description)).toContain('native/table');
    expect(buildConductorPrompt()).toContain('native/table');
    expect(validateElementInput('native/table', { x: 1, y: 1, w: 7, h: 4 }, {
      title: 'Packing list',
      headers: ['Item', 'Status'],
      rows: [['Boots', 'Pack']],
    })).toEqual({ valid: true, errors: [] });
  });
});
