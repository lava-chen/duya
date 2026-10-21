import { describe, expect, it } from 'vitest';
import { workspaceExportTargets as targets } from './workspace-exports.mjs';

describe('workspace export target resolution', () => {
  it('resolves relocated exact subpaths to their declared source targets', () => {
    expect(targets({ exports: { './worker-db-client': {
      types: './dist/worker-db-client.d.ts', import: './dist/worker-db-client.js',
    } } }, './worker-db-client')).toEqual([
      './dist/worker-db-client.d.ts', './dist/worker-db-client.js',
    ]);
  });

  it('preserves wildcard suffixes and nested captures', () => {
    expect(targets({ exports: { './skills/*.js': './dist/skills/*.js' } },
      './skills/nested/loader.js')).toEqual(['./dist/skills/nested/loader.js']);
    expect(targets({ exports: { './skills/*': './dist/skills/*.js' } }, './skills')).toEqual([]);
  });

  it('lets an exact null export block a broader wildcard', () => {
    expect(targets({ exports: { './*': './dist/*.js', './private': null } }, './private')).toEqual([]);
  });

  it('selects the most specific wildcard, including null exclusions', () => {
    const exports = {
      './*': './dist/general/*.js',
      './internal/*': null,
      './internal/public/*': './dist/approved/*.js',
    };
    expect(targets({ exports }, './internal/secret')).toEqual([]);
    expect(targets({ exports }, './internal/public/read')).toEqual(['./dist/approved/read.js']);
  });

  it('supports conditional root and array targets while ignoring unrelated conditions', () => {
    expect(targets({ exports: { browser: './browser.js', node: {
      import: ['./dist/index.js', './dist/fallback.js'],
    } } }, '.')).toEqual(['./dist/index.js', './dist/fallback.js']);
    expect(targets({ exports: './dist/index.js' }, './secret')).toEqual([]);
  });

  it('rejects private subpaths and invalid source escapes', () => {
    expect(targets({ exports: { '.': './dist/index.js' } }, './secret')).toEqual([]);
    for (const target of ['../secret.js', './dist/../secret.js', './node_modules/x.js']) {
      expect(targets({ exports: { './secret': target } }, './secret')).toEqual([]);
    }
    expect(targets({ main: './dist/index.js' }, '.')).toEqual(['./dist/index.js']);
    expect(targets({ main: './dist/index.js' }, './secret')).toEqual([]);
  });
});
