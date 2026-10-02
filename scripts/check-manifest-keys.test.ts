/**
 * check-manifest-keys.test.ts — regression tests for the duplicate-key gate.
 *
 * The scanner reads raw JSON text because JSON.parse keeps only the last
 * occurrence of a duplicate key. These tests pin the scoping rule that
 * matters in practice: a key repeated in the SAME object is a defect,
 * while the same key name in two different objects is ordinary JSON.
 */
import { describe, expect, it } from 'vitest';

import { findDuplicateKeys } from './check-manifest-keys.mjs';

describe('findDuplicateKeys', () => {
  it('reports nothing for a clean manifest', () => {
    const text = `{
  "name": "duya",
  "scripts": {
    "test": "vitest run",
    "build": "vite build"
  }
}`;
    expect(findDuplicateKeys(text)).toEqual([]);
  });

  it('reports a duplicate key in the same object', () => {
    const text = `{
  "scripts": {
    "pretest:coverage": "node scripts/check.mjs",
    "test": "vitest run",
    "pretest:coverage": "node scripts/abi.mjs node"
  }
}`;
    expect(findDuplicateKeys(text)).toEqual([{ value: 'pretest:coverage', line: 5, firstLine: 3 }]);
  });

  it('scopes duplicates per object, not per document', () => {
    // "version" legitimately appears in several independent sections.
    const text = `{
  "version": "1.0.0",
  "dependencies": { "pkg": { "version": "2.0.0" } },
  "peerDependencies": { "other": { "version": "3.0.0" } }
}`;
    expect(findDuplicateKeys(text)).toEqual([]);
  });

  it('does not confuse a value that equals a key name', () => {
    const text = `{
  "scripts": {
    "test": "test",
    "build": "build"
  }
}`;
    expect(findDuplicateKeys(text)).toEqual([]);
  });

  it('does not lose track of nesting through arrays of objects', () => {
    const text = `{
  "workspaces": [
    { "name": "a", "version": "1.0.0" },
    { "name": "b", "version": "2.0.0" }
  ],
  "scripts": { "a": "1", "a": "2" }
}`;
    const found = findDuplicateKeys(text);
    expect(found).toHaveLength(1);
    expect(found[0]?.value).toBe('a');
    expect(found[0]?.line).toBe(6);
  });

  it('is not derailed by escaped quotes inside values', () => {
    // The escaped quote must not be treated as a string terminator,
    // otherwise every later key position is misread.
    const text = `{
  "description": "a \\"quoted\\" value",
  "scripts": {
    "test": "vitest",
    "test": "vitest --coverage"
  }
}`;
    const found = findDuplicateKeys(text);
    expect(found).toEqual([{ value: 'test', line: 5, firstLine: 4 }]);
  });

  it('handles a BOM-prefixed manifest', () => {
    const text = '\uFEFF{\n  "a": 1,\n  "a": 2\n}';
    expect(findDuplicateKeys(text)).toEqual([{ value: 'a', line: 3, firstLine: 2 }]);
  });

  it('finds the exact duplicate that shipped in package.json', () => {
    // Regression: PR #95 added "pretest:coverage" for the test-collection
    // gate while an ABI hook of the same name already existed below it.
    // The later definition won, so the gate never ran.
    const text = `{
  "scripts": {
    "pretest:coverage": "node scripts/check-test-coverage.mjs",
    "check:test-coverage": "node scripts/check-test-coverage.mjs",
    "pretest:coverage": "node scripts/ensure-sqlite-abi.mjs node"
  }
}`;
    const found = findDuplicateKeys(text);
    expect(found).toHaveLength(1);
    expect(found[0]?.value).toBe('pretest:coverage');
    expect(found[0]?.firstLine).toBe(3);
    expect(found[0]?.line).toBe(5);
  });
});
