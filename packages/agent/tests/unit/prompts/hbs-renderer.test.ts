/**
 * Handlebars renderer + asset loader tests — Plan 550.
 *
 * Exercises the renderer's compile cache, conditional rendering, custom
 * helpers, and frontmatter parsing. The asset loader is exercised through
 * the renderer against fixture files written under a tmp dir.
 *
 * @see docs/exec-plans/active/550-prompt-hbs-and-agent-decomposition.md
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  HbsPromptRenderer,
  parseFrontmatter,
} from '../../../src/prompts/hbs/index.js';

describe('parseFrontmatter', () => {
  it('returns empty frontmatter when marker is absent', () => {
    const raw = 'no frontmatter here\n';
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter).toEqual({});
    expect(body).toBe(raw);
  });

  it('parses simple YAML key/value pairs', () => {
    const raw = '---\ncache: static\nid: identity\n---\nbody here';
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter).toEqual({ cache: 'static', id: 'identity' });
    expect(body).toBe('body here');
  });

  it('returns empty frontmatter when YAML is malformed', () => {
    // Truly malformed YAML — duplicate keys in a flow mapping cause the
    // yaml package to throw. Our loader must catch the throw so the body
    // is still usable.
    const raw = '---\n{a: 1, a: 2}\n---\nbody';
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter).toEqual({});
    expect(body).toBe('body');
  });

  it('accepts \\n line endings (LF and CRLF)', () => {
    const raw = '---\r\ncache: volatile\r\n---\r\nhello';
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter).toEqual({ cache: 'volatile' });
    expect(body).toBe('hello');
  });
});

describe('HbsPromptRenderer', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'duya-hbs-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('renders a static template with no conditionals', () => {
    writeFileSync(join(tmpRoot, 'static.hbs'), 'Hello, {{name}}!');
    const renderer = new HbsPromptRenderer({ assetsRoot: tmpRoot });
    const out = renderer.render('static.hbs', { name: 'mavis' });
    expect(out).toBe('Hello, mavis!');
  });

  it('renders {{#if}} blocks based on context flags', () => {
    // Block helpers keep the body whitespace as-is; we trim the rendered
    // output for the assertion so the test stays focused on the logic,
    // not handlebars' whitespace rules.
    writeFileSync(
      join(tmpRoot, 'gated.hbs'),
      [
        '{{#if features.delegation}}',
        'You may delegate.',
        '{{/if}}',
        '{{#if features.noSuch}}',
        'You may not.',
        '{{/if}}',
      ].join('\n'),
    );
    const renderer = new HbsPromptRenderer({ assetsRoot: tmpRoot });
    expect(
      renderer
        .render('gated.hbs', { features: { delegation: true, noSuch: false } })
        .trim(),
    ).toBe('You may delegate.');
    expect(
      renderer
        .render('gated.hbs', { features: { delegation: false, noSuch: false } })
        .trim(),
    ).toBe('');
  });

  it('uses the (and) and (or) helpers for two-arg boolean checks', () => {
    writeFileSync(
      join(tmpRoot, 'bool.hbs'),
      [
        '{{#if (and features.a features.b)}}both{{else}}not both{{/if}}',
        '|',
        '{{#if (or features.a features.c)}}at least one{{else}}none{{/if}}',
      ].join('\n'),
    );
    const renderer = new HbsPromptRenderer({ assetsRoot: tmpRoot });
    const out = renderer.render('bool.hbs', {
      features: { a: true, b: false, c: true },
    });
    // Strip the newlines that handlebars preserves between blocks but keep
    // the spaces inside the rendered text intact.
    expect(out.replace(/\n/g, '')).toBe('not both|at least one');
  });

  it('uses (eq) and (neq) helpers for strict equality', () => {
    writeFileSync(
      join(tmpRoot, 'eq.hbs'),
      '{{#if (eq mode "coding")}}code{{else}}other{{/if}}|{{#if (neq mode "coding")}}not code{{else}}code{{/if}}',
    );
    const renderer = new HbsPromptRenderer({ assetsRoot: tmpRoot });
    expect(renderer.render('eq.hbs', { mode: 'coding' })).toBe('code|code');
    expect(renderer.render('eq.hbs', { mode: 'plan' })).toBe('other|not code');
  });

  it('does not HTML-escape prompt content (markdown is verbatim)', () => {
    writeFileSync(join(tmpRoot, 'md.hbs'), 'See `code & more` for details.');
    const renderer = new HbsPromptRenderer({ assetsRoot: tmpRoot });
    const out = renderer.render('md.hbs', {});
    expect(out).toBe('See `code & more` for details.');
  });

  it('caches compiled templates across calls', () => {
    writeFileSync(join(tmpRoot, 'cache.hbs'), 'v1: {{x}}');
    const renderer = new HbsPromptRenderer({ assetsRoot: tmpRoot });
    renderer.render('cache.hbs', { x: 'a' });
    renderer.render('cache.hbs', { x: 'b' });
    renderer.render('cache.hbs', { x: 'c' });
    expect(renderer.cacheSize()).toBe(1);
    expect(renderer.cacheHits()).toBe(2);
    expect(renderer.cacheMisses()).toBe(1);
  });

  it('invalidate() drops the entire cache', () => {
    writeFileSync(join(tmpRoot, 'inv.hbs'), 'first');
    const renderer = new HbsPromptRenderer({ assetsRoot: tmpRoot });
    renderer.render('inv.hbs', {});
    expect(renderer.cacheSize()).toBe(1);
    renderer.invalidate();
    expect(renderer.cacheSize()).toBe(0);
  });

  it('invalidateOne() drops a single entry', () => {
    writeFileSync(join(tmpRoot, 'one.hbs'), 'one');
    writeFileSync(join(tmpRoot, 'two.hbs'), 'two');
    const renderer = new HbsPromptRenderer({ assetsRoot: tmpRoot });
    renderer.render('one.hbs', {});
    renderer.render('two.hbs', {});
    expect(renderer.cacheSize()).toBe(2);
    renderer.invalidateOne('one.hbs');
    expect(renderer.cacheSize()).toBe(1);
  });

  it('parses frontmatter and exposes it via frontmatterFor()', () => {
    writeFileSync(
      join(tmpRoot, 'fm.hbs'),
      '---\ncache: volatile\nid: fm-section\n---\nbody {{x}}',
    );
    const renderer = new HbsPromptRenderer({ assetsRoot: tmpRoot });
    renderer.render('fm.hbs', { x: 1 });
    const fm = renderer.frontmatterFor('fm.hbs');
    expect(fm).toEqual({ cache: 'volatile', id: 'fm-section' });
  });

  it('throws on undefined context keys (strict mode)', () => {
    writeFileSync(join(tmpRoot, 'strict.hbs'), 'value={{missing}}');
    const renderer = new HbsPromptRenderer({ assetsRoot: tmpRoot });
    expect(() => renderer.render('strict.hbs', {})).toThrow();
  });

  it('registers custom partials at construction', () => {
    writeFileSync(
      join(tmpRoot, 'with-partial.hbs'),
      'before {{> greeting }} after',
    );
    const renderer = new HbsPromptRenderer({
      assetsRoot: tmpRoot,
      partials: { greeting: 'hello {{name}}' },
    });
    expect(renderer.render('with-partial.hbs', { name: 'world' })).toBe(
      'before hello world after',
    );
  });

  it('registers custom helpers that override defaults', () => {
    writeFileSync(join(tmpRoot, 'custom.hbs'), '{{#if (eq mode "x")}}hit{{/if}}');
    const renderer = new HbsPromptRenderer({
      assetsRoot: tmpRoot,
      helpers: {
        eq: () => true, // always truthy
      },
    });
    expect(renderer.render('custom.hbs', { mode: 'y' })).toBe('hit');
  });
});