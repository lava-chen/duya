/** Temporary adapter; Host owns the worker command loop and runtime assembly. */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startWorkerProcess, type WorkerProcessStartOptions } from '@duya/host/worker-process-entry';
import { workerProcessAssembly } from '@duya/cli/worker-services';
export * from '@duya/host/worker-process-entry';
export type AgentProcessStartOptions = Omit<WorkerProcessStartOptions, 'assembly'>;
export function startAgentProcess(options: AgentProcessStartOptions = {}): Promise<void> {
 return startWorkerProcess({ ...options, assembly: workerProcessAssembly });
}
function isProcessEntryPoint(): boolean {
  // `import.meta.url` must stay the literal expression below. esbuild's
  // `import.meta.url` define in scripts/build-agent-bundle.mjs (CJS output,
  // banner polyfill `pathToFileURL(__filename)`) only matches this exact
  // syntactic shape; the same constraint is documented on WorkerPool's
  // resolveDirname().
  const selfUrl = import.meta.url;
  const entryArg = process.argv[1];
  if (typeof selfUrl !== 'string' || selfUrl.length === 0 || !entryArg) {
    return false;
  }
  let selfPath: string;
  try {
    selfPath = fileURLToPath(selfUrl);
  } catch {
    return false;
  }
  const resolvedSelf = path.resolve(selfPath);
  const resolvedEntry = path.resolve(entryArg);
  // Windows paths compare case-insensitively: the parent's spelling of the
  // path is not guaranteed to match the child's.
  return process.platform === 'win32'
    ? resolvedSelf.toLowerCase() === resolvedEntry.toLowerCase()
    : resolvedSelf === resolvedEntry;
}


if (isProcessEntryPoint()) void startAgentProcess();
