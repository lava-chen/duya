import { startWorkerProcess } from '@duya/host/worker-process-entry';
import { workerProcessAssembly } from './worker-services.js';
void startWorkerProcess({ assembly: workerProcessAssembly });
