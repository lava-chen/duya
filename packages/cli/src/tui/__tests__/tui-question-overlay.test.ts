/**
 * The ask-user-question overlay: codex `request_user_input`, adapted.
 *
 * State-level tests, deliberately. The key routing through the real blessed app
 * is covered by `tui-question-flow.test.ts` (which drives the actual
 * `requestPermissionApproval` entrance); what this file pins is the QUESTION
 * semantics — cursor, multi-select, the fast-freeform notes buffer, the
 * unanswered confirmation, and the answer record the tool's Phase-2 retry
 * reads out of `pendingAnswers`.
 */

import { describe, expect, it } from 'vitest';
import {
  buildAnswer,
  NONE_OF_THE_ABOVE,
  parseQuestionInput,
  questionRows,
  QuestionAskState,
  type ParsedQuestion,
} from '../question-overlay.js';

/** One single-select question with the synthetic "None of the above" tail. */
const SINGLE = {
  questions: [
    {
      question: 'Which auth approach?',
      header: 'Auth',
      options: [
        { label: 'Session cookies', description: 'Server-rendered' },
        { label: 'JWT', description: 'Stateless' },
      ],
      multiSelect: false,
    },
  ],
};

/** Two single-select questions, for the advancing/submit paths. */
const PAIR = {
  questions: [
    { question: 'q1', options: [{ label: 'a' }, { label: 'b' }] },
    { question: 'q2', options: [{ label: 'c' }, { label: 'd' }] },
  ],
};

function state(input: unknown): QuestionAskState {
  return new QuestionAskState(parseQuestionInput(input) as ParsedQuestion[]);
}

describe('parseQuestionInput', () => {
  it('reads the canonical tool input', () => {
    const parsed = parseQuestionInput(SINGLE);
    expect(parsed).not.toBeNull();
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]?.question).toBe('Which auth approach?');
    expect(parsed?.[0]?.header).toBe('Auth');
    expect(parsed?.[0]?.options.map((o) => o.label)).toEqual(['Session cookies', 'JWT']);
    expect(parsed?.[0]?.multiSelect).toBe(false);
  });

  it('accepts options serialized as a JSON string', () => {
    const parsed = parseQuestionInput({
      questions: [{ question: 'q', options: '[{"label":"a"},{"label":"b"}]' }],
    });
    expect(parsed?.[0]?.options.map((o) => o.label)).toEqual(['a', 'b']);
  });

  it('rejects shapes that cannot render a questionnaire', () => {
    expect(parseQuestionInput(null)).toBeNull();
    expect(parseQuestionInput({})).toBeNull();
    expect(parseQuestionInput({ questions: [] })).toBeNull();
    // A single option is not a choice.
    expect(parseQuestionInput({ questions: [{ question: 'q', options: [{ label: 'only' }] }] })).toBeNull();
    // Five options exceeds the schema cap.
    expect(parseQuestionInput({
      questions: [{ question: 'q', options: Array.from({ length: 5 }, (_, i) => ({ label: `o${i}` })) }],
    })).toBeNull();
    // A question with no text is not a question.
    expect(parseQuestionInput({ questions: [{ options: [{ label: 'a' }, { label: 'b' }] }] })).toBeNull();
    // Malformed JSON string.
    expect(parseQuestionInput({ questions: [{ question: 'q', options: 'not json' }] })).toBeNull();
  });
});

describe('questionRows / buildAnswer', () => {
  const question = parseQuestionInput(SINGLE)?.[0] as ParsedQuestion;

  it('appends the synthetic None of the above tail', () => {
    const rows = questionRows(question);
    expect(rows).toHaveLength(3);
    expect(rows[2]?.label).toBe(NONE_OF_THE_ABOVE.label);
  });

  it('joins multi-select labels and appends notes', () => {
    expect(buildAnswer(question, new Set([0, 1]), '')).toBe('Session cookies, JWT');
    expect(buildAnswer(question, new Set([1]), 'prefer rotating')).toBe('JWT (prefer rotating)');
  });

  it('treats notes alone as a freeform answer', () => {
    expect(buildAnswer(question, new Set(), '  neither  ')).toBe('neither');
  });

  it('returns undefined when nothing was chosen', () => {
    expect(buildAnswer(question, new Set(), '   ')).toBeUndefined();
  });

  it('accepts the synthetic tail as a real answer', () => {
    expect(buildAnswer(question, new Set([2]), '')).toBe(NONE_OF_THE_ABOVE.label);
  });
});

describe('QuestionAskState', () => {
  it('quick-picks and advances on a single-select question', () => {
    const ask = state(PAIR);
    expect(ask.currentIndex).toBe(0);
    ask.handleKey({ name: '2' }); // q1 → "b", advance
    expect(ask.currentIndex).toBe(1);
    expect(ask.readyToSubmit).toBe(false);
    ask.handleKey({ name: '1' }); // q2 → "c", submit
    expect(ask.readyToSubmit).toBe(true);
    expect(ask.finish()).toEqual({ action: 'submit', answers: { q1: 'b', q2: 'c' } });
  });

  it('never submits on navigation alone', () => {
    // Regression: on a fully-answered last question every key used to look
    // like a submit. Navigation must not record a selection either.
    const ask = state(PAIR);
    ask.handleKey({ name: '1' }); // q1 → "a", advance
    expect(ask.currentIndex).toBe(1);
    ask.handleKey({ name: 'down' });
    ask.handleKey({ name: 'up' });
    ask.handleKey({ name: 'tab' });
    ask.handleKey({ name: 'tab' });
    expect(ask.readyToSubmit).toBe(false);
  });

  it('toggles multi-select with space and answers with Enter', () => {
    const ask = state({
      questions: [{ question: 'q', options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }], multiSelect: true }],
    });
    ask.handleKey({ name: 'space' }); // select a
    ask.handleKey({ name: 'down' });
    ask.handleKey({ name: 'space' }); // select b
    expect(ask.readyToSubmit).toBe(false);
    ask.handleKey({ name: 'return' });
    expect(ask.finish()).toEqual({ action: 'submit', answers: { q: 'a, b' } });
  });

  it('types into notes when a printable key arrives', () => {
    const ask = state(SINGLE);
    ask.handleKey({ ch: 'j' }); // `j` is a letter here, not vim-down
    ask.handleKey({ ch: 'w' });
    ask.handleKey({ ch: 't' });
    expect(ask.render()).toContain('jwt');
  });

  it('keeps digits literal once the notes buffer has focus', () => {
    const ask = state(SINGLE);
    ask.handleKey({ ch: 'a' }); // typing focuses notes
    ask.handleKey({ name: '1', ch: '1' }); // a digit IN A NOTE, not a quick-pick
    ask.handleKey({ name: 'return' });
    expect(ask.finish()).toEqual({ action: 'submit', answers: { 'Which auth approach?': 'a1' } });
  });

  it('backspaces notes', () => {
    const ask = state(SINGLE);
    ask.handleKey({ ch: 'a' });
    ask.handleKey({ ch: 'b' });
    ask.handleKey({ name: 'backspace' });
    ask.handleKey({ name: 'return' });
    expect(ask.finish()).toEqual({ action: 'submit', answers: { 'Which auth approach?': 'a' } });
  });

  it('asks before submitting a skipped question, and Go back returns to it', () => {
    const ask = state(PAIR);
    ask.handleKey({ name: '1' }); // q1 → "a", advance
    // Skip q2 by committing on the synthetic None of the above row — the only
    // deliberate way to leave a question blank.
    ask.handleKey({ name: 'down' });
    ask.handleKey({ name: 'down' });
    ask.handleKey({ name: 'return' });
    expect(ask.isConfirming).toBe(true);
    expect(ask.readyToSubmit).toBe(false);
    expect(ask.render()).toContain('would submit without an answer');

    // Esc on the confirm panel goes back, it does not cancel.
    ask.handleKey({ name: 'escape' });
    expect(ask.isConfirming).toBe(false);
    expect(ask.currentIndex).toBe(1);

    // Go back landed on the unanswered question; answering it submits all.
    ask.handleKey({ name: '1' });
    expect(ask.readyToSubmit).toBe(true);
    expect(ask.finish()).toEqual({ action: 'submit', answers: { q1: 'a', q2: 'c' } });
  });

  it('Proceed submits the partial answer set', () => {
    const ask = state(PAIR);
    ask.handleKey({ name: '1' }); // q1 → "a"
    ask.handleKey({ name: 'down' });
    ask.handleKey({ name: 'down' });
    ask.handleKey({ name: 'return' }); // skip q2 → confirm panel
    expect(ask.isConfirming).toBe(true);

    ask.handleKey({ name: 'down' }); // Proceed
    ask.handleKey({ name: 'return' });
    expect(ask.readyToSubmit).toBe(true);
    expect(ask.finish()).toEqual({ action: 'submit', answers: { q1: 'a' } });
  });

  it('renders the progress head, the question and the options', () => {
    const body = state(SINGLE).render();
    expect(body).toContain('Question 1/1');
    expect(body).toContain('[Auth]');
    expect(body).toContain('Which auth approach?');
    expect(body).toContain('1. Session cookies');
    expect(body).toContain('None of the above');
  });

  it('escapes model-authored text so it cannot paint the overlay', () => {
    const ask = state({
      questions: [{ question: 'pick {red-fg}one', options: [{ label: '{bold}a' }, { label: 'b' }] }],
    });
    const body = ask.render();
    // Every model-authored `{` is escaped, so no live tag survives: an
    // unescaped `{red-fg}` would recolour everything after it.
    expect(body).toContain('pick \\{red-fg}one');
    expect(body).toContain('1. \\{bold}a');
    expect(body).not.toMatch(/(?<!\\)\{red-fg\}/u);
  });
});
