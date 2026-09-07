// Plan 501 temp config: run DB-touching tests against a node-ABI
// better-sqlite3 COPY (node_modules/.bs3-node) while electron:dev holds the
// original .node locked. Delete when the ABI script can swap freely again.
import { defineConfig, mergeConfig } from 'vitest/config'
import baseConfig from './vitest.config.ts'
import path from 'path'
import { fileURLToPath } from 'url'

export default mergeConfig(
  baseConfig,
  defineConfig({
    resolve: {
      alias: [
        {
          find: /^better-sqlite3$/,
          replacement: path.resolve(
            path.dirname(fileURLToPath(import.meta.url)),
            'node_modules/.bs3-node',
          ),
        },
      ],
    },
  }),
)
