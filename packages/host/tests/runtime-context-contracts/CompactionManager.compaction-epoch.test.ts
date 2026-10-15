import { describe, expect, it, vi } from 'vitest'
import type { Message } from '@duya/agent-runtime/context/compact'
import { CompactionManager } from '@duya/agent-runtime/context/compact'
import { createCompactionTestPorts } from './test-ports.js'

const usableSummary = [
  '1. Primary Request and Intent: Continue the multi-step project work and preserve the user\'s requirements.',
  '2. Key Technical Concepts: The work uses TypeScript, a durable message timeline, Runtime-owned compaction, and explicit Host ports.',
  '3. Files and Code Sections: Context accounting lives in the Runtime ledger; Host supplies the canonical token estimator and model services.',
  '4. Errors and Fixes: The compaction path validates summaries, retries transient failures, preserves tool call pairs, and reports unrecoverable errors.',
  '5. Problem Solving: The summary retains prior decisions while keeping recent messages intact and starts a new accounting epoch after rewriting history.',
  '6. All User Messages: Continue from the latest request without losing earlier constraints or completed work.',
  '7. Pending Tasks: Verify the next turn against the new epoch and keep the resulting context usage authoritative.',
  '8. Current Work: Older conversation content has been compacted into this continuation summary.',
  '9. Optional Next Step: Proceed with the next user request using this summary and the retained recent messages.',
].join('\n\n')

function conversation(): Message[] {
  return Array.from({ length: 24 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `Turn ${index + 1}: ${'A detailed project update with decisions, implementation evidence, and remaining work. '.repeat(5)}`,
    timestamp: index + 1,
  })) as Message[]
}

describe('CompactionManager compaction epoch lifecycle', () => {
  it('shrinks the projected history, resets old usage, and accepts the next-turn observation', async () => {
    const ports = createCompactionTestPorts()
    const summarizer = vi.fn(async () => usableSummary)
    const manager = new CompactionManager(
      { keepRecentTokens: 90 },
      { ...ports, summarizer },
    )
    const input = conversation()
    const oldEpoch = manager.getContextLedger().getEpoch()

    // Provider usage anchors the current turn. The timeline itself has no
    // usage block, so the post-compaction scan can show the actual smaller
    // retained projection after the ledger starts a fresh epoch.
    manager.setObservedUsage(120_000, 7_000)
    const tokensBefore = manager.getContextTokens(input)
    expect(tokensBefore).toBeGreaterThan(100_000)

    const result = await manager.compact(input, { trigger: 'manual' })

    expect(summarizer).toHaveBeenCalled()
    expect(result.messages.length).toBeLessThan(input.length)
    expect(manager.getContextTokens(result.messages)).toBeLessThan(tokensBefore)
    expect(manager.getContextLedger().getEpoch()).toBe(oldEpoch + 1)
    expect(manager.getLatestInputTokens()).toBeUndefined()

    // An in-flight response from before the rewrite must not restore its old
    // context size. The following turn, built from the compacted checkpoint,
    // is observed under the new epoch and becomes the current accounting fact.
    expect(manager.setObservedUsageForEpoch(118_000, 6_000, oldEpoch)).toBe(false)
    expect(manager.getLatestInputTokens()).toBeUndefined()

    const nextEpoch = manager.getContextLedger().getEpoch()
    const nextTurn: Message[] = [
      ...result.messages,
      { role: 'user', content: 'What should we do next?' },
      {
        role: 'assistant',
        content: 'I will continue from the compacted checkpoint.',
        usage: { input_tokens: 8_200, output_tokens: 120 },
      } as unknown as Message,
    ]
    expect(manager.setObservedUsageForEpoch(8_200, 120, nextEpoch)).toBe(true)
    expect(manager.getLatestInputTokens()).toBe(8_200)
    expect(manager.getContextSnapshot(nextTurn).observation?.inputTokens).toBe(8_200)
  })
})
