import '@testing-library/jest-dom/vitest'
import { config } from 'dotenv'
import { resolve } from 'path'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Load .env for tests
config({ path: resolve(__dirname, '.env') })

// Isolate the memory system log. Production writeSystemLog defaults to
// ~/.duya/memory-system-log and several tests exercise real pipeline code
// (runCurationCycle, memory-worker tick) without threading a rootDir —
// redirect the default root to a per-run temp dir so tests can never
// append fake events to the production JSONL.
if (!process.env.DUYA_MEMORY_LOG_ROOT) {
  process.env.DUYA_MEMORY_LOG_ROOT = mkdtempSync(join(tmpdir(), 'duya-memory-log-test-'))
}
