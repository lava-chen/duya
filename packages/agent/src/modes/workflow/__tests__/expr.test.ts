/**
 * expr.test.ts — restricted expression language (plan 415 §4.1 / 552 §4.2).
 *
 * Covers: the four legal classes (refs / comparisons / logic / aggregates),
 * the decision-answers scope, template interpolation (exact-hole type
 * preservation), reference extraction for static validation, and the
 * determinism stance (no clock / random / function-call constructs).
 */

import { describe, it, expect } from 'vitest';
import {
  parseExpr,
  evaluateExpr,
  evaluateNode,
  exprRefRoots,
  templateRefRoots,
  interpolate,
  interpolateDeep,
  ExprError,
  NOT_FOUND,
  type ExprScope,
} from '../index.js';

function scopeOf(values: Record<string, unknown>): ExprScope {
  return {
    resolve(path) {
      let cur: unknown = values;
      for (const seg of path) {
        if (cur && typeof cur === 'object' && seg in (cur as Record<string, unknown>)) {
          cur = (cur as Record<string, unknown>)[seg];
        } else {
          return NOT_FOUND;
        }
      }
      return cur;
    },
  };
}

describe('refs', () => {
  it('resolves dotted references through the scope', () => {
    const s = scopeOf({ export: { output: { rows: 7 } }, params: { invoice_id: 'INV-1' } });
    expect(evaluateExpr('export.output.rows', s)).toBe(7);
    expect(evaluateExpr('params.invoice_id', s)).toBe('INV-1');
  });

  it('throws on unresolvable references (fail loud, never silent false)', () => {
    const s = scopeOf({});
    expect(() => evaluateExpr('missing.output', s)).toThrow(ExprError);
  });

  it('supports lifecycle shortcuts as ordinary scope keys', () => {
    const s = scopeOf({ verify: { succeeded: true, failed: false, count: 3 } });
    expect(evaluateExpr('verify.succeeded', s)).toBe(true);
    expect(evaluateExpr('verify.failed', s)).toBe(false);
    expect(evaluateExpr('verify.count', s)).toBe(3);
  });
});

describe('comparisons and logic', () => {
  const s = scopeOf({ a: { p: 0.7, route: 'billing' } });

  it('compares numbers and strings', () => {
    expect(evaluateExpr("a.route == 'billing'", s)).toBe(true);
    expect(evaluateExpr("a.route != 'tech'", s)).toBe(true);
    expect(evaluateExpr('a.p > 0.65', s)).toBe(true);
    expect(evaluateExpr('a.p >= 0.7', s)).toBe(true);
    expect(evaluateExpr('a.p < 0.5', s)).toBe(false);
  });

  it('refuses ordering across mismatched types (false, not coercion)', () => {
    expect(evaluateExpr("a.p > 'billing'", s)).toBe(false);
  });

  it('combines with && || !', () => {
    expect(evaluateExpr("a.route == 'billing' && a.p > 0.65", s)).toBe(true);
    expect(evaluateExpr("a.route == 'tech' || a.p > 0.65", s)).toBe(true);
    expect(evaluateExpr('!a.p > 0.65', s)).toBe(false);
    expect(evaluateExpr('!(a.p > 0.9)', s)).toBe(true);
  });

  it('is exactly the 552 example: decision answers in the when scope', () => {
    const decision = scopeOf({ 'route-ticket': { department: 'billing', urgent: 0.72 } });
    expect(evaluateExpr("route-ticket.department == 'billing' && route-ticket.urgent > 0.65", decision)).toBe(true);
  });

  it('parses parenthesized groups', () => {
    expect(evaluateExpr('(a.p > 0.9 || a.p < 0.1) && a.route == \'billing\'', s)).toBe(false);
  });
});

describe('aggregates over map results', () => {
  const s = scopeOf({
    work: { output: [true, false, true], count: 3 },
    empty: { output: [] },
  });

  it('any / all / count over arrays', () => {
    expect(evaluateExpr('any(work.output)', s)).toBe(true);
    expect(evaluateExpr('all(work.output)', s)).toBe(false);
    expect(evaluateExpr('count(work.output)', s)).toBe(3);
    expect(evaluateExpr('count(empty.output)', s)).toBe(0);
  });

  it('aggregates require arrays', () => {
    expect(() => evaluateExpr('any(work.count)', s)).toThrow(ExprError);
  });
});

describe('illegal constructs', () => {
  it('rejects function calls beyond the three aggregates', () => {
    expect(() => parseExpr('fetch("http://x")')).toThrow(ExprError);
    expect(() => parseExpr('a.b.c()')).toThrow(ExprError);
  });

  it('rejects arbitrary code / clock / random shapes', () => {
    expect(() => parseExpr('new Date()')).toThrow(ExprError);
    expect(() => parseExpr('Math.random()')).toThrow(ExprError);
    expect(() => parseExpr('process.exit(1)')).toThrow(ExprError);
  });

  it('rejects illegal characters and unterminated strings', () => {
    expect(() => parseExpr('a.p; rm -rf')).toThrow(ExprError);
    expect(() => parseExpr("'unclosed")).toThrow(ExprError);
    expect(() => parseExpr('')).toThrow(ExprError);
  });
});

describe('template interpolation', () => {
  const s = scopeOf({ params: { invoice_id: 'INV-9', count: 2 }, node: { output: { rows: [1, 2] } } });

  it('preserves types for exact-hole templates', () => {
    expect(interpolate('${node.output}', s)).toEqual({ rows: [1, 2] });
    expect(interpolate('${params.count}', s)).toBe(2);
  });

  it('stringifies mixed templates', () => {
    expect(interpolate('invoice ${params.invoice_id} x${params.count}', s)).toBe('invoice INV-9 x2');
  });

  it('returns plain strings untouched', () => {
    expect(interpolate('no holes here', s)).toBe('no holes here');
  });

  it('throws inside holes (fail loud)', () => {
    expect(() => interpolate('${missing.ref}', s)).toThrow(ExprError);
  });

  it('interpolates deep structures', () => {
    const out = interpolateDeep({ rows: '${node.output}', label: 'n=${params.count}', keep: 5 }, s);
    expect(out).toEqual({ rows: { rows: [1, 2] }, label: 'n=2', keep: 5 });
  });
});

describe('reference extraction (static validation)', () => {
  it('collects ref roots from expressions', () => {
    expect(exprRefRoots("verify.failed > 0 && params.x == '1'")).toEqual(new Set(['verify', 'params']));
  });

  it('collects roots from template holes only', () => {
    expect(templateRefRoots('do ${a.b} and ${c}')).toEqual(new Set(['a', 'c']));
    expect(templateRefRoots('no holes')).toEqual(new Set());
  });

  it('evaluateNode matches evaluateExpr', () => {
    const s = scopeOf({ x: 1 });
    expect(evaluateNode(parseExpr('x == 1'), s)).toBe(true);
  });
});
