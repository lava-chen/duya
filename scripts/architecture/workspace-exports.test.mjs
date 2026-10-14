import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workspaceExportTargets as targets } from './workspace-exports.mjs';

test('relocated exact subpaths use their declared source target', () => {
  assert.deepEqual(targets({ exports: { './worker-db-client': {
    types: './dist/worker-db-client.d.ts', import: './dist/worker-db-client.js',
  } } }, './worker-db-client'), ['./dist/worker-db-client.d.ts', './dist/worker-db-client.js']);
});
test('wildcard suffixes and nested captures preserve the target mapping', () => {
  assert.deepEqual(targets({ exports: { './skills/*.js': './dist/skills/*.js' } },
    './skills/nested/loader.js'), ['./dist/skills/nested/loader.js']);
  assert.deepEqual(targets({ exports: { './skills/*': './dist/skills/*.js' } },
    './skills'), []);
});
test('exact null blocks a broader wildcard', () => {
  assert.deepEqual(targets({ exports: { './*': './dist/*.js', './private': null } }, './private'), []);
});
test('the most specific wildcard wins, including null exclusions', () => {
  const exports = { './*': './dist/general/*.js', './internal/*': null,
    './internal/public/*': './dist/approved/*.js' };
  assert.deepEqual(targets({ exports }, './internal/secret'), []);
  assert.deepEqual(targets({ exports }, './internal/public/read'), ['./dist/approved/read.js']);
});
test('conditional root and array targets are supported, unrelated conditions ignored', () => {
  assert.deepEqual(targets({ exports: { browser: './browser.js', node: {
    import: ['./dist/index.js', './dist/fallback.js'],
  } } }, '.'), ['./dist/index.js', './dist/fallback.js']);
  assert.deepEqual(targets({ exports: './dist/index.js' }, './secret'), []);
});
test('private subpaths and invalid source escapes cannot be declared public', () => {
  assert.deepEqual(targets({ exports: { '.': './dist/index.js' } }, './secret'), []);
  for (const target of ['../secret.js', './dist/../secret.js', './node_modules/x.js']) {
    assert.deepEqual(targets({ exports: { './secret': target } }, './secret'), []);
  }
  assert.deepEqual(targets({ main: './dist/index.js' }, '.'), ['./dist/index.js']);
  assert.deepEqual(targets({ main: './dist/index.js' }, './secret'), []);
});
