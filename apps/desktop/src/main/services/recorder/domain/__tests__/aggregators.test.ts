import { describe, expect, it } from 'vitest';

import { RecorderAggregator, TYPE_SILENCE_FLUSH_MS } from '../aggregators';
import type { AppRef, RecorderEvent } from '../events';
import type {
  KeyDownEvent,
  MouseDownEvent,
  MouseUpEvent,
  WheelEvent,
} from '../worker-protocol';

const APP: AppRef = { name: 'Notepad', title: 'notes.txt', processName: 'notepad', pid: 42 };
const CTX = { app: APP };

let ts = 1000;
function tick(delta = 10): number {
  ts += delta;
  return ts;
}

function kd(opts: Partial<KeyDownEvent> & { keycode: number }): KeyDownEvent {
  return {
    kind: 'keydown',
    ts: tick(),
    name: null,
    char: null,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    ...opts,
  };
}

function mdown(opts: Partial<MouseDownEvent>): MouseDownEvent {
  return { kind: 'mousedown', ts: tick(), x: 100, y: 200, button: 1, clicks: 1, ...opts };
}

function mup(opts: Partial<MouseUpEvent>): MouseUpEvent {
  return { kind: 'mouseup', ts: tick(), x: 100, y: 200, button: 1, ...opts };
}

function wheel(rotation: number, atTs?: number): WheelEvent {
  return { kind: 'wheel', ts: atTs ?? tick(), rotation, amount: 3 };
}

const types = (events: RecorderEvent[]) => events.filter((e) => e.type === 'type');
const firstType = (events: RecorderEvent[]) => {
  const t = types(events);
  expect(t.length).toBeGreaterThan(0);
  return t[0]! as Extract<RecorderEvent, { type: 'type' }>;
};

describe('RecorderAggregator — keyboard', () => {
  it('accumulates printable keystrokes and flushes on silence (poll)', () => {
    const agg = new RecorderAggregator();
    expect(agg.feed(kd({ keycode: 30, char: 'a' }), CTX)).toEqual([]);
    expect(agg.feed(kd({ keycode: 31, char: 's' }), CTX)).toEqual([]);
    expect(agg.feed(kd({ keycode: 32, char: 'd' }), CTX)).toEqual([]);

    const flushed = agg.poll(CTX, ts + TYPE_SILENCE_FLUSH_MS);
    const t = firstType(flushed);
    expect(t.text).toBe('asd');
    expect(t.app).toEqual(APP);
    expect(t.element.source).toBe('none');
  });

  it('flushes the type buffer before a click, in order', () => {
    const agg = new RecorderAggregator();
    agg.feed(kd({ keycode: 48, char: 'b' }), CTX);
    const out = agg.feed(mdown({}), CTX).concat(agg.feed(mup({}), CTX));
    expect(out.map((e) => e.type)).toEqual(['type', 'click']);
    expect(firstType(out).text).toBe('b');
    const click = out.find((e) => e.type === 'click')! as Extract<RecorderEvent, { type: 'click' }>;
    expect(click.click).toMatchObject({ x: 100, y: 200, button: 'left', count: 1 });
  });

  it('lazy-flushes stale typing when the next event arrives after 2s', () => {
    const agg = new RecorderAggregator();
    expect(agg.feed(kd({ keycode: 37, char: 'h', ts: 1000 }), CTX)).toEqual([]);
    // A click far in the future: the type event must come first and
    // carry the LAST KEYSTROKE ts, not the click ts.
    const out = agg.feed(mdown({ ts: 5000 }), CTX);
    expect(out.map((e) => e.type)[0]).toBe('type');
    expect(firstType(out).ts).toBe(1000);
  });

  it('ctrl+s becomes a key event, not text, and flushes the buffer first', () => {
    const agg = new RecorderAggregator();
    agg.feed(kd({ keycode: 35, char: 'h' }), CTX);
    const out = agg.feed(kd({ keycode: 31, char: 's', ctrlKey: true }), CTX);
    expect(out.map((e) => e.type)).toEqual(['type', 'key']);
    const key = out[1]! as Extract<RecorderEvent, { type: 'key' }>;
    expect(key.key).toBe('s');
    expect(key.modifiers).toContain('ctrl');
    expect(firstType(out).text).toBe('h');
  });

  it('named keys (enter/tab) emit standalone key events and flush', () => {
    const agg = new RecorderAggregator();
    agg.feed(kd({ keycode: 37, char: 'h' }), CTX);
    const out = agg.feed(kd({ keycode: 28, name: 'enter' }), CTX);
    expect(out.map((e) => e.type)).toEqual(['type', 'key']);
    const key = out[1]! as Extract<RecorderEvent, { type: 'key' }>;
    expect(key.key).toBe('enter');
    expect(key.modifiers).toEqual([]);
  });

  it('unmapped printables degrade to <key:N> placeholders (D6)', () => {
    const agg = new RecorderAggregator();
    agg.feed(kd({ keycode: 37, char: 'h' }), CTX);
    agg.feed(kd({ keycode: 250 }), CTX); // no char, no name
    agg.feed(kd({ keycode: 30, char: 'a' }), CTX);
    const flushed = agg.poll(CTX, ts + TYPE_SILENCE_FLUSH_MS);
    expect(firstType(flushed).text).toBe('h<key:250>a');
  });

  it('shift+letter stays text (no combo)', () => {
    const agg = new RecorderAggregator();
    agg.feed(kd({ keycode: 35, char: 'H', shiftKey: true }), CTX);
    const flushed = agg.poll(CTX, ts + TYPE_SILENCE_FLUSH_MS);
    expect(firstType(flushed).text).toBe('H');
    // and no key events were emitted
    expect(flushed.filter((e) => e.type === 'key')).toHaveLength(0);
  });

  it('redacts the flushed text when the password hint is set', () => {
    const agg = new RecorderAggregator();
    agg.feed(kd({ keycode: 30, char: 'a' }), CTX);
    agg.feed(kd({ keycode: 30, char: 'b' }), { app: APP, redact: true });
    const flushed = agg.poll({ app: APP, redact: true }, ts + TYPE_SILENCE_FLUSH_MS);
    expect(firstType(flushed).text).toBe('<redacted>');
  });

  it('modifier keydowns produce nothing on their own', () => {
    const agg = new RecorderAggregator();
    expect(agg.feed(kd({ keycode: 29 }), CTX)).toEqual([]); // Ctrl down
    expect(agg.feed(kd({ keycode: 42 }), CTX)).toEqual([]); // Shift down
    expect(agg.feed({ kind: 'keyup', ts: tick(), keycode: 29, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false }, CTX)).toEqual([]);
    expect(agg.poll(CTX, ts + TYPE_SILENCE_FLUSH_MS)).toEqual([]);
  });

  it('flushType on finish() returns the trailing buffer', () => {
    const agg = new RecorderAggregator();
    agg.feed(kd({ keycode: 23, char: 'i' }), CTX);
    const out = agg.finish(CTX);
    expect(out).toHaveLength(1);
    expect(firstType(out).text).toBe('i');
  });
});

describe('RecorderAggregator — app focus', () => {
  it('onAppChanged flushes buffers attributed to the OLD app', () => {
    const agg = new RecorderAggregator();
    agg.feed(kd({ keycode: 37, char: 'h' }), CTX);
    const nextApp: AppRef = { name: 'Chrome', title: 'New Tab', processName: 'chrome', pid: 7 };
    const out = agg.onAppChanged(APP, { app: nextApp });
    expect(out.map((e) => e.type)).toEqual(['type']);
    expect(firstType(out).app).toEqual(APP);
  });
});

describe('RecorderAggregator — wheel', () => {
  it('debounces same-direction scrolling within 500ms into one scroll', () => {
    const agg = new RecorderAggregator({ now: () => ts });
    const base = 10000;
    agg.feed(wheel(1, base), CTX);
    agg.feed(wheel(1, base + 100), CTX);
    agg.feed(wheel(2, base + 200), CTX);
    const flushed = agg.poll(CTX, base + 800);
    const scrolls = flushed.filter((e) => e.type === 'scroll');
    expect(scrolls).toHaveLength(1);
    const scroll = scrolls[0]! as Extract<RecorderEvent, { type: 'scroll' }>;
    expect(scroll.direction).toBe('down'); // rotation > 0 = down
    expect(scroll.amount).toBe(4);
  });

  it('a direction flip flushes the previous run immediately', () => {
    const agg = new RecorderAggregator({ now: () => ts });
    const base = 10000;
    agg.feed(wheel(1, base), CTX);
    const out = agg.feed(wheel(-1, base + 100), CTX);
    const scrolls = out.filter((e) => e.type === 'scroll');
    expect(scrolls).toHaveLength(1);
    expect((scrolls[0]! as Extract<RecorderEvent, { type: 'scroll' }>).direction).toBe('down');
  });

  it('gap longer than the debounce window starts a new run', () => {
    const agg = new RecorderAggregator({ now: () => ts });
    const base = 10000;
    agg.feed(wheel(1, base), CTX);
    agg.feed(wheel(1, base + 900), CTX); // > 500ms → flush + new run
    const flushed = agg.poll(CTX, base + 2000);
    const scrolls = flushed.filter((e) => e.type === 'scroll');
    expect(scrolls).toHaveLength(1);
    expect((scrolls[0]! as Extract<RecorderEvent, { type: 'scroll' }>).amount).toBe(1);
  });
});

describe('RecorderAggregator — click pairing', () => {
  it('merges the OS double-click counter into count=2', () => {
    const agg = new RecorderAggregator();
    const out = agg.feed(mdown({ clicks: 2 }), CTX).concat(agg.feed(mup({}), CTX));
    const click = out.find((e) => e.type === 'click')! as Extract<RecorderEvent, { type: 'click' }>;
    expect(click.click.count).toBe(2);
  });

  it('records right clicks with the right button', () => {
    const agg = new RecorderAggregator();
    const out = agg
      .feed(mdown({ button: 2 }), CTX)
      .concat(agg.feed(mup({ button: 2 }), CTX));
    const click = out.find((e) => e.type === 'click')! as Extract<RecorderEvent, { type: 'click' }>;
    expect(click.click.button).toBe('right');
  });

  it('drops extra buttons (4/5) and unmatched ups', () => {
    const agg = new RecorderAggregator();
    expect(agg.feed(mdown({ button: 4 }), CTX).concat(agg.feed(mup({ button: 4 }), CTX))).toEqual([]);
    // up without a pending down
    expect(agg.feed(mup({}), CTX)).toEqual([]);
  });

  it('a click also flushes a pending wheel run first', () => {
    const agg = new RecorderAggregator({ now: () => ts });
    const base = 10000;
    agg.feed(wheel(1, base), CTX);
    const out = agg.feed(mdown({ ts: base + 10 }), CTX).concat(agg.feed(mup({ ts: base + 20 }), CTX));
    expect(out.map((e) => e.type)).toEqual(['scroll', 'click']);
  });
});

describe('RecorderAggregator — reset', () => {
  it('reset drops pending buffers without emitting', () => {
    const agg = new RecorderAggregator();
    agg.feed(kd({ keycode: 30, char: 'a' }), CTX);
    agg.reset();
    expect(agg.poll(CTX, ts + TYPE_SILENCE_FLUSH_MS)).toEqual([]);
    expect(agg.finish(CTX)).toEqual([]);
  });
});
