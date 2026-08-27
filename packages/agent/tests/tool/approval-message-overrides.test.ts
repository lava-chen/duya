import { describe, it, expect } from 'vitest';
import { renderConnectorApprovalMessage } from '../../src/tool/AppConnectionTool/approval-message';

describe('approval template tool overrides (Plan 450 Phase F)', () => {
  it('falls back to provider template when no override matches', () => {
    const r = renderConnectorApprovalMessage({
      toolName: 'remote_notion_unknown_tool',
      connector: { provider: 'notion', riskTier: 'modify' },
      action: 'remote:unknown_tool',
    });
    expect(r.message).toContain('Notion');
    expect(r.message).toContain('make changes in');
  });

  it('uses a per-tool override when its action pattern matches', () => {
    const r = renderConnectorApprovalMessage({
      toolName: 'remote_github_add_comment',
      connector: { provider: 'github', riskTier: 'modify' },
      action: 'remote:add_comment_on_pull',
    });
    expect(r.message).toContain('GitHub');
    expect(r.message).toContain('add a comment to');
    expect(r.message).toContain('a pull request');
    // Provider template would say "make changes in" — the override uses
    // its own verb_write so the language is tool-specific.
    expect(r.message).not.toContain('make changes in');
  });

  it('uses the override verb_read for read-tier tools', () => {
    const r = renderConnectorApprovalMessage({
      toolName: 'remote_github_add_comment',
      connector: { provider: 'github', riskTier: 'read' },
      action: 'remote:add_comment_list',
    });
    expect(r.message).toContain('read comments on');
  });

  it('renders with override scope for GitHub PR creation', () => {
    const r = renderConnectorApprovalMessage({
      toolName: 'remote_github_create_pull',
      connector: { provider: 'github', riskTier: 'modify' },
      action: 'remote:create_pull_request',
    });
    expect(r.message).toContain('open a pull request on');
    expect(r.message).toContain('your GitHub repositories');
  });

  it('matches by provider only when action is absent', () => {
    const r = renderConnectorApprovalMessage({
      toolName: 'remote_notion_create_page',
      connector: { provider: 'notion', riskTier: 'modify' },
      // action missing — should use provider template
    });
    expect(r.message).toContain('Notion');
    expect(r.message).toContain('make changes in');
  });

  it('does not match a different provider\'s action pattern', () => {
    // `^create` would match notion overrides, but the provider is github,
    // so no override applies and we get github's generic template.
    const r = renderConnectorApprovalMessage({
      toolName: 'remote_github_create_thing',
      connector: { provider: 'github', riskTier: 'modify' },
      action: 'remote:create_anything',
    });
    expect(r.message).toContain('GitHub');
    // No notion wording
    expect(r.message).not.toContain('Notion');
    expect(r.message).not.toContain('create new content');
  });

  it('falls back to generic renderer for unknown provider + unknown tool', () => {
    const r = renderConnectorApprovalMessage({
      toolName: 'random_tool',
      action: 'remote:random',
    });
    expect(r.message).toContain('Allow the connected app to run');
  });

  it('keeps toolParamsDisplay working with overrides', () => {
    const r = renderConnectorApprovalMessage({
      toolName: 'remote_github_create_issue',
      connector: { provider: 'github', riskTier: 'modify' },
      action: 'remote:create_issue',
      input: { title: 'Bug: app crashes on login', labels: ['bug', 'p1'] },
    });
    expect(r.toolParamsDisplay.length).toBeGreaterThan(0);
    expect(r.toolParamsDisplay.some((p) => p.name === 'title')).toBe(true);
  });
});
