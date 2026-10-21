export {
  createHostShellCommandRuntimePorts,
  MANAGED_BASH_NOTIFICATION_TAIL_CHARS,
  MANAGED_BASH_RESULT_READ_BYTES,
  readOutputTail,
  startManagedShell,
  type ManagedBashCompletion,
  type ManagedBashHandle,
  type ManagedBashStatus,
  type ManagedShellDependencies,
  type ManagedShellTaskRegistryPort,
  type StartManagedBashParams,
} from './managed-shell.js';
export {
  BashTaskRegistry,
  getBashTaskRegistry,
  resetBashTaskRegistry,
  type AnyChangeListener,
  type BashBackgroundTask,
  type BashTaskProgress,
  type BashTaskStatus,
  type ProgressListener,
} from './task-registry.js';
export {
  BashTaskStore,
  getBashTaskStore,
  resetBashTaskStore,
  type BashTaskStoreOptions,
} from './task-store.js';
export {
  getManagedShellDataRoot,
  getManagedShellOutputDirectory,
} from './paths.js';
export {
  buildShellTaskNotificationXml,
  sendHostShellNotification,
  type ManagedShellNotificationLogger,
  type ShellTaskNotification,
} from './notifications.js';
export {
  killProcessTree,
  type KillProcessTreeOptions,
  type KillProcessTreeResult,
  type ProcessTreeKillLogger,
} from './process-tree-kill.js';
