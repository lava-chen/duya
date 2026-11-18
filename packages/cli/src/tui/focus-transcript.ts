import type { Block } from './blocks.js';

function lastBlockOfKind(blocks: readonly Block[], kind: Block['kind']): number {
  for (let index = blocks.length - 1; index >= 0; index--) {
    if (blocks[index]?.kind === kind) return index;
  }
  return -1;
}

/** Reading projection only. Switching back reuses the original transcript blocks. */
export function focusTranscriptBlocks(blocks: readonly Block[]): readonly Block[] {
  const promptIndex = lastBlockOfKind(blocks, 'user');
  const prompt = blocks[promptIndex];
  const turn = blocks.slice(promptIndex + 1);
  const toolEnd = lastBlockOfKind(turn, 'tool');
  const tools = turn.filter((block): block is Extract<Block, { kind: 'tool' }> => block.kind === 'tool');
  let additions = 0;
  let deletions = 0;
  let subagents = 0;
  let completedBackground = 0;
  let running = 0;
  let errors = 0;
  for (const tool of tools) {
    const agent = tool.subagent;
    if (agent?.subagentId !== undefined && tool.status !== 'error') subagents += 1;
    if (agent?.spec.runInBackground === true && agent.outcome === 'completed') completedBackground += 1;
    if (tool.status === 'running') running += 1;
    if (tool.status === 'error') errors += 1;
    for (const file of tool.diff ?? []) {
      additions += file.added;
      deletions += file.removed;
    }
  }
  const summary = [
    `${tools.length} tool ${tools.length === 1 ? 'call' : 'calls'}`,
    ...(running ? [`${running} running`] : []),
    ...(errors ? [`${errors} failed`] : []),
    ...(subagents ? [`${subagents} ${subagents === 1 ? 'agent' : 'agents'}`] : []),
    ...(completedBackground ? [`${completedBackground} background ${completedBackground === 1 ? 'task' : 'tasks'} completed`] : []),
    ...(additions || deletions ? [`+${additions} −${deletions}`] : []),
  ].join(' · ');
  return [
    ...(prompt === undefined ? [] : [prompt]),
    ...(tools.length === 0 ? [] : [{ kind: 'notice' as const, id: `focus:${tools[0]!.id}:${summary}`, text: summary }]),
    ...turn.filter((block, index) => block.kind === 'error' || (index > toolEnd && block.kind === 'assistant')),
  ];
}
