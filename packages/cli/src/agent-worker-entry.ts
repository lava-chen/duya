import { startWorkerProcess } from '@duya/host/worker-process-entry';
import { flushWorkerCompileCache } from '@duya/host/worker-limits';
import { workerProcessAssembly } from './worker-services.js';

// Node writes the compile cache to disk only when a process exits cleanly,
// and the Host kills its workers -- so without this flush the cache stays
// empty and every spawn recompiles the 4.6 MB bundle from scratch.
// Flushing here, while the worker is alive, is what makes the next spawn
// fast.
flushWorkerCompileCache();

void startWorkerProcess({ assembly: workerProcessAssembly });
