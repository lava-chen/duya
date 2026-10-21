import { homedir } from 'os';
import { dirname, join, resolve } from 'node:path';

export interface DataRootOptions {
  homeDirectory?: string;
  env?: Readonly<Record<string, string | undefined>>;
  args?: readonly string[];
}

export interface DatabasePathOptions {
  dataRoot?: string;
  databasePath?: string;
}

export interface DatabasePaths {
  mainDatabasePath: string;
  coreDatabasePath: string;
  memoryStateDatabasePath: string;
}

const TEST_NAMESPACE_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Resolve the shared Duya data root without requiring Electron. */
export function resolveDataRoot(options: DataRootOptions = {}): string {
  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  if (env.DUYA_TEST === '1') {
    const namespace = readTestNamespace(options.args ?? process.argv, env.DUYA_TEST_NAMESPACE);
    if (namespace) return join(homeDirectory, '.duya', 'test-namespaces', namespace);
  }
  const explicitRoot = env.DUYA_DATA_ROOT?.trim();
  if (explicitRoot) return resolve(explicitRoot);
  return join(homeDirectory, '.duya');
}

/** Resolve the three SQLite files that share one configured database directory. */
export function resolveDatabasePaths(options: DatabasePathOptions = {}): DatabasePaths {
  const mainDatabasePath = options.databasePath ?? join(options.dataRoot ?? resolveDataRoot(), 'duya-main.db');
  const databaseDirectory = dirname(mainDatabasePath);
  return {
    mainDatabasePath,
    coreDatabasePath: join(databaseDirectory, 'duya-core.db'),
    memoryStateDatabasePath: join(databaseDirectory, 'memory-state.db'),
  };
}

function readTestNamespace(args: readonly string[], envNamespace: string | undefined): string | null {
  for (const arg of args) {
    if (!arg.startsWith('--duya-namespace=')) continue;
    const namespace = arg.slice('--duya-namespace='.length);
    return namespace && TEST_NAMESPACE_PATTERN.test(namespace) ? namespace : null;
  }

  const namespaceFlagIndex = args.indexOf('--duya-namespace');
  if (namespaceFlagIndex >= 0) {
    const namespace = args[namespaceFlagIndex + 1];
    return namespace && TEST_NAMESPACE_PATTERN.test(namespace) ? namespace : null;
  }

  return envNamespace && TEST_NAMESPACE_PATTERN.test(envNamespace) ? envNamespace : null;
}
