/**
 * @vitest-environment jsdom
 */

/**
 * PermissionPrompt - Unit Tests
 *
 * Tests the permission prompt UI component:
 * - Generic tool permission (allow/deny/allow_session buttons)
 * - ExitPlanMode rendering (approve/reject/feedback)
 * - AskUserQuestion rendering (multi-option questions)
 * - full_access mode skips rendering
 * - Resolved state display (allowed/denied/plan approved/rejected)
 * - Empty state (no pending permission and no resolved)
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { PermissionRequestEvent } from '@/types/stream';

// =============================================================================
// Mocks
// =============================================================================

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: vi.fn(() => ({
    t: vi.fn((key: string) => {
      const translations: Record<string, string> = {
        'permission.allowOnce': 'Allow Once',
        'permission.allowForSession': 'Allow for Session',
        'permission.deny': 'Deny',
        'permission.denied': 'Denied',
        'permission.allowed': 'Allowed',
        'permission.showMore': 'Show more',
        'permission.collapse': 'Collapse',
        'permission.planComplete': 'Plan Complete',
        'permission.planApproved': 'Plan Approved',
        'permission.planRejected': 'Plan Rejected',
        'permission.reject': 'Reject',
        'permission.approveExecute': 'Approve & Execute',
        'permission.provideFeedback': 'Provide feedback...',
        'permission.doThisInstead': 'Do This Instead',
        'permission.submit': 'Submit',
        'permission.answerSubmitted': 'Answer Submitted',
        'permission.requestedPermissions': 'Requested Permissions',
        'permission.other': 'Other',
        'permission.typeAnswer': 'Type your answer...',
      };
      return translations[key] || key;
    }),
    locale: 'zh',
  })),
}));

import { PermissionPrompt } from './PermissionPrompt';

// =============================================================================
// Helpers
// =============================================================================

function createMockPermission(overrides: Partial<PermissionRequestEvent> = {}): PermissionRequestEvent {
  return {
    id: 'perm-1',
    toolName: 'Bash',
    toolInput: { command: 'echo hello' },
    mode: 'generic',
    expiresAt: Date.now() + 300000,
    ...overrides,
  };
}

describe('PermissionPrompt', () => {
  // =========================================================================
  // Empty State
  // =========================================================================

  describe('empty state', () => {
    it('renders nothing when no pending permission and no resolved state', () => {
      const { container } = render(
        <PermissionPrompt
          pendingPermission={null}
          permissionResolved={null}
          onPermissionResponse={vi.fn()}
        />
      );
      expect(container.firstChild).toBeNull();
    });
  });

  // =========================================================================
  // Generic Tool Permission
  // =========================================================================

  describe('generic tool permission', () => {
    it('renders Allow Once, Allow for Session, and Deny buttons', () => {
      render(
        <PermissionPrompt
          pendingPermission={createMockPermission()}
          permissionResolved={null}
          onPermissionResponse={vi.fn()}
        />
      );

      expect(screen.getByText('Allow Once')).toBeTruthy();
      expect(screen.getByText('Allow for Session')).toBeTruthy();
      expect(screen.getByText('Deny')).toBeTruthy();
    });

    it('calls onPermissionResponse with "allow" when Allow Once is clicked', () => {
      const onResponse = vi.fn();
      render(
        <PermissionPrompt
          pendingPermission={createMockPermission()}
          permissionResolved={null}
          onPermissionResponse={onResponse}
        />
      );

      fireEvent.click(screen.getByText('Allow Once'));
      expect(onResponse).toHaveBeenCalledWith('allow');
    });

    it('calls onPermissionResponse with "allow_session" when Allow for Session is clicked', () => {
      const onResponse = vi.fn();
      render(
        <PermissionPrompt
          pendingPermission={createMockPermission()}
          permissionResolved={null}
          onPermissionResponse={onResponse}
        />
      );

      fireEvent.click(screen.getByText('Allow for Session'));
      expect(onResponse).toHaveBeenCalledWith('allow_session');
    });

    it('calls onPermissionResponse with "deny" when Deny is clicked', () => {
      const onResponse = vi.fn();
      render(
        <PermissionPrompt
          pendingPermission={createMockPermission()}
          permissionResolved={null}
          onPermissionResponse={onResponse}
        />
      );

      fireEvent.click(screen.getByText('Deny'));
      expect(onResponse).toHaveBeenCalledWith('deny');
    });
  });

  // =========================================================================
  // Resolved State
  // =========================================================================

  describe('resolved state', () => {
    it('shows "Allowed" when permission was allowed', () => {
      render(
        <PermissionPrompt
          pendingPermission={createMockPermission()}
          permissionResolved="allow"
          onPermissionResponse={vi.fn()}
        />
      );

      expect(screen.getByText('Allowed')).toBeTruthy();
    });

    it('shows "Denied" when permission was denied', () => {
      render(
        <PermissionPrompt
          pendingPermission={createMockPermission()}
          permissionResolved="deny"
          onPermissionResponse={vi.fn()}
        />
      );

      expect(screen.getByText('Denied')).toBeTruthy();
    });
  });

  // =========================================================================
  // full_access Mode
  // =========================================================================

  describe('full_access mode', () => {
    it('renders nothing when permissionProfile is "full_access"', () => {
      const onResponse = vi.fn();
      const { container } = render(
        <PermissionPrompt
          pendingPermission={createMockPermission()}
          permissionResolved={null}
          onPermissionResponse={onResponse}
          permissionProfile="full_access"
        />
      );

      expect(container.firstChild).toBeNull();
      expect(onResponse).not.toHaveBeenCalled();
    });

    it('does not trigger auto-approve when no pending permission', () => {
      const onResponse = vi.fn();
      render(
        <PermissionPrompt
          pendingPermission={null}
          permissionResolved={null}
          onPermissionResponse={onResponse}
          permissionProfile="full_access"
        />
      );

      expect(onResponse).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // ExitPlanMode
  // =========================================================================

  describe('ExitPlanMode', () => {
    it('renders Plan Complete with Approve & Execute button', () => {
      render(
        <PermissionPrompt
          pendingPermission={createMockPermission({
            toolName: 'ExitPlanMode',
            toolInput: { allowedPrompts: [] },
          })}
          permissionResolved={null}
          onPermissionResponse={vi.fn()}
        />
      );

      expect(screen.getByText('Plan Complete')).toBeTruthy();
      expect(screen.getByText('Approve & Execute')).toBeTruthy();
      expect(screen.getByText('Reject')).toBeTruthy();
    });

    it('shows "Plan Approved" when ExitPlanMode was allowed', () => {
      render(
        <PermissionPrompt
          pendingPermission={createMockPermission({
            toolName: 'ExitPlanMode',
            toolInput: { allowedPrompts: [] },
          })}
          permissionResolved="allow"
          onPermissionResponse={vi.fn()}
        />
      );

      expect(screen.getByText('Plan Approved')).toBeTruthy();
    });

    it('shows "Plan Rejected" when ExitPlanMode was denied', () => {
      render(
        <PermissionPrompt
          pendingPermission={createMockPermission({
            toolName: 'ExitPlanMode',
            toolInput: { allowedPrompts: [] },
          })}
          permissionResolved="deny"
          onPermissionResponse={vi.fn()}
        />
      );

      expect(screen.getByText('Plan Rejected')).toBeTruthy();
    });
  });

  // =========================================================================
  // AskUserQuestion
  // =========================================================================

  describe('AskUserQuestion', () => {
    it('renders question options', () => {
      render(
        <PermissionPrompt
          pendingPermission={createMockPermission({
            toolName: 'AskUserQuestion',
            toolInput: {
              questions: [
                {
                  question: 'Which option do you prefer?',
                  options: [
                    { label: 'Option A', description: 'First option' },
                    { label: 'Option B', description: 'Second option' },
                  ],
                  multiSelect: false,
                },
              ],
            },
          })}
          permissionResolved={null}
          onPermissionResponse={vi.fn()}
        />
      );

      expect(screen.getByText('Which option do you prefer?')).toBeTruthy();
      expect(screen.getByText('Option A')).toBeTruthy();
      expect(screen.getByText('Option B')).toBeTruthy();
      expect(screen.getByText('Submit')).toBeTruthy();
    });

    it('shows "Answer Submitted" when resolved', () => {
      render(
        <PermissionPrompt
          pendingPermission={createMockPermission({
            toolName: 'AskUserQuestion',
            toolInput: {
              questions: [
                {
                  question: 'What?',
                  options: [{ label: 'A', description: '' }],
                  multiSelect: false,
                },
              ],
            },
          })}
          permissionResolved="allow"
          onPermissionResponse={vi.fn()}
        />
      );

      expect(screen.getByText('Answer Submitted')).toBeTruthy();
    });
  });

  // =========================================================================
  // Tool-specific Summaries
  // =========================================================================

  describe('tool-specific summaries', () => {
    it('shows "Edit" header for Edit tool', () => {
      render(
        <PermissionPrompt
          pendingPermission={createMockPermission({
            toolName: 'Edit',
            toolInput: { file_path: '/src/app.ts' },
          })}
          permissionResolved={null}
          onPermissionResponse={vi.fn()}
        />
      );

      expect(screen.getByText('Edit')).toBeTruthy();
    });

    it('shows "Write" header for Write tool', () => {
      render(
        <PermissionPrompt
          pendingPermission={createMockPermission({
            toolName: 'Write',
            toolInput: { file_path: '/src/new.ts' },
          })}
          permissionResolved={null}
          onPermissionResponse={vi.fn()}
        />
      );

      expect(screen.getByText('Write')).toBeTruthy();
    });

    it('shows "Bash" header for Bash tool', () => {
      render(
        <PermissionPrompt
          pendingPermission={createMockPermission({
            toolName: 'Bash',
            toolInput: { command: 'ls -la' },
          })}
          permissionResolved={null}
          onPermissionResponse={vi.fn()}
        />
      );

      expect(screen.getByText('Bash')).toBeTruthy();
    });
  });

  // =========================================================================
  // Style alignment with SubAgentPanel
  // =========================================================================

  describe('style alignment', () => {
    it('wraps content in permission-prompt-wrapper + permission-prompt-panel', () => {
      const { container } = render(
        <PermissionPrompt
          pendingPermission={createMockPermission()}
          permissionResolved={null}
          onPermissionResponse={vi.fn()}
        />
      );
      const wrapper = container.querySelector('.permission-prompt-wrapper');
      const panel = container.querySelector('.permission-prompt-panel');
      expect(wrapper).toBeTruthy();
      expect(panel).toBeTruthy();
    });

    it('uses permission-prompt-btn variants on allow/deny actions', () => {
      render(
        <PermissionPrompt
          pendingPermission={createMockPermission()}
          permissionResolved={null}
          onPermissionResponse={vi.fn()}
        />
      );
      const deny = screen.getByText('Deny').closest('button')!;
      const allow = screen.getByText('Allow Once').closest('button')!;
      const allowSession = screen.getByText('Allow for Session').closest('button')!;
      expect(deny.className).toContain('permission-prompt-btn-danger');
      expect(allow.className).toContain('permission-prompt-btn');
      expect(allowSession.className).toContain('permission-prompt-btn-primary');
    });

    it('renders panel-header-toggle button with default collapsed aria state', () => {
      const { container } = render(
        <PermissionPrompt
          pendingPermission={createMockPermission()}
          permissionResolved={null}
          onPermissionResponse={vi.fn()}
        />
      );
      const toggle = container.querySelector('.permission-prompt-header-toggle') as HTMLButtonElement;
      expect(toggle).toBeTruthy();
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      // click to expand
      fireEvent.click(toggle);
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
    });

    it('AskUserQuestion header is expanded by default', () => {
      const { container } = render(
        <PermissionPrompt
          pendingPermission={createMockPermission({
            toolName: 'AskUserQuestion',
            toolInput: {
              questions: [
                { question: 'Q', options: [{ label: 'A' }], multiSelect: false },
              ],
            },
          })}
          permissionResolved={null}
          onPermissionResponse={vi.fn()}
        />
      );
      const toggle = container.querySelector('.permission-prompt-header-toggle') as HTMLButtonElement;
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
    });

    it('AskUserQuestion options toggle selected class on click', () => {
      render(
        <PermissionPrompt
          pendingPermission={createMockPermission({
            toolName: 'AskUserQuestion',
            toolInput: {
              questions: [
                {
                  question: 'Pick one',
                  options: [
                    { label: 'A', description: '' },
                    { label: 'B', description: '' },
                  ],
                  multiSelect: false,
                },
              ],
            },
          })}
          permissionResolved={null}
          onPermissionResponse={vi.fn()}
        />
      );
      const optionA = screen.getByText('A').closest('button')!;
      expect(optionA.className).toContain('permission-prompt-option');
      expect(optionA.className).not.toContain('selected');
      fireEvent.click(optionA);
      expect(optionA.className).toContain('selected');
    });

    it('resolved-only state renders resolved card with status line', () => {
      const { container } = render(
        <PermissionPrompt
          pendingPermission={null}
          permissionResolved="allow"
          onPermissionResponse={vi.fn()}
        />
      );
      expect(container.querySelector('.permission-prompt-panel.resolved')).toBeTruthy();
      const status = container.querySelector('.permission-prompt-resolved');
      expect(status).toBeTruthy();
      expect(status?.className).toContain('allowed');
    });

    it('resolved deny state shows denied color class', () => {
      const { container } = render(
        <PermissionPrompt
          pendingPermission={null}
          permissionResolved="deny"
          onPermissionResponse={vi.fn()}
        />
      );
      const status = container.querySelector('.permission-prompt-resolved');
      expect(status?.className).toContain('denied');
    });

    it('resolved with pending still pending shows inline status row', () => {
      const { container } = render(
        <PermissionPrompt
          pendingPermission={createMockPermission()}
          permissionResolved="allow"
          onPermissionResponse={vi.fn()}
        />
      );
      const status = container.querySelector('.permission-prompt-resolved');
      expect(status).toBeTruthy();
      expect(status?.className).toContain('allowed');
      // Panel itself is not in resolved-only mode
      expect(container.querySelector('.permission-prompt-panel.resolved')).toBeNull();
    });
  });
});
