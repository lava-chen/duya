/**
 * converter.test.ts — plan 556 Phase 3 gate: recorded event fixture
 * streams → WorkflowDef structure assertions, validateWorkflow
 * conformity, human-node insertion cases, and the degradation warnings.
 */

import { describe, it, expect } from 'vitest';
import { REDACTED_TEXT, type AppRef, type RecorderEvent } from '@duya/computer-use';

import {
  convertEventsToWorkflow,
  isIrreversibleElement,
  RecorderNodeAnnotationSchema,
} from '../converter.js';
import { convertEventsToWorkflow as convertViaIndex } from '../index.js';

// ─── fixtures ───

let clock = 0;
const ts = (): number => (clock += 100);

const appRef = (name: string, processName: string, pid: number, title = ''): AppRef => ({
  name,
  title,
  processName,
  pid,
});

function clickEvent(
  app: AppRef,
  elementName: string,
  controlType = 'Button',
  overrides: Partial<Extract<RecorderEvent, { type: 'click' }>> = {},
): RecorderEvent {
  return {
    type: 'click',
    ts: ts(),
    app,
    click: { x: 120, y: 80, button: 'left', count: 1 },
    element: { name: elementName, controlType, source: 'uia-probe' },
    ...overrides,
  };
}

function typeEvent(app: AppRef, text: string, overrides: Partial<Extract<RecorderEvent, { type: 'type' }>> = {}): RecorderEvent {
  return {
    type: 'type',
    ts: ts(),
    app,
    text,
    element: { name: 'Text field', controlType: 'Edit', source: 'uia-probe' },
    ...overrides,
  };
}

function keyEvent(app: AppRef, key: string, modifiers: string[] = []): RecorderEvent {
  return { type: 'key', ts: ts(), app, key, modifiers };
}

function focusEvent(app: AppRef, browserUrl?: string): RecorderEvent {
  return { type: 'app_focus', ts: ts(), app, ...(browserUrl ? { browserUrl } : {}) };
}

const CHROME = appRef('Google Chrome', 'chrome', 4242, 'Example - Google Chrome');
const NOTEPAD = appRef('记事本', 'notepad', 8181, 'Untitled - Notepad');

// ─── structure ───

describe('convertEventsToWorkflow — structure', () => {
  it('two-app recording → two phases, capture-prefixed steps, global som refs', () => {
    const events: RecorderEvent[] = [
      focusEvent(CHROME),
      clickEvent(CHROME, 'Search box', 'Edit'),
      typeEvent(CHROME, 'hello world'),
      focusEvent(NOTEPAD),
      typeEvent(NOTEPAD, 'notes'),
      keyEvent(NOTEPAD, 'enter'),
    ];

    const result = convertEventsToWorkflow(events);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.def).toBeDefined();
    const def = result.def!;

    expect(def.name).toBe('recorded-chrome-notepad');
    expect(def.phases).toHaveLength(2);
    expect(def.phases[0]!.phase).toBe('app-1');
    expect(def.phases[0]!.title).toBe('Google Chrome');
    expect(def.phases[1]!.phase).toBe('app-2');

    // Chrome phase: capture → click som:1 → type_text som:2.
    const chromeSteps = def.phases[0]!.nodes[0]!.gui!.steps;
    expect(chromeSteps).toEqual([
      { do: 'capture' },
      { do: 'click', element: 'som:1' },
      { do: 'type_text', text: 'hello world', element: 'som:2' },
    ]);

    // Notepad phase: capture → type_text som:3 → key.
    const notepadSteps = def.phases[1]!.nodes[0]!.gui!.steps;
    expect(notepadSteps).toEqual([
      { do: 'capture' },
      { do: 'type_text', text: 'notes', element: 'som:3' },
      { do: 'key', key: 'enter' },
    ]);
    expect(def.phases[1]!.nodes[0]!.gui!.target_app).toBe('记事本');
  });

  it('annotation carries the recorded ElementDescriptors per som ref', () => {
    const events: RecorderEvent[] = [
      focusEvent(CHROME),
      clickEvent(CHROME, 'Sign in'),
      typeEvent(CHROME, 'ada@example.com'),
    ];
    const result = convertEventsToWorkflow(events);
    expect(result.ok).toBe(true);

    const annotation = RecorderNodeAnnotationSchema.parse(result.def!.phases[0]!.nodes[0]!.annotation);
    expect(annotation.source).toBe('recorder');
    expect(annotation.app).toBe('Google Chrome');
    expect(Object.keys(annotation.som).sort()).toEqual(['som:1', 'som:2']);
    expect(annotation.som['som:1']).toMatchObject({
      element: { name: 'Sign in', controlType: 'Button', source: 'uia-probe' },
      point: { x: 120, y: 80 },
      clickCount: 1,
    });
  });

  it('product passes validateWorkflow with the same rights as a planner def', () => {
    const events: RecorderEvent[] = [
      focusEvent(CHROME, 'https://example.com'),
      clickEvent(CHROME, 'Search box', 'Edit'),
      typeEvent(CHROME, 'duya'),
      keyEvent(CHROME, 'ctrl+s', ['ctrl']),
    ];
    // The structural gate is validateWorkflow itself (imported through
    // the same surface the planner uses); ok:true already implies it,
    // this test pins the contract explicitly.
    const result = convertViaIndex(events);
    expect(result.ok).toBe(true);
    expect(result.def!.phases[0]!.nodes[0]!.gui!.steps.some((s) => s.do === 'key' && s.key === 'ctrl+s')).toBe(true);
  });
});

// ─── capture injection on browserUrl change ───

describe('convertEventsToWorkflow — browserUrl', () => {
  it('injects a capture when the URL changes mid-phase', () => {
    const events: RecorderEvent[] = [
      focusEvent(CHROME, 'https://a.example.com'),
      clickEvent(CHROME, 'Next page link', 'Hyperlink'),
      focusEvent(CHROME, 'https://b.example.com'), // same app → same phase
      clickEvent(CHROME, 'Submit'),
    ];
    const result = convertEventsToWorkflow(events);
    expect(result.ok).toBe(true);
    const steps = result.def!.phases[0]!.nodes[0]!.gui!.steps;
    expect(steps).toEqual([
      { do: 'capture' },
      { do: 'click', element: 'som:1' },
      { do: 'capture' },
      { do: 'click', element: 'som:2' },
    ]);
    const annotation = RecorderNodeAnnotationSchema.parse(result.def!.phases[0]!.nodes[0]!.annotation);
    expect(annotation.browserUrl).toBe('https://b.example.com');
  });
});

// ─── password redaction ───

describe('convertEventsToWorkflow — password paramHint', () => {
  it('redacted text is recorded verbatim and flagged paramHint', () => {
    const events: RecorderEvent[] = [
      focusEvent(CHROME),
      clickEvent(CHROME, 'Password', 'Edit'),
      typeEvent(CHROME, REDACTED_TEXT, {
        element: { name: 'Password', controlType: 'Edit', source: 'uia-probe', isPassword: true },
      }),
    ];
    const result = convertEventsToWorkflow(events);
    expect(result.ok).toBe(true);
    const steps = result.def!.phases[0]!.nodes[0]!.gui!.steps;
    expect(steps[2]).toEqual({ do: 'type_text', text: REDACTED_TEXT, element: 'som:2' });
    const annotation = RecorderNodeAnnotationSchema.parse(result.def!.phases[0]!.nodes[0]!.annotation);
    expect(annotation.som['som:2']!.paramHint).toBe(true);
    expect(annotation.som['som:2']!.element.isPassword).toBe(true);
  });

  it('plain typing carries no paramHint', () => {
    const events: RecorderEvent[] = [focusEvent(NOTEPAD), typeEvent(NOTEPAD, 'plain notes')];
    const result = convertEventsToWorkflow(events);
    const annotation = RecorderNodeAnnotationSchema.parse(result.def!.phases[0]!.nodes[0]!.annotation);
    expect(annotation.som['som:1']!.paramHint).toBeUndefined();
  });
});

// ─── human approval insertion ───

describe('convertEventsToWorkflow — irreversible human gate', () => {
  it('element name hitting RULE_RISK_RE inserts a human node before the gui node', () => {
    const events: RecorderEvent[] = [
      focusEvent(CHROME),
      clickEvent(CHROME, 'Search'),
      clickEvent(CHROME, 'Send message'),
    ];
    const result = convertEventsToWorkflow(events);
    expect(result.ok).toBe(true);
    const nodes = result.def!.phases[0]!.nodes;
    expect(nodes).toHaveLength(2);
    expect(nodes[0]!.human).toBeDefined();
    expect(nodes[0]!.human!.timeout.on_timeout).toBe('fail');
    expect(nodes[0]!.id).toBe('app-1-approve');
    expect(nodes[1]!.gui).toBeDefined();
    expect(nodes[0]!.human!.prompt).toContain('Send message');
  });

  it('typed text hitting RULE_RISK_RE also gates', () => {
    const events: RecorderEvent[] = [focusEvent(NOTEPAD), typeEvent(NOTEPAD, 'please delete the file')];
    const result = convertEventsToWorkflow(events);
    expect(result.def!.phases[0]!.nodes[0]!.human).toBeDefined();
  });

  it('every MenuItem click gates, even with an innocuous name', () => {
    const events: RecorderEvent[] = [focusEvent(NOTEPAD), clickEvent(NOTEPAD, '文件', 'MenuItem')];
    const result = convertEventsToWorkflow(events);
    expect(result.ok).toBe(true);
    expect(result.def!.phases[0]!.nodes[0]!.human).toBeDefined();
  });

  it('a benign phase gets no human node; isIrreversibleElement matches planner semantics', () => {
    const events: RecorderEvent[] = [focusEvent(CHROME), clickEvent(CHROME, 'Refresh')];
    const result = convertEventsToWorkflow(events);
    expect(result.def!.phases[0]!.nodes).toHaveLength(1);
    expect(result.def!.phases[0]!.nodes[0]!.gui).toBeDefined();

    expect(isIrreversibleElement({ name: 'Delete file', source: 'uia-probe' })).toBe(true);
    expect(isIrreversibleElement({ name: 'Refresh', source: 'uia-probe' })).toBe(false);
    expect(isIrreversibleElement({ source: 'none' }, 'now push to main')).toBe(true);
    expect(isIrreversibleElement({ controlType: 'MenuItem', source: 'uia-probe' })).toBe(true);
  });
});

// ─── phase cap + degradation paths ───

describe('convertEventsToWorkflow — phase cap and warnings', () => {
  it('>8 app segments merge the tail into the 8th phase with a warning', () => {
    const events: RecorderEvent[] = [];
    for (let i = 1; i <= 9; i++) {
      const a = appRef(`App ${i}`, `app${i}`, 1000 + i);
      events.push(focusEvent(a), clickEvent(a, `Button ${i}`));
    }
    const result = convertEventsToWorkflow(events);
    expect(result.ok).toBe(true);
    expect(result.def!.phases).toHaveLength(8);
    expect(result.warnings.some((w) => w.includes('exceed the 8-phase'))).toBe(true);
    // Segments 8 and 9 both live in phase 8 as separate gui nodes.
    const lastPhase = result.def!.phases[7]!;
    expect(lastPhase.nodes).toHaveLength(2);
    expect(lastPhase.nodes[0]!.gui!.target_app).toBe('App 8');
    expect(lastPhase.nodes[1]!.gui!.target_app).toBe('App 9');
  });

  it('focus-only transits are dropped and split same-app segments re-merge', () => {
    const events: RecorderEvent[] = [
      focusEvent(CHROME),
      clickEvent(CHROME, 'Open dialog'),
      focusEvent(NOTEPAD), // transit, no interaction
      focusEvent(CHROME),
      typeEvent(CHROME, 'continued'),
    ];
    const result = convertEventsToWorkflow(events);
    expect(result.ok).toBe(true);
    expect(result.def!.phases).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes('transit'))).toBe(true);
    const steps = result.def!.phases[0]!.nodes[0]!.gui!.steps;
    expect(steps).toEqual([
      { do: 'capture' },
      { do: 'click', element: 'som:1' },
      { do: 'type_text', text: 'continued', element: 'som:2' },
    ]);
  });

  it('right/middle clicks are skipped with a warning (not replayed as left)', () => {
    const events: RecorderEvent[] = [
      focusEvent(CHROME),
      clickEvent(CHROME, 'Context target', 'Button', {
        click: { x: 5, y: 5, button: 'right', count: 1 },
      }),
      clickEvent(CHROME, 'Real button'),
    ];
    const result = convertEventsToWorkflow(events);
    expect(result.ok).toBe(true);
    const steps = result.def!.phases[0]!.nodes[0]!.gui!.steps;
    expect(steps).toEqual([{ do: 'capture' }, { do: 'click', element: 'som:1' }]);
    expect(result.warnings.some((w) => w.includes('right-click'))).toBe(true);
  });

  it('double-click collapses to one click step, clickCount annotated', () => {
    const events: RecorderEvent[] = [
      focusEvent(CHROME),
      clickEvent(CHROME, 'Row', 'ListItem', { click: { x: 1, y: 2, button: 'left', count: 2 } }),
    ];
    const result = convertEventsToWorkflow(events);
    const steps = result.def!.phases[0]!.nodes[0]!.gui!.steps;
    expect(steps).toEqual([{ do: 'capture' }, { do: 'click', element: 'som:1' }]);
    const annotation = RecorderNodeAnnotationSchema.parse(result.def!.phases[0]!.nodes[0]!.annotation);
    expect(annotation.som['som:1']!.clickCount).toBe(2);
  });

  it('scroll and combo keys map to their gui steps', () => {
    const events: RecorderEvent[] = [
      focusEvent(CHROME),
      { type: 'scroll', ts: ts(), app: CHROME, direction: 'down', amount: 3 },
    ];
    const result = convertEventsToWorkflow(events);
    const steps = result.def!.phases[0]!.nodes[0]!.gui!.steps;
    expect(steps).toEqual([{ do: 'capture' }, { do: 'scroll', direction: 'down', amount: 3 }]);
  });
});

// ─── failure paths ───

describe('convertEventsToWorkflow — invalid conversions', () => {
  it('no interactive events → ok:false with a clear error', () => {
    const events: RecorderEvent[] = [focusEvent(CHROME), focusEvent(NOTEPAD)];
    const result = convertEventsToWorkflow(events);
    expect(result.ok).toBe(false);
    expect(result.def).toBeUndefined();
    expect(result.errors[0]!.message).toContain('no interactive events');
  });

  it('typed template syntax fails the conversion explicitly (replay would corrupt)', () => {
    const events: RecorderEvent[] = [focusEvent(CHROME), typeEvent(CHROME, 'total ${params.x} usd')];
    const result = convertEventsToWorkflow(events);
    // `params.*` is a whitelisted template root, so validateWorkflow
    // alone would let it pass — the converter's own guard is what
    // catches the silent-replay-corruption case.
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.message.includes('template syntax'))).toBe(true);
    // The def is still returned so the UI can preview the YAML.
    expect(result.def).toBeDefined();
  });
});
