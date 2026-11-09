// TEMPORARY local verification config (not committed).
// The worktree's node_modules is a junction to the primary checkout, so
// vite's fs.allow never covers <primary>/packages/ai and `@duya/ai` fails
// to resolve. This alias points it at THIS worktree's source so the
// pre-existing chat suites can actually run.
import { defineConfig, mergeConfig } from 'vitest/config';
import path from 'node:path';
import base from './vitest.config';

const AI_SRC = path.resolve(__dirname, 'packages/ai/src');

export default mergeConfig(
  base,
  defineConfig({
    resolve: {
      alias: [
        { find: /^@duya\/ai$/, replacement: path.join(AI_SRC, 'index.ts') },
        { find: /^@duya\/ai\/(.*)$/, replacement: path.join(AI_SRC, '$1') },
      ],
    },
  }),
);
