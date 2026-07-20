/**
 * Run agent implementation
 * Executes a sub-agent with the given parameters and yields messages.
 */

import type {
  Message,
  MessageContent,
  SSEEvent,
  Tool,
  ToolUseContext,
} from '../../types.js'
import type { AgentDefinition, BuiltInAgentDefinition, CustomAgentDefinition } from './loadAgentsDir.js'
import { isBuiltInAgent } from './loadAgentsDir.js'
import { duyaAgent } from '../../index.js'
import { setMaxListeners } from 'node:events'
import { resolveAgentTools } from './subagentToolUtils.js'
import { ToolRegistry } from '../registry.js'
import { getPromptProfileForSubagentType } from '../../prompts/modes/index.js'
import { PromptManager } from '../../prompts/PromptManager.js'
import { appendMessages } from '../../session/db.js'
import type { TokenUsage } from '../../types.js'
import { logger } from '../../utils/logger.js'
import { composeSubagentSystemPrompt } from './promptComposition.js'

export interface RunAgentParams {
  agentDefinition: AgentDefinition
  promptMessages: Message[]
  toolUseContext: ToolUseContext
  isAsync: boolean
  model?: string
  maxTurns?: number
  availableTools: Tool[]
  description?: string
  /**
   * Stable identifier the caller (e.g. SubagentTool) hands out for this
   * sub-agent. It is attached to every progress event so the renderer
   * can group events from a single sub-agent into one panel row. Must
   * be provided by the caller — generating a new UUID here would split
   * the agent into multiple rows in the UI.
   */
  agentId: string
  /**
   * Optional callback to report progress during agent execution.
   * Called whenever the sub-agent produces text, thinking, or tool_use events.
   */
  onProgress?: (event: AgentProgressEvent) => void
  /**
   * Sub-agent's DB session ID for persisting messages.
   * When set, the sub-agent's conversation messages will be saved to the database.
   */
  sessionId?: string
}

export interface CacheSafeParams {
  systemPrompt: string
  userContext: Record<string, string>
  systemContext: Record<string, string>
  toolUseContext: ToolUseContext
  forkContextMessages: Message[]
}

export type RunAgentResult = AsyncGenerator<Message, void>

const SUBAGENT_EVENT_STALL_TIMEOUT_MS = 45000

/** Progress event emitted during sub-agent execution */
export interface AgentProgressEvent {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'started' | 'done' | 'error'
  data?: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolResult?: string
  duration?: number
  agentId?: string
  agentType?: string
  agentName?: string
  agentDescription?: string
}

/**
 * Extract text content from a message
 */
function extractTextFromMessage(message: Message): string {
  if (typeof message.content === 'string') {
    return message.content
  }
  if (Array.isArray(message.content)) {
    return message.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map(block => block.text)
      .join('\n')
  }
  return ''
}

/**
 * Get system prompt from agent definition
 */
function getAgentSystemPrompt(
  agentDefinition: AgentDefinition,
  toolUseContext: ToolUseContext
): string {
  if (isBuiltInAgent(agentDefinition)) {
    return agentDefinition.getSystemPrompt({ toolUseContext })
  } else {
    return (agentDefinition as CustomAgentDefinition).getSystemPrompt()
  }
}

/**
 * Runs an agent with the given parameters.
 * Returns an async generator of messages.
 */
export async function* runAgent({
  agentDefinition,
  promptMessages,
  toolUseContext,
  isAsync,
  model,
  maxTurns,
  availableTools,
  description,
  agentId,
  onProgress,
  sessionId,
}: RunAgentParams): RunAgentResult {
  const startTime = Date.now()
  const parentSessionId = toolUseContext.options.sessionId
  const workingDirectory = toolUseContext.options.workingDirectory ?? process.cwd()

  // Resolve the role-specific prompt. Shared project governance is composed
  // after tool resolution so tool-aware harness sections stay accurate.
  const roleSystemPrompt = getAgentSystemPrompt(agentDefinition, toolUseContext)

  logger.info('[SubAgent] runAgent starting', {
    agentId,
    agentType: agentDefinition.agentType,
    agentFilename: agentDefinition.filename,
    parentSessionId,
    subAgentSessionId: sessionId,
    isAsync,
    hasDescription: Boolean(description),
  }, 'SubAgent')

  // Resolve tools for this agent
  const { resolvedTools } = resolveAgentTools(agentDefinition, availableTools)

  // Determine the model to use
  const agentModel = model || agentDefinition.model || toolUseContext.options.mainLoopModel

  // Determine max turns
  const agentMaxTurns = maxTurns ?? agentDefinition.maxTurns ?? 10

  // Build the prompt from messages
  const promptText = promptMessages
    .map(msg => {
      const role = msg.role.toUpperCase()
      const content = extractTextFromMessage(msg)
      return `[${role}]: ${content}`
    })
    .join('\n\n')

  logger.info('[SubAgent] runAgent configured', {
    agentId,
    agentType: agentDefinition.agentType,
    model: agentModel,
    maxTurns: agentMaxTurns,
    promptLength: promptText.length,
    resolvedToolCount: resolvedTools.length,
    availableToolCount: availableTools.length,
    workingDirectory,
  }, 'SubAgent')

  // Get API configuration from parent context
  const apiKey = toolUseContext.options.apiKey || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY
  if (!apiKey) {
    const errorMsg = `[Agent ${agentDefinition.agentType}] Error: No API key available for sub-agent execution`
    logger.error('[SubAgent] missing API key', undefined, {
      agentId,
      agentType: agentDefinition.agentType,
      parentSessionId,
      subAgentSessionId: sessionId,
    }, 'SubAgent')
    onProgress?.({ type: 'error', data: errorMsg, agentId })
    yield {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: [{
        type: 'text',
        text: errorMsg,
      }],
      timestamp: Date.now(),
      metadata: { agentError: errorMsg },
    }
    return
  }

  // Determine prompt profile based on subagent type
  const promptProfile = getPromptProfileForSubagentType(agentDefinition.agentType)

  // Create a PromptManager with the appropriate profile for this subagent
  const subAgentPromptManager = new PromptManager({
    sessionId,
    workingDirectory,
    modelId: agentModel,
    promptProfile,
  })

  // Create real tool registry with actual tool executors
  const { createBuiltinRegistry } = await import('../builtin.js')
  const registry = createBuiltinRegistry()
  const allTools = registry.getAllTools()
  const toolNames = new Set(resolvedTools.map(t => t.name))
  let toolsToUse = toolNames.size > 0
    ? allTools.filter(t => toolNames.has(t.name))
    : allTools

  // Prevent recursive agent calls - exclude the Agent tool from sub-agents
  // to avoid infinite recursion where a sub-agent spawns another sub-agent
  toolsToUse = toolsToUse.filter(t => t.name !== 'Agent')

  const harnessPrompt = [
    ...await subAgentPromptManager.buildSystemPrompt(
      new Set(toolsToUse.map(tool => tool.name)),
    ),
  ].join('\n\n')
  const systemPrompt = composeSubagentSystemPrompt(roleSystemPrompt, harnessPrompt)

  // The explicit systemPrompt replaces DuyaAgent's normal prompt path, so it
  // must already contain both the agent role and the shared project harness.
  const subAgent = new duyaAgent({
    apiKey,
    baseURL: toolUseContext.options.baseURL,
    model: agentModel,
    authStyle: toolUseContext.options.authStyle,
    provider: toolUseContext.options.provider,
    systemPrompt,
    workingDirectory,
    sessionId,
    promptManager: subAgentPromptManager,
  })

  logger.info('[SubAgent] streamChat starting', {
    agentId,
    agentType: agentDefinition.agentType,
    toolCount: toolsToUse.length,
    toolNames: toolsToUse.slice(0, 20).map(tool => tool.name),
    omittedToolCount: Math.max(0, toolsToUse.length - 20),
    subAgentSessionId: sessionId,
  }, 'SubAgent')

  const textParts: string[] = []
  const thinkingParts: string[] = []
  let tokenUsage: TokenUsage | null = null
  let toolCalls = 0
  let hasError = false
  let errorMessage = ''
  let terminalProgressEmitted = false
  let lastEventType: SSEEvent['type'] | 'none' = 'none'
  let lastEventAt = Date.now()
  let lastPersistTime = 0
  const PERSIST_INTERVAL_MS = 3000
  // Track how many messages have already been persisted so each periodic
  // tick only appends the new tail. appendMessages uses INSERT OR IGNORE
  // (dedup by message id), so re-appending everything would not create
  // duplicate rows, but it would re-serialize the whole conversation every
  // tick — O(n) per interval, O(n^2) over a long run. Slicing the tail
  // keeps each tick cheap.
  let lastPersistedIndex = 0
  const persistInterval = sessionId ? setInterval(async () => {
    const allMessages = subAgent.getMessages()
    if (allMessages.length <= lastPersistedIndex) return
    const newMessages = allMessages.slice(lastPersistedIndex)
    try {
      await appendMessages(sessionId, newMessages)
      lastPersistedIndex = allMessages.length
    } catch {
      // periodic persist failure is non-critical; retry the same tail next tick
    }
  }, PERSIST_INTERVAL_MS) : null

  try {
    // Create an abort controller for the sub-agent, linked to parent's abort controller.
    // The parent's signal aborts `subAgentAbort`; we forward that to the sub-agent's
    // own interrupt() so the in-flight LLM HTTP request is cancelled (not just the
    // outer for-await loop in runAgent). Without this, a long-running LLM call
    // would keep streaming into the void after the user cancels the parent turn.
    const subAgentAbort = new AbortController()
    const onParentAbort = () => {
      logger.warn('[SubAgent] parent abort triggered', {
        agentId,
        agentType: agentDefinition.agentType,
        parentSessionId,
        subAgentSessionId: sessionId,
      }, 'SubAgent')
      subAgentAbort.abort()
      try {
        subAgent.interrupt()
      } catch (err) {
        logger.warn('[SubAgent] subAgent.interrupt threw', { err }, 'SubAgent')
      }
    }
    try {
      // Cap at 20 instead of 0 (unlimited). setMaxListeners(0) silently
      // hides leaks where a sub-agent registers an 'abort' listener but
      // never removes it (e.g. an exception before the finally block
      // below). 20 is well above any realistic concurrent-sub-agent
      // count and still preserves Node's leak warning as a safety net.
      setMaxListeners(20, toolUseContext.abortController.signal)
    } catch {
      // Older runtimes may not support EventTarget max listener tuning.
    }
    toolUseContext.abortController.signal.addEventListener('abort', onParentAbort, { once: true })

    // Set up a heartbeat to report progress while the sub-agent is running
    // This prevents the UI from appearing "frozen" during long LLM calls
    let lastProgressTime = Date.now()
    const heartbeatInterval = setInterval(() => {
      const elapsed = Date.now() - lastProgressTime
      if (elapsed > 5000) {
        // If no progress for 5 seconds, report a heartbeat
        onProgress?.({ type: 'thinking', data: `Agent still running... (${Math.round(elapsed / 1000)}s)`, agentId })
      }
    }, 5000)

    try {
      const eventIterator = subAgent.streamChat(promptText, {
        systemPrompt,
        tools: toolsToUse,
        maxTurns: agentMaxTurns,
        toolRegistry: registry,
      })[Symbol.asyncIterator]()

      let sawFirstEvent = false
      while (true) {
        const nextEventPromise = eventIterator.next()
        let stallTimer: ReturnType<typeof setTimeout> | null = null
        const stallTimeoutPromise = new Promise<IteratorResult<SSEEvent>>((_, reject) => {
          stallTimer = setTimeout(() => {
            reject(
              new Error(
                `Sub-agent stalled: no events for ${Math.round(SUBAGENT_EVENT_STALL_TIMEOUT_MS / 1000)}s`
              )
            )
          }, SUBAGENT_EVENT_STALL_TIMEOUT_MS)
        })

        let nextEvent: IteratorResult<SSEEvent>
        try {
          nextEvent = await Promise.race([nextEventPromise, stallTimeoutPromise])
        } catch (stallError) {
          const stallMessage = stallError instanceof Error ? stallError.message : 'Sub-agent stalled'
          hasError = true
          errorMessage = stallMessage
          const now = Date.now()
          logger.error('[SubAgent] stalled waiting for stream event', undefined, {
            agentId,
            agentType: agentDefinition.agentType,
            elapsedMs: now - startTime,
            noEventForMs: now - lastEventAt,
            lastEventType,
            toolCalls,
            promptLength: promptText.length,
            subAgentSessionId: sessionId,
          }, 'SubAgent')
          textParts.push(`\n[Error during agent execution: ${stallMessage}]`)
          onProgress?.({ type: 'error', data: stallMessage, agentId })
          terminalProgressEmitted = true
          // Attempt to interrupt/cleanup to avoid orphaned stream tasks.
          subAgent.interrupt()
          try {
            await eventIterator.return?.()
          } catch {
            // best effort cleanup
          }
          break
        } finally {
          if (stallTimer) {
            clearTimeout(stallTimer)
          }
        }

        if (nextEvent.done) {
          break
        }

        const event = nextEvent.value
        if (!sawFirstEvent) {
          sawFirstEvent = true
          logger.info('[SubAgent] first stream event received', {
            agentId,
            agentType: agentDefinition.agentType,
            eventType: event.type,
            elapsedMs: Date.now() - startTime,
            subAgentSessionId: sessionId,
          }, 'SubAgent')
        }
        lastEventType = event.type
        lastEventAt = Date.now()
        lastProgressTime = Date.now()

        // Check if parent has requested abort
        if (toolUseContext.abortController.signal.aborted) {
          logger.warn('[SubAgent] aborting due to parent signal', {
            agentId,
            agentType: agentDefinition.agentType,
            subAgentSessionId: sessionId,
          }, 'SubAgent')
          hasError = true
          errorMessage = 'Sub-agent cancelled after the parent task was aborted'
          onProgress?.({ type: 'error', data: errorMessage, agentId })
          terminalProgressEmitted = true
          break
        }

        if (event.type === 'text') {
          const textData = typeof event.data === 'string' ? event.data : JSON.stringify(event.data)
          textParts.push(textData)
          onProgress?.({ type: 'text', data: textData, agentId })
        } else if (event.type === 'tool_use') {
          toolCalls++
          const toolData = event.data as { name: string; input: Record<string, unknown> } | undefined
          onProgress?.({
            type: 'tool_use',
            toolName: toolData?.name || '',
            toolInput: toolData?.input,
            agentId,
          })
        } else if (event.type === 'tool_result') {
          const resultData = event.data as { id: string; name: string; result: string; error: boolean }
          onProgress?.({
            type: 'tool_result',
            toolName: resultData?.name || '',
            toolResult: resultData?.result || '',
            agentId,
          })
        } else if (event.type === 'thinking') {
          const thinkingData = typeof event.data === 'string' ? event.data : JSON.stringify(event.data)
          thinkingParts.push(thinkingData)
          onProgress?.({ type: 'thinking', data: thinkingData, agentId })
        } else if (event.type === 'result') {
          tokenUsage = event.data
        } else if (event.type === 'done') {
          onProgress?.({ type: 'done', duration: Date.now() - startTime, agentId })
          terminalProgressEmitted = true
          break
        } else if (event.type === 'error') {
          const errorData = typeof event.data === 'string' ? event.data : JSON.stringify(event.data)
          errorMessage = errorData
          hasError = true
          logger.error('[SubAgent] error event', undefined, {
            agentId,
            agentType: agentDefinition.agentType,
            error: errorData,
            toolCalls,
            subAgentSessionId: sessionId,
          }, 'SubAgent')
          textParts.push(`\n[Error: ${errorData}]`)
          onProgress?.({ type: 'error', data: errorData, agentId })
          terminalProgressEmitted = true
        }
      }
    } finally {
      clearInterval(heartbeatInterval)
      if (persistInterval) clearInterval(persistInterval)
      toolUseContext.abortController.signal.removeEventListener('abort', onParentAbort)
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error'
    errorMessage = errMsg
    hasError = true
    logger.error('[SubAgent] runAgent failed', error as Error, {
      agentId,
      agentType: agentDefinition.agentType,
      error: errMsg,
      toolCalls,
      lastEventType,
      elapsedMs: Date.now() - startTime,
      subAgentSessionId: sessionId,
    }, 'SubAgent')
    textParts.push(`\n[Error during agent execution: ${errMsg}]`)
    onProgress?.({ type: 'error', data: errMsg, agentId })
    terminalProgressEmitted = true
  }

  if (!terminalProgressEmitted) {
    if (hasError) {
      onProgress?.({ type: 'error', data: errorMessage || 'Sub-agent failed', agentId })
    } else {
      onProgress?.({ type: 'done', duration: Date.now() - startTime, agentId })
    }
  }

  // For built-in agents with callbacks, call the callback
  if (isBuiltInAgent(agentDefinition) && agentDefinition.callback) {
    agentDefinition.callback()
  }

  const duration = Date.now() - startTime
  logger.info('[SubAgent] runAgent completed', {
    agentId,
    agentType: agentDefinition.agentType,
    durationMs: duration,
    toolCalls,
    hasError,
    lastEventType,
    subAgentSessionId: sessionId,
  }, 'SubAgent')

  const resultMetadata: Record<string, unknown> = {
    agentToolCallCount: toolCalls,
    agentDurationMs: duration,
    agentStartTime: startTime,
    ...(hasError ? { agentError: errorMessage || 'Sub-agent failed' } : {}),
  }

  // Build content blocks including thinking if present
  const contentBlocks: MessageContent[] = []
  if (thinkingParts.length > 0) {
    contentBlocks.push({
      type: 'thinking',
      thinking: thinkingParts.join(''),
    })
  }
  const resultText = textParts.join('') || `[Agent ${agentDefinition.agentType}] completed successfully.`
  contentBlocks.push({
    type: 'text',
    text: resultText,
  })

  // Yield the result message
  yield {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: contentBlocks,
    timestamp: Date.now(),
    metadata: resultMetadata,
    ...(tokenUsage ? { token_usage: tokenUsage } : {}),
  } as Message

  // Persist sub-agent messages to its DB session so the session can be replayed
  if (sessionId) {
    const allMessages = subAgent.getMessages()
    if (allMessages.length > 0) {
      // Attach token usage to the last assistant message WITHOUT mutating the
      // original message object. The objects returned by getMessages() may be
      // shared with the sub-agent's internal state and the UI; an in-place
      // mutation would leak the token_usage field into those references.
      // Build a new array with a new message object only for that entry.
      let messagesToPersist: Message[] = [...allMessages]
      if (tokenUsage) {
        for (let i = allMessages.length - 1; i >= 0; i--) {
          if (allMessages[i].role === 'assistant') {
            messagesToPersist = allMessages.slice()
            messagesToPersist[i] = {
              ...allMessages[i],
              token_usage: tokenUsage,
            } as Message
            break
          }
        }
      }
      try {
        const persistResult = await appendMessages(sessionId, messagesToPersist)
        if (!persistResult.success) {
          logger.warn('[SubAgent] failed to persist messages', {
            subAgentSessionId: sessionId,
            count: persistResult.count,
          }, 'SubAgent')
        }
      } catch (err) {
        logger.warn('[SubAgent] persist messages threw', {
          subAgentSessionId: sessionId,
          err,
        }, 'SubAgent')
      }
    }
  }
}

/**
 * Run an agent synchronously and return the final result.
 * Still accepts an onProgress callback for real-time updates.
 */
export async function runAgentSync(
  params: RunAgentParams
): Promise<Message> {
  const messages: Message[] = []

  for await (const message of runAgent(params)) {
    messages.push(message)
  }

  return messages[messages.length - 1] || {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: [{
      type: 'text',
      text: '[Agent] No output generated',
    }],
    timestamp: Date.now(),
  }
}
