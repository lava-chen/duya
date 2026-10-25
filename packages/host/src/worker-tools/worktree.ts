import type { Tool, ToolResult, ToolUseContext } from '../worker-run-contracts.js';
import type { SessionCheckoutCommand } from '@duya/agent-protocol';
import { parseSessionCheckoutCommand } from '../workspace/session-checkout-service.js';

/** Control tools exchange their invocation lease instead of bypassing the fence. */
export class WorktreeControlTool {
  readonly controlsExecutionLocation = true;
  constructor(private readonly action: 'enter' | 'exit' | 'sync') {}
  isConcurrencySafe(): boolean { return false; }
  toTool(): Tool {
    const definitions = {
      enter: { name: 'enter_worktree', description: 'Create an isolated Git worktree or enter an existing registered worktree in this repository. Specify exactly one of name or path. Creation defaults to local HEAD; base="fresh" uses the existing origin/HEAD tracking ref without fetching. Uncommitted source changes are excluded. Switches this session\'s cwd, instructions, skills and permissions for the next model round. Call alone; issue subsequent file/shell calls in the next response.',
        properties: { name: { type: 'string' }, path: { type: 'string' }, base: { type: 'string' }, branchName: { type: 'string' } } },
      exit: { name: 'exit_worktree', description: 'Return this session to the directory saved by enter_worktree. disposition="keep" retains the checkout; "remove" requests safe removal and returns a retention reason for dirty, ignored, active or unreferenced data. Preserves a checkpoint of committed HEAD. No discard or forced deletion. Call alone; use the next response for further tools.',
        properties: { disposition: { type: 'string', enum: ['keep', 'remove'] } } },
      sync: { name: 'sync_worktree', description: 'Merge a local base ref into the current owned checkout, reporting up_to_date, merged, or conflicts. base defaults to the source branch recorded at creation, or its immutable creation commit when no source branch was available. abort=true aborts only a merge started by this service. Dirty trees, active processes and unrelated Git operations are refused.',
        properties: { base: { type: 'string' }, abort: { type: 'boolean' } } },
    };
    const definition = definitions[this.action];
    return { name: definition.name, description: definition.description,
      input_schema: { type: 'object', properties: definition.properties, additionalProperties: false } };
  }
  async execute(input: Record<string, unknown>, _cwd?: string, context?: ToolUseContext): Promise<ToolResult> {
    if (!context?.checkoutControl || !context.beginExecutionLocationSwitch) throw new Error('Worktree control requires a session-bound execution control capability.');
    const command = parseSessionCheckoutCommand({ ...input, action: this.action }) as SessionCheckoutCommand;
    const result = await context.checkoutControl(command, context.beginExecutionLocationSwitch);
    return { id: context.toolUseId, name: this.toTool().name, result: JSON.stringify(result) };
  }
}
