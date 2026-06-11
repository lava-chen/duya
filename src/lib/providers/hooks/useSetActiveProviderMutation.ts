/**
 * @deprecated Use useSetDefaultProviderMutation. The single-active
 * concept is gone; setting the default is a soft preference, not a
 * lock. This file is a thin shim that re-exports the new hook.
 * Will be removed once all callers migrate.
 */
export {
  useSetDefaultProviderMutation as useSetActiveProviderMutation,
  useSetDefaultWithCascadeMutation as useActivateProviderMutation,
} from './useSetDefaultProviderMutation';
