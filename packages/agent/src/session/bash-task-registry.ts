/** Compatibility re-export; Host owns background shell task state. */
export {
  BashTaskRegistry,
  getBashTaskRegistry,
  resetBashTaskRegistry,
  type AnyChangeListener,
  type BashBackgroundTask,
  type BashTaskProgress,
  type BashTaskStatus,
  type ProgressListener,
} from '@duya/host/managed-shell';
