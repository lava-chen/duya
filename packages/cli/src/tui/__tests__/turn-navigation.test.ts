/**
 * Turn navigation: the prompt anchors and the viewport-relative jumps.
 *
 * The properties worth pinning: a landed anchor is never its own jump target
 * (pressing Alt+Down twice walks forward two prompts, not zero then one),
 * anchors follow the RENDERED document (profile filtering included), and the
 * chords the feature binds are chords the keymap can actually deliver.
 */

import { describe, expect, it } from 'vitest';

import { SceneCanvas } from '../core/component.js';
import { DARK_THEME_TAGS } from '../theme.js';
import { toBlessedKeys } from '../keymap.js';
import { TranscriptPane } from '../components/transcript-pane.js';
import { TranscriptModel } from '../blocks.js';
import { TranscriptRenderer } from '../transcript-cache.js';
import {
  nextTurnAnchor,
  previousTurnAnchor,
  type TurnAnchor,
} from '../turn-navigation.js';

const ANCHORS: readonly TurnAnchor[] = [
  { blockId: 'a', line: 0 },
  { blockId: 'b', line: 20 },
  { blockId: 'c', line: 40 },
];

describe('previousTurnAnchor', () => {
  it('picks the last anchor strictly above the viewport top', () => {
    expect(previousTurnAnchor(ANCHORS, 30)?.blockId).toBe('b');
    expect(previousTurnAnchor(ANCHORS, 41)?.blockId).toBe('c');
  });

  it('sitting on an anchor moves to the one before it, never to itself', () => {
    // Landed on `b`: the viewport top is its line minus the context rows.
    expect(previousTurnAnchor(ANCHORS, 18)?.blockId).toBe('a');
  });

  it('answers null at the top of the document', () => {
    expect(previousTurnAnchor(ANCHORS, 0)).toBeNull();
    expect(previousTurnAnchor([], 10)).toBeNull();
  });
});

describe('nextTurnAnchor', () => {
  it('picks the first anchor beyond the context rows below the top', () => {
    expect(nextTurnAnchor(ANCHORS, 0, 2)?.blockId).toBe('b');
    expect(nextTurnAnchor(ANCHORS, 18, 2)?.blockId).toBe('c');
  });

  it('a landed anchor is not its own next target', () => {
    // Landed on `b` (scrollTop = 18): the next jump must reach `c`, not stay.
    expect(nextTurnAnchor(ANCHORS, 18, 2)?.blockId).toBe('c');
    // But a prompt only two rows below the top IS reachable — the slack is
    // exactly the landing offset, nothing more.
    expect(nextTurnAnchor(ANCHORS, 17, 2)?.blockId).toBe('b');
  });

  it('answers null past the last prompt', () => {
    expect(nextTurnAnchor(ANCHORS, 39, 2)).toBeNull();
    expect(nextTurnAnchor([], 0, 2)).toBeNull();
  });
});

describe('TranscriptPane turnAnchors', () => {
  function paneWithTranscript(): TranscriptPane {
    const model = new TranscriptModel();
    const applyText = (text: string, id: string): void => {
      model.apply({ type: 'text_delta', data: { content: text, messageId: id, index: 0 } });
      model.apply({ type: 'text', data: { content: text, messageId: id, index: 0 } });
    };
    // Two user prompts with an assistant reply between them: the anchors are
    // the prompts, not the replies.
    model.addUser('first prompt');
    applyText('assistant reply one', 'm1');
    model.addUser('second prompt');
    applyText('assistant reply two', 'm2');
    const pane = new TranscriptPane({
      renderer: new TranscriptRenderer(),
      model,
      options: { expanded: true, showToolResults: true, toolResultLines: 8, theme: DARK_THEME_TAGS, renderer: 'own' },
      scrollTop: 0,
      following: true,
    });
    return pane;
  }

  it('lands on the rendered lines of user blocks, ids attached', () => {
    const pane = paneWithTranscript();
    const anchors = pane.turnAnchors(80);
    expect(anchors).toHaveLength(2);
    expect(anchors[0]?.line).toBe(0); // the first prompt opens the document
    expect(anchors[1]?.line).toBeGreaterThan(anchors[0]!.line);
    // Each anchor sits on a line that renders the prompt itself.
    const lines = pane.lines(80);
    const second = lines[anchors[1]!.line] ?? '';
    expect(second).toContain('second prompt');
  });

  it('memoises on the document key', () => {
    const pane = paneWithTranscript();
    const first = pane.turnAnchors(80);
    expect(pane.turnAnchors(80)).toBe(first);
  });
});

describe('the chords the feature binds', () => {
  it('Alt+Up / Alt+Down convert to key names the own parser delivers', () => {
    expect(toBlessedKeys(['Alt+Up'])).toEqual(['M-up']);
    expect(toBlessedKeys(['Alt+Down'])).toEqual(['M-down']);
  });
});
