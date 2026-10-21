/**
 * Behaviour of the assembly-time rules from §2.4 of the design.
 *
 * These are the reasons the package is allowed to exist: duplicates, capability
 * escalation, lifecycle cycles and prompt slot conflicts must be rejected
 * BEFORE a registry exists, not discovered mid-turn.
 */

import { describe, expect, it } from 'vitest';
import {
  ExtensionRegistryBuilder,
  ExtensionValidationError,
  allCapabilities,
  assembleExtensions,
  grantedCapabilities,
} from '../src/index.js';
import type {
  ApprovalPolicyContributor,
  ExtensionCapability,
  HookContributor,
  LifecycleContributor,
  MemoryPolicyContributor,
  PromptSectionContributor,
  ServerContributor,
  ToolContributor,
} from '../src/index.js';

function assemble(builder: ExtensionRegistryBuilder) {
  return assembleExtensions(builder, allCapabilities());
}

function rejectionIssues(builder: ExtensionRegistryBuilder) {
  try {
    assemble(builder);
  } catch (error) {
    if (error instanceof ExtensionValidationError) return error.issues;
    throw error;
  }
  throw new Error('expected assembleExtensions to reject this assembly');
}

function tool(id: string): ToolContributor {
  return {
    id: `contrib:${id}`,
    toolId: id,
    capabilities: ['tools'],
    definition: { name: id, description: id, inputSchema: {} },
  };
}

describe('rule 1 — duplicate identity inside one slot', () => {
  it('rejects two tools claiming one toolId', () => {
    const issues = rejectionIssues(
      new ExtensionRegistryBuilder().toolContributor(tool('dup')).toolContributor(tool('dup')),
    );
    expect(issues.some((i) => i.rule === 'duplicate-id' && i.slot === 'tools')).toBe(true);
  });

  it('accepts the same id in two different slots', () => {
    const section: PromptSectionContributor = {
      id: 'dup',
      capabilities: ['promptSections'],
      sectionName: 'dup',
      slots: ['rules'],
      render: () => '',
    };
    const registry = assemble(
      new ExtensionRegistryBuilder().toolContributor(tool('dup')).promptSectionContributor(section),
    );
    expect(registry.tools).toHaveLength(1);
    expect(registry.promptSections).toHaveLength(1);
  });

  it('namespaces server ids by kind, so mcp and connector may share a name', () => {
    const mcp: ServerContributor = {
      id: 'mcp:a', kind: 'mcp', serverId: 'a', transport: 'stdio', capabilities: ['servers'],
    };
    const connector: ServerContributor = {
      id: 'conn:a', kind: 'app-connector', serverId: 'a', transport: 'app-connection',
      capabilities: ['servers'],
    };
    const registry = assemble(new ExtensionRegistryBuilder().serverContributor(mcp).serverContributor(connector));
    expect(registry.servers).toHaveLength(2);
  });
});

describe('rule 2/3 — declared capabilities must be known and granted', () => {
  it('rejects a contributor whose capability was not granted', () => {
    const contributor: MemoryPolicyContributor = {
      id: 'mem',
      capabilities: ['memoryPolicies'],
      sectionId: 'retention',
      rules: [],
    };
    const builder = new ExtensionRegistryBuilder().memoryPolicyContributor(contributor);
    let thrown: unknown;
    try {
      assembleExtensions(builder, grantedCapabilities(['tools', 'modes']));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ExtensionValidationError);
    const issues = (thrown as ExtensionValidationError).issues;
    expect(issues.some((i) => i.rule === 'capability-escalation' && i.key === 'mem')).toBe(true);
  });

  it('rejects an unknown capability name', () => {
    const contributor: ToolContributor = {
      id: 'bogus',
      toolId: 'x',
      capabilities: ['not-a-slot' as unknown as ExtensionCapability],
      definition: { name: 'x', description: '', inputSchema: {} },
    };
    const issues = rejectionIssues(new ExtensionRegistryBuilder().toolContributor(contributor));
    expect(issues.some((i) => i.rule === 'unknown-capability')).toBe(true);
  });

  it('rejects an unknown capability passed as a grant', () => {
    expect(() => grantedCapabilities(['tools', 'nope'])).toThrow(/unknown capability/);
  });
});

describe('rule 4 — lifecycle hook cycles', () => {
  function lifecycle(
    id: string,
    events: LifecycleContributor['events'],
    registers?: LifecycleContributor['registers'],
  ): LifecycleContributor {
    return { id, capabilities: ['lifecycles'], events, ...(registers ? { registers } : {}), handle: () => {} };
  }

  it('rejects a contributor that re-registers the event it is hooked on', () => {
    const issues = rejectionIssues(
      new ExtensionRegistryBuilder().lifecycleContributor(lifecycle('a', ['turn-start'], ['turn-start'])),
    );
    expect(issues.some((i) => i.rule === 'lifecycle-cycle')).toBe(true);
  });

  it('rejects a two-contributor cycle', () => {
    const issues = rejectionIssues(
      new ExtensionRegistryBuilder()
        .lifecycleContributor(lifecycle('a', ['turn-start'], ['turn-stop']))
        .lifecycleContributor(lifecycle('b', ['turn-stop'], ['turn-start'])),
    );
    expect(issues.some((i) => i.rule === 'lifecycle-cycle')).toBe(true);
  });

  it('accepts a DAG, which is not a cycle', () => {
    const registry = assemble(
      new ExtensionRegistryBuilder()
        .lifecycleContributor(lifecycle('a', ['turn-start'], ['turn-stop']))
        .lifecycleContributor(lifecycle('b', ['turn-stop'], [])),
    );
    expect(registry.lifecycles).toHaveLength(2);
  });

  it('accepts a contributor that registers an event nobody hooks', () => {
    const registry = assemble(
      new ExtensionRegistryBuilder().lifecycleContributor(lifecycle('a', ['turn-start'], ['cleanup'])),
    );
    expect(registry.lifecycles).toHaveLength(1);
  });
});

describe('rule 5 — prompt slot conflicts', () => {
  function section(name: string, slots: PromptSectionContributor['slots']): PromptSectionContributor {
    return { id: name, capabilities: ['promptSections'], sectionName: name, slots, render: () => '' };
  }

  it('rejects two sections claiming the same authored slot', () => {
    const issues = rejectionIssues(
      new ExtensionRegistryBuilder()
        .promptSectionContributor(section('one', ['rules']))
        .promptSectionContributor(section('two', ['rules'])),
    );
    expect(issues.some((i) => i.rule === 'prompt-slot-conflict' && i.key === 'rules')).toBe(true);
  });

  it('accepts disjoint slot claims', () => {
    const registry = assemble(
      new ExtensionRegistryBuilder()
        .promptSectionContributor(section('one', ['rules', 'project']))
        .promptSectionContributor(section('two', ['system-coding'])),
    );
    expect(registry.promptSections).toHaveLength(2);
  });
});

describe('the registry is frozen once assembled', () => {
  it('exposes read-only arrays and cannot be mutated from outside', () => {
    const registry = assemble(new ExtensionRegistryBuilder().toolContributor(tool('only')));
    expect(Object.isFrozen(registry.tools)).toBe(true);
    expect(Object.isFrozen(registry)).toBe(true);
    expect(() => (registry.tools as ToolContributor[]).push(tool('sneaky'))).toThrow();
  });

  it('reports every issue in one pass rather than only the first', () => {
    const a: HookContributor = {
      id: 'h', capabilities: ['hooks'], events: ['PreTurn'], priority: 1, handle: () => [],
    };
    const b: HookContributor = {
      id: 'h', capabilities: ['hooks'], events: ['PostTurn'], priority: 2, handle: () => [],
    };
    const policy: ApprovalPolicyContributor = {
      id: 'p', capabilities: ['approvalPolicies'], modeId: 'm', rules: [],
    };
    const policyDup: ApprovalPolicyContributor = {
      id: 'p2', capabilities: ['approvalPolicies'], modeId: 'm', rules: [],
    };
    const issues = rejectionIssues(
      new ExtensionRegistryBuilder()
        .hookContributor(a)
        .hookContributor(b)
        .approvalPolicyContributor(policy)
        .approvalPolicyContributor(policyDup),
    );
    expect(issues.filter((i) => i.rule === 'duplicate-id').length).toBe(2);
  });
});
