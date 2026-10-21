import { config } from 'dotenv'
import { resolve } from 'path'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Load .env for tests
config({ path: resolve(__dirname, '.env') })

// The DOM matchers are loaded ONLY where a DOM exists.
//
// `@testing-library/jest-dom/vitest` is a global `expect.extend` of DOM
// assertions (`toBeInTheDocument`, `toHaveTextContent`, ...). Only a file
// that declares `// @vitest-environment jsdom` can use them: the matchers
// assert on an `Element`, and 1,059 of the suite's 1,177 files run in the
// node environment with no DOM to assert on.
//
// Importing it unconditionally made every file in the suite pay for it.
// Measured on 2026-10-22 with 30 probe files in the node environment, same
// machine, same worker count:
//
//   with the import     setup 1.69s   collect 496ms   total 3.45s
//   without it          setup 0.32s   collect 300ms   total 2.68s
//
// That is ~52ms of fixed cost per file, on a suite of 1,177 files: about 55s
// of CPU, or ~27s of wall clock at the two workers CI uses. The setup file
// runs once per file, so the cost is per file and not per suite.
//
// The condition is the presence of a DOM, not the presence of a file name:
// `document` exists in the jsdom environment and does not exist in the node
// environment, and the setup file runs before the test file is imported, so
// nothing a test file does can change the answer.
//
// If a node-environment file ever needs a DOM matcher, it fails loudly with
// "toBeInTheDocument is not a function" rather than silently asserting
// nothing. That is the intended failure mode: the file needs a jsdom
// environment, and the fix is to say so.
if (typeof globalThis.document !== 'undefined' && typeof globalThis.window !== 'undefined') {
  await import('@testing-library/jest-dom/vitest')
}

// Isolate the memory system log. Production writeSystemLog defaults to
// ~/.duya/memory-system-log and several tests exercise real pipeline code
// (runCurationCycle, memory-worker tick) without threading a rootDir —
// redirect the default root to a per-run temp dir so tests can never
// append fake events to the production JSONL.
if (!process.env.DUYA_MEMORY_LOG_ROOT) {
  process.env.DUYA_MEMORY_LOG_ROOT = mkdtempSync(join(tmpdir(), 'duya-memory-log-test-'))
}
