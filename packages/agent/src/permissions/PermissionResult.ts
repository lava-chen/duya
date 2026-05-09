/**
 * Permission Result types for duya Agent
 * Adapted from claude-code-haha/src/utils/permissions/PermissionResult.ts
 */

export type {
  PermissionAllowDecision,
  PermissionAskDecision,
  PermissionDecision,
  PermissionDecisionReason,
  PermissionDenyDecision,
  PermissionMetadata,
  PermissionResult,
} from './types.js'

// Helper function to get the appropriate prose description for rule behavior
export function getRuleBehaviorDescription(
  permissionResult: 'allow' | 'deny' | 'ask' | 'passthrough',
): string {
  switch (permissionResult) {
    case 'allow':
      return 'allowed'
    case 'deny':
      return 'denied'
    default:
      return 'asked for confirmation for'
  }
}
