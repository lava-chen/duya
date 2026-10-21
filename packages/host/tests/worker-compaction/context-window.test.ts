import { describe, expect, it } from 'vitest'
import { DEFAULT_CONTEXT_WINDOW } from '@duya/agent-runtime/context/compact/types'
import { resolveWorkerCompactionContextWindow } from '../../src/worker-compaction/index.js'

describe('Host worker compaction context-window resolution', () => {
  it('prefers an explicit runtime capability over the catalog', () => {
    expect(resolveWorkerCompactionContextWindow({
      capabilityContextWindow: 64_000,
      modelId: 'claude-sonnet-5',
    })).toEqual({ contextWindow: 64_000, source: 'capability' })
  })

  it('uses the model catalog when the runtime capability is missing', () => {
    expect(resolveWorkerCompactionContextWindow({
      capabilityContextWindow: undefined,
      modelId: 'claude-sonnet-5',
    })).toEqual({ contextWindow: 1_000_000, source: 'catalog' })
  })

  it('ignores a non-positive capability and falls back to the catalog', () => {
    expect(resolveWorkerCompactionContextWindow({
      capabilityContextWindow: 0,
      modelId: 'claude-sonnet-5',
    })).toEqual({ contextWindow: 1_000_000, source: 'catalog' })
    expect(resolveWorkerCompactionContextWindow({
      capabilityContextWindow: -1,
      modelId: 'claude-sonnet-5',
    }).source).toBe('catalog')
  })

  it('uses the default only when capability and catalog lookup both miss', () => {
    expect(resolveWorkerCompactionContextWindow({
      capabilityContextWindow: undefined,
      modelId: 'totally-unknown-model-id',
    })).toEqual({ contextWindow: DEFAULT_CONTEXT_WINDOW, source: 'default' })
    expect(DEFAULT_CONTEXT_WINDOW).toBe(200_000)
    expect(resolveWorkerCompactionContextWindow({})).toEqual({
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      source: 'default',
    })
  })
})
