/**
 * The layout contract of the workspace row.
 *
 * WHY THIS FILE EXISTS
 *
 * The workspace row (`.app-workspace-row`) is the flex row that holds the
 * chat column and the side panel, and it is the container the `@container`
 * queries of the workspace measure. Its rules lived in the former
 * conductor.css, and the removal of the canvas runtime (bcf0d946) took that
 * file with them: the row fell back to a plain block box, the chat column
 * grew with its transcript (115 000 px for a 1 000 message session), the
 * shell clipped the overflow, and the transcript could not be scrolled to
 * its end. Nothing failed, no test went red — the styles were simply gone.
 *
 * So the contract is asserted here, against the stylesheets themselves: the
 * classes the shell renders must be styled, and the workspace row must keep
 * the properties that make the chat column a bounded scroll container.
 *
 * The test reads the CSS source. It does not need a browser, a build or a
 * running app, which is the point: the guard has to be cheap enough to run on
 * every change of these files.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const STYLES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

interface ParsedRule {
  selector: string;
  declarations: Map<string, string>;
}

/**
 * A small CSS reader.
 *
 * It understands the three things these stylesheets are made of — rules,
 * declarations and at-rule blocks — and it flattens the at-rules, because
 * the contract below is about WHICH properties a selector carries, not about
 * the media query it sits in.
 */
function parseCss(source: string): ParsedRule[] {
  // The comments come out first: a comment in front of a selector would
  // otherwise become part of it.
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: ParsedRule[] = [];
  const stack: { prelude: string; declarations: Map<string, string> | null }[] = [];
  let buffer = '';

  for (let index = 0; index < css.length; index += 1) {
    const char = css[index];
    if (char === '{') {
      const prelude = buffer.trim();
      buffer = '';
      const parent = stack[stack.length - 1];
      stack.push({
        prelude,
        declarations: parent && parent.declarations === null ? null : new Map(),
      });
      continue;
    }
    if (char === '}') {
      const frame = stack.pop();
      buffer = '';
      if (frame && frame.declarations && !frame.prelude.startsWith('@')) {
        rules.push({ selector: frame.prelude, declarations: frame.declarations });
      }
      continue;
    }
    if (char === ';') {
      const frame = stack[stack.length - 1];
      if (frame && frame.declarations) {
        const separator = buffer.indexOf(':');
        if (separator > 0) {
          frame.declarations.set(
            buffer.slice(0, separator).trim().toLowerCase(),
            buffer.slice(separator + 1).trim(),
          );
        }
      }
      buffer = '';
      continue;
    }
    buffer += char;
  }
  return rules;
}

/** Every rule of every stylesheet of the UI package, keyed by selector. */
function loadRules(): Map<string, ParsedRule[]> {
  const bySelector = new Map<string, ParsedRule[]>();
  for (const file of readdirSync(STYLES_DIR).filter((name) => name.endsWith('.css'))) {
    const css = readFileSync(join(STYLES_DIR, file), 'utf8');
    for (const rule of parseCss(css)) {
      const selectors = rule.selector.split(',').map((part) => part.trim());
      for (const selector of selectors) {
        if (!selector) continue;
        const existing = bySelector.get(selector);
        if (existing) existing.push(rule);
        else bySelector.set(selector, [rule]);
      }
    }
  }
  return bySelector;
}

const RULES = loadRules();

/** The declarations of a selector, merged over every rule that carries it. */
function declarationsOf(selector: string): Map<string, string> {
  const merged = new Map<string, string>();
  for (const rule of RULES.get(selector) ?? []) {
    for (const [property, value] of rule.declarations) merged.set(property, value);
  }
  return merged;
}

describe('the workspace row layout contract', () => {
  it('keeps the workspace row a bounded flex row', () => {
    const declarations = declarationsOf('.app-workspace-row');
    expect(declarations.size).toBeGreaterThan(0);
    // A block box grows with its transcript: the chat column stops being a
    // scroll container and the shell clips the rest of the conversation.
    expect(declarations.get('display')).toBe('flex');
    // The row has to be allowed to shrink below its content height.
    expect(declarations.get('min-height')).toBe('0');
    expect(declarations.get('overflow')).toBe('hidden');
    expect(declarations.get('flex')).toBe('1 1 auto');
    // The panel overlay is positioned against this box.
    expect(declarations.get('position')).toBe('relative');
  });

  it('keeps the workspace row a container the @container queries can measure', () => {
    // Without this, every `@container` rule of the workspace (the floating
    // side panel at 719px and 879px, the code review tiers at 720/864/1280px)
    // silently stops matching.
    expect(declarationsOf('.app-workspace-row').get('container-type')).toBe('inline-size');
  });

  it('keeps the expanded panel overlay rules', () => {
    const expanded = declarationsOf('.panel-zone.panel-zone-expanded');
    expect(expanded.get('position')).toBe('absolute');
    expect(expanded.get('inset')).toBe('0');
    expect(expanded.get('z-index')).toBe('40');
    expect(declarationsOf('.panel-zone-expanded .sidebar-panel-inner').get('width')).toBe(
      '100% !important',
    );
  });

  it('styles every structural class the app shell renders', () => {
    // These are the boxes the shell composes. A stylesheet that stops
    // styling one of them does not fail loudly — it just changes the layout,
    // which is how the scroll container was lost in the first place.
    const structural = [
      '.app-shell-root',
      '.app-body',
      '.app-content-column',
      '.app-workspace-row',
      '.app-main-wrapper',
      '.app-main',
      '.app-main-inner',
      '.panel-zone',
    ];
    const unstyled = structural.filter((selector) => declarationsOf(selector).size === 0);
    expect(unstyled).toEqual([]);
  });
});
