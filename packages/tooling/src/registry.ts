/**
 * `ExtensionRegistry` and `ExtensionRegistryBuilder`.
 *
 * The registry has 13 independent slots and NO registration method. It is
 * produced only by `assembleExtensions`, and its constructor is private, so
 * there is exactly one way to obtain a registry and that way runs
 * `validate()` first. A validation nothing calls is decoration; a validation
 * the type system makes unskippable is a gate.
 *
 * The builder has one narrow method per slot — 13 methods, each taking exactly
 * one typed contributor. There is deliberately no `register(plugin)`.
 */

import type {
  ApprovalPolicyContributor,
  ContextContributor,
  DecisionContributor,
  HookContributor,
  LifecycleContributor,
  MemoryPolicyContributor,
  ModeContributor,
  ProfileContributor,
  PromptSectionContributor,
  ServerContributor,
  SkillContributor,
  TokenUsageContributor,
  ToolContributor,
} from './contributors.js';
import { validate } from './validation.js';
import type { ExtensionSnapshot, ValidationIssue } from './validation.js';
import type { GrantedCapabilities } from './grants.js';

function frozen<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

/**
 * A read-only view of every collected contribution.
 *
 * Implements `ExtensionSnapshot`, so `validate` can be run over it. Note that
 * `validate` is exposed on the instance for hosts that assemble incrementally
 * and want to re-check a hand-built snapshot — it is a pure function of the
 * registry's own contents and grants nothing.
 */
export class ExtensionRegistry implements ExtensionSnapshot {
  readonly modes: readonly ModeContributor[];
  readonly tools: readonly ToolContributor[];
  readonly promptSections: readonly PromptSectionContributor[];
  readonly hooks: readonly HookContributor[];
  readonly context: readonly ContextContributor[];
  readonly skills: readonly SkillContributor[];
  readonly approvalPolicies: readonly ApprovalPolicyContributor[];
  readonly profiles: readonly ProfileContributor[];
  readonly servers: readonly ServerContributor[];
  readonly memoryPolicies: readonly MemoryPolicyContributor[];
  readonly decisions: readonly DecisionContributor[];
  readonly lifecycles: readonly LifecycleContributor[];
  readonly tokenUsage: readonly TokenUsageContributor[];

  /** Number of slots this registry version carries. */
  static readonly SLOT_COUNT = 13;

  private constructor(snapshot: ExtensionSnapshot) {
    this.modes = frozen(snapshot.modes);
    this.tools = frozen(snapshot.tools);
    this.promptSections = frozen(snapshot.promptSections);
    this.hooks = frozen(snapshot.hooks);
    this.context = frozen(snapshot.context);
    this.skills = frozen(snapshot.skills);
    this.approvalPolicies = frozen(snapshot.approvalPolicies);
    this.profiles = frozen(snapshot.profiles);
    this.servers = frozen(snapshot.servers);
    this.memoryPolicies = frozen(snapshot.memoryPolicies);
    this.decisions = frozen(snapshot.decisions);
    this.lifecycles = frozen(snapshot.lifecycles);
    this.tokenUsage = frozen(snapshot.tokenUsage);
    Object.freeze(this);
  }

  /**
   * The only construction site in this module.
   *
   * @internal Called by `assembleExtensions`, which runs `validate` before
   * calling it. `stripInternal` is enabled in this package's tsconfig, so
   * this static is omitted from the emitted `.d.ts`: a consumer compiling
   * against `dist/index.d.ts` cannot construct a registry directly and
   * therefore cannot skip assembly-time validation.
   */
  static create(snapshot: ExtensionSnapshot): ExtensionRegistry {
    return new ExtensionRegistry(snapshot);
  }

  /**
   * Re-run assembly-time validation over an already-built registry. Pure: it
   * reads this registry's own contributions and the supplied grant set, and
   * returns the issue list. It grants nothing and mutates nothing.
   */
  validate(granted: GrantedCapabilities): ValidationIssue[] {
    return validate(this, granted);
  }

  /** Total number of contributions across every slot. */
  size(): number {
    return (
      this.modes.length
      + this.tools.length
      + this.promptSections.length
      + this.hooks.length
      + this.context.length
      + this.skills.length
      + this.approvalPolicies.length
      + this.profiles.length
      + this.servers.length
      + this.memoryPolicies.length
      + this.decisions.length
      + this.lifecycles.length
      + this.tokenUsage.length
    );
  }
}

/**
 * The builder: one narrow method per slot, 13 in total.
 *
 * Each method takes exactly one contributor of one concrete interface. Adding
 * a fourteenth contribution kind means adding a fourteenth interface and a
 * fourteenth method, which is the intended cost.
 */
export class ExtensionRegistryBuilder {
  private readonly snapshot: {
    modes: ModeContributor[];
    tools: ToolContributor[];
    promptSections: PromptSectionContributor[];
    hooks: HookContributor[];
    context: ContextContributor[];
    skills: SkillContributor[];
    approvalPolicies: ApprovalPolicyContributor[];
    profiles: ProfileContributor[];
    servers: ServerContributor[];
    memoryPolicies: MemoryPolicyContributor[];
    decisions: DecisionContributor[];
    lifecycles: LifecycleContributor[];
    tokenUsage: TokenUsageContributor[];
  } = {
    modes: [],
    tools: [],
    promptSections: [],
    hooks: [],
    context: [],
    skills: [],
    approvalPolicies: [],
    profiles: [],
    servers: [],
    memoryPolicies: [],
    decisions: [],
    lifecycles: [],
    tokenUsage: [],
  };

  /** Slot 1 — `modes/index.ts` `ModeModifier` registration. */
  modeContributor(contributor: ModeContributor): this {
    this.snapshot.modes.push(contributor);
    return this;
  }

  /** Slot 2 — `tool/builtin.ts` tool registration. */
  toolContributor(contributor: ToolContributor): this {
    this.snapshot.tools.push(contributor);
    return this;
  }

  /** Slot 3 — `prompts/modules/registry.ts` module registration. */
  promptSectionContributor(contributor: PromptSectionContributor): this {
    this.snapshot.promptSections.push(contributor);
    return this;
  }

  /** Slot 4 — `hooks/builtin.ts` hook registration. */
  hookContributor(contributor: HookContributor): this {
    this.snapshot.hooks.push(contributor);
    return this;
  }

  /** Slot 5 — `agentsmd/manager.ts` instruction loading. */
  contextContributor(contributor: ContextContributor): this {
    this.snapshot.context.push(contributor);
    return this;
  }

  /** Slot 6 — `skills/index.ts` skill registration. */
  skillContributor(contributor: SkillContributor): this {
    this.snapshot.skills.push(contributor);
    return this;
  }

  /** Slot 7 — `permissions/policy.ts` `PERMISSION_MODE_CONFIG`. */
  approvalPolicyContributor(contributor: ApprovalPolicyContributor): this {
    this.snapshot.approvalPolicies.push(contributor);
    return this;
  }

  /** Slot 8 — `agent-profile/` profile composition. */
  profileContributor(contributor: ProfileContributor): this {
    this.snapshot.profiles.push(contributor);
    return this;
  }

  /**
   * Slot 9 — `mcp/index.ts` MCP servers AND the App-Connection tools. One
   * slot, discriminated by `kind`, because the runtime already owns both
   * buckets in one mechanism (`ToolOwner` in `tool/registry.ts`).
   */
  serverContributor(contributor: ServerContributor): this {
    this.snapshot.servers.push(contributor);
    return this;
  }

  /** Slot 10 — `memory-rollout/stage1_policy_editor.ts`. */
  memoryPolicyContributor(contributor: MemoryPolicyContributor): this {
    this.snapshot.memoryPolicies.push(contributor);
    return this;
  }

  /** Slot 11 — `decisions/` `DecisionService` fallback chain. */
  decisionContributor(contributor: DecisionContributor): this {
    this.snapshot.decisions.push(contributor);
    return this;
  }

  /** Slot 12 — `lifecycle/` background-agent lifecycle. */
  lifecycleContributor(contributor: LifecycleContributor): this {
    this.snapshot.lifecycles.push(contributor);
    return this;
  }

  /** Slot 13 — `observability/cache-monitor.ts` usage accounting. */
  tokenUsageContributor(contributor: TokenUsageContributor): this {
    this.snapshot.tokenUsage.push(contributor);
    return this;
  }

  /** Plain snapshot of everything collected so far. */
  build(): ExtensionSnapshot {
    return {
      modes: [...this.snapshot.modes],
      tools: [...this.snapshot.tools],
      promptSections: [...this.snapshot.promptSections],
      hooks: [...this.snapshot.hooks],
      context: [...this.snapshot.context],
      skills: [...this.snapshot.skills],
      approvalPolicies: [...this.snapshot.approvalPolicies],
      profiles: [...this.snapshot.profiles],
      servers: [...this.snapshot.servers],
      memoryPolicies: [...this.snapshot.memoryPolicies],
      decisions: [...this.snapshot.decisions],
      lifecycles: [...this.snapshot.lifecycles],
      tokenUsage: [...this.snapshot.tokenUsage],
    };
  }

  /** How many contributions have been collected across every slot. */
  count(): number {
    return Object.values(this.snapshot).reduce((total, items) => total + items.length, 0);
  }
}
