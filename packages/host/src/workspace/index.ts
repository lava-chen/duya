/**
 * Workspace layer: checkout provider, ownership and fail-closed reclamation.
 *
 * Public surface is intentionally narrow — `CheckoutProvider` plus the typed
 * errors its implementations raise. The lower-level helpers are exported
 * because the removal path and the tests need to call them directly, not
 * because they are a second public API.
 */

export type {
  CheckoutObserved,
  CheckoutOwner,
  CheckoutProvider,
  CheckoutRetainReason,
  CheckoutRoot,
} from './types.js';

export { CheckoutError, CheckoutOwnerError } from './errors.js';
export type { CheckoutErrorCode, CheckoutOwnerErrorCode } from './errors.js';

export { createCheckoutProvider, GitCheckoutProvider } from './checkout-provider.js';
export type { CheckoutProviderPorts } from './checkout-provider.js';
export { ExecutionLocationError, ExecutionLocationFence } from './execution-location-fence.js';
export type { ExecutionLocationDenial, ExecutionLocationErrorCode, ExecutionLocationLease, ExecutionLocationSnapshot, ExecutionLocationSwitch } from './execution-location-fence.js';

export { bindOwner, clearOwner, ownerPath, readOwner } from './checkout-metadata.js';
export type { BindOwnerOptions, OwnerRead } from './checkout-metadata.js';

export { evaluateReclaim, reclaimCheckout } from './worktree-removal.js';
export type { ReclaimInputs, ReclaimVerdict } from './worktree-removal.js';

export { inspectRegistration, parseWorktreeList, sourceRootFromCommonDir, worktreeEntries } from './registration.js';
export type { Registration, WorktreeEntry } from './registration.js';

export { allocateCheckoutName, managedRootFor, resolveCheckoutDataRoot, slugifyWorktreeName } from './paths.js';
export { describeGitFailure, git, gitOrNull, gitPathAbsolute } from './git.js';
