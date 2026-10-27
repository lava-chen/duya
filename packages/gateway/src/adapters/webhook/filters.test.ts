import { describe, expect, it } from 'vitest';

import { defaultPrompt, matchesFilters, renderTemplate } from './filters.js';

const payload = {
  action: 'opened',
  pull_request: { draft: false, number: 42, labels: ['bug', 'ui'] },
  sender: { login: 'alice', type: 'User' },
};

const headers = { 'x-github-event': 'pull_request' };

describe('matchesFilters', () => {
  it('accepts everything when no filters are configured', () => {
    expect(matchesFilters(undefined, payload, headers)).toBe(true);
    expect(matchesFilters([], payload, headers)).toBe(true);
  });

  it('matches a scalar field', () => {
    expect(matchesFilters({ field: 'action', equals: 'opened' }, payload, headers)).toBe(true);
    expect(matchesFilters({ field: 'action', equals: 'closed' }, payload, headers)).toBe(false);
  });

  it('reads dotted paths into the payload', () => {
    expect(matchesFilters({ field: 'pull_request.number', equals: 42 }, payload, headers)).toBe(true);
    expect(matchesFilters({ field: 'pull_request.draft', equals: false }, payload, headers)).toBe(true);
  });

  it('reads headers with the headers. prefix', () => {
    expect(matchesFilters({ field: 'headers.x-github-event', equals: 'pull_request' }, payload, headers)).toBe(true);
    expect(matchesFilters({ field: 'headers.x-github-event', equals: 'push' }, payload, headers)).toBe(false);
  });

  it('ANDs an array of filters', () => {
    const filters = [
      { field: 'action', equals: 'opened' },
      { field: 'sender.type', equals: 'User' },
    ];
    expect(matchesFilters(filters, payload, headers)).toBe(true);
    expect(matchesFilters([...filters, { field: 'action', equals: 'x' }], payload, headers)).toBe(false);
  });

  it('supports all / any / not compositions', () => {
    expect(
      matchesFilters(
        { all: [{ field: 'action', equals: 'opened' }, { field: 'pull_request.draft', equals: false }] },
        payload,
        headers,
      ),
    ).toBe(true);
    expect(
      matchesFilters({ any: [{ field: 'action', equals: 'closed' }, { field: 'sender.login', equals: 'alice' }] }, payload, headers),
    ).toBe(true);
    expect(matchesFilters({ not: { field: 'sender.type', equals: 'Bot' } }, payload, headers)).toBe(true);
    expect(matchesFilters({ not: { field: 'sender.type', equals: 'User' } }, payload, headers)).toBe(false);
  });

  it('supports in / contains / regex / exists', () => {
    expect(matchesFilters({ field: 'action', in: ['opened', 'reopened'] }, payload, headers)).toBe(true);
    expect(matchesFilters({ field: 'pull_request.labels', contains: 'ui' }, payload, headers)).toBe(true);
    expect(matchesFilters({ field: 'sender.login', regex: '^ali' }, payload, headers)).toBe(true);
    expect(matchesFilters({ field: 'sender.login', exists: true }, payload, headers)).toBe(true);
    expect(matchesFilters({ field: 'missing.field', exists: false }, payload, headers)).toBe(true);
  });

  it('survives a malformed regex without throwing', () => {
    expect(matchesFilters({ field: 'sender.login', regex: '(' }, payload, headers)).toBe(false);
  });

  it('treats a bare field as a truthiness check', () => {
    expect(matchesFilters({ field: 'pull_request.number' }, payload, headers)).toBe(true);
    expect(matchesFilters({ field: 'nope' }, payload, headers)).toBe(false);
  });
});

describe('renderTemplate', () => {
  it('substitutes payload and header placeholders', () => {
    const rendered = renderTemplate('PR #{pull_request.number} by {sender.login} ({headers.x-github-event})', payload, headers);
    expect(rendered).toBe('PR #42 by alice (pull_request)');
  });

  it('leaves unknown placeholders visible instead of blanking them', () => {
    expect(renderTemplate('value={nope.nope}', payload, headers)).toBe('value={nope.nope}');
  });

  it('passes plain text through', () => {
    expect(renderTemplate('no placeholders', payload, headers)).toBe('no placeholders');
  });
});

describe('defaultPrompt', () => {
  it('wraps the payload in a fenced json block', () => {
    const prompt = defaultPrompt({ a: 1 });
    expect(prompt).toContain('```json');
    expect(prompt).toContain('"a": 1');
  });

  it('truncates huge payloads', () => {
    const prompt = defaultPrompt({ blob: 'x'.repeat(10_000) }, 200);
    expect(prompt).toContain('truncated');
    expect(prompt.length).toBeLessThan(500);
  });
});
