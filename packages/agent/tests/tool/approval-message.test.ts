import { describe, it, expect } from 'vitest';
import {
  renderConnectorApprovalMessage,
  renderConnectorApprovalFromDescriptor,
  APPROVAL_TEMPLATE_SCHEMA_VERSION,
} from '../../src/tool/AppConnectionTool/approval-message';
import type { AppConnectionToolDescriptor } from '../../src/tool/AppConnectionTool/index';

function makeDescriptor(overrides?: Partial<AppConnectionToolDescriptor>): AppConnectionToolDescriptor {
  return {
    name: 'remote_notion_create_page',
    description: 'Creates a page in Notion',
    inputSchema: { type: 'object', properties: {} },
    inputSchemaSummary: 'Official notion Remote MCP',
    riskTier: 'modify',
    provider: 'notion',
    connectionId: 'conn-1',
    action: 'remote:create_page',
    ...overrides,
  };
}

describe('renderConnectorApprovalMessage (Plan 449)', () => {
  it('reports the schema version', () => {
    expect(APPROVAL_TEMPLATE_SCHEMA_VERSION).toBe(1);
    const rendered = renderConnectorApprovalMessage({ toolName: 'x' });
    expect(rendered.schemaVersion).toBe(1);
  });

  it('uses the curated template for a known provider', () => {
    const rendered = renderConnectorApprovalMessage({
      toolName: 'remote_notion_create_page',
      connector: { provider: 'notion', riskTier: 'modify' },
    });
    expect(rendered.message).toContain('Notion');
    expect(rendered.message).toContain('make changes in');
    expect(rendered.message).toContain('Notion workspace');
    expect(rendered.message).toContain('remote_notion_create_page');
  });

  it('uses a read verb for read-tier tools', () => {
    const rendered = renderConnectorApprovalMessage({
      toolName: 'remote_github_search',
      connector: { provider: 'github', riskTier: 'read' },
    });
    expect(rendered.message).toContain('read from your GitHub repositories');
  });

  it('appends a truncated primary argument', () => {
    const long = 'y'.repeat(200);
    const rendered = renderConnectorApprovalMessage({
      toolName: 'remote_linear_create_issue',
      connector: { provider: 'linear', riskTier: 'write' },
      input: { title: long },
    });
    expect(rendered.message).toContain('…');
    expect(rendered.message.length).toBeLessThan(300);
  });

  it('falls back to a generic question for unknown providers', () => {
    const rendered = renderConnectorApprovalMessage({
      toolName: 'acme_tool',
      connector: { provider: 'acme', riskTier: 'modify' },
      title: 'Acme Tool',
      description: 'Does acme things',
    });
    expect(rendered.message).toContain('Acme Tool');
    expect(rendered.message).toContain('Does acme things');
  });

  it('never throws on missing metadata', () => {
    const rendered = renderConnectorApprovalMessage({ toolName: '' });
    expect(rendered.schemaVersion).toBe(1);
    expect(typeof rendered.message).toBe('string');
  });
});

describe('renderConnectorApprovalFromDescriptor (Plan 449)', () => {
  it('renders from descriptor metadata including title', () => {
    const descriptor = makeDescriptor({ title: 'Create Page' });
    const rendered = renderConnectorApprovalFromDescriptor(descriptor, { parent: 'Docs' });
    expect(rendered.message).toContain('Create Page');
    expect(rendered.message).toContain('Docs');
    expect(rendered.message).toContain('Notion');
  });
});
