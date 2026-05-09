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
import { resolveAgentTools } from './agentToolUtils.js'
import { ToolRegistry } from '../registry.js'
import { getPromptProfileForSubagentType } from '../../prompts/modes/index.js'
import { PromptManager } from '../../prompts/PromptManager.js'
import { replaceMessages } from '../../session/db.js'
import { messageDb } from '../../ipc/db-client.js'

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
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'done' | 'error'
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
  onProgress,
  sessionId,
}: RunAgentParams): RunAgentResult {
  const startTime = Date.now()
  const agentId = crypto.randomUUID()

  // Resolve the agent's system prompt
  const systemPrompt = getAgentSystemPrompt(agentDefinition, toolUseContext)

  // Log agent start
  console.log(`[AgentTool] Starting agent ${agentDefinition.agentType} (${agentId})`)
  if (description) {
    console.log(`[AgentTool] Description: ${description}`)
  }

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

  // Get API configuration from parent context
  const apiKey = toolUseContext.options.apiKey || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY
  if (!apiKey) {
    const errorMsg = `[Agent ${agentDefinition.agentType}] Error: No API key available for sub-agent execution`
    yield {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: [{
        type: 'text',
        text: errorMsg,
      }],
      timestamp: Date.now(),
    }
    return
  }

  // Determine prompt profile based on subagent type
  const promptProfile = getPromptProfileForSubagentType(agentDefinition.agentType)

  // Create a PromptManager with the appropriate profile for this subagent
  const subAgentPromptManager = new PromptManager({
    workingDirectory: process.cwd(),
    modelId: agentModel,
    promptProfile,
  })

  // Create a new agent instance for the sub-agent
  const subAgent = new duyaAgent({
    apiKey,
    baseURL: toolUseContext.options.baseURL,
    model: agentModel,
    authStyle: toolUseContext.options.authStyle,
    provider: toolUseContext.options.provider,
    systemPrompt,
    workingDirectory: process.cwd(),
    promptManager: subAgentPromptManager,
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

  const textParts: string[] = []
  const thinkingParts: string[] = []
  let toolCalls = 0
  let hasError = false
  let errorMessage = ''
  let lastEventType: SSEEvent['type'] | 'none' = 'none'
  let lastEventAt = Date.now()

  let persistGeneration = 0
  const persistInterval = sessionId ? setInterval(async () => {
    const allMessages = subAgent.getMessages()
    if (allMessages.length === 0) return
    try {
      const result = await replaceMessages(sessionId, allMessages, persistGeneration)
      if (result.success) {
        persistGeneration = (result as unknown as { newGeneration?: number }).newGeneration ?? persistGeneration + 1
      }
    } catch {
      // periodic persist failure is non-critical
    }
  }, 3000) : null

  try {
    // Create an abort controller for the sub-agent, linked to parent's abort controller
    const subAgentAbort = new AbortController()
    const onParentAbort = () => {
      console.log(`[AgentTool] Parent abort triggered for agent ${agentDefinition.agentType}, stopping sub-agent`)
      subAgentAbort.abort()
    }
    toolUseContext.abortController.signal.addEventListener('abort', onParentAbort)

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
          console.error('[AgentTool] Sub-agent stalled', {
            agentId,
            agentType: agentDefinition.agentType,
            elapsedMs: now - startTime,
            noEventForMs: now - lastEventAt,
            lastEventType,
            toolCalls,
            promptLength: promptText.length,
          })
          textParts.push(`\n[Error during agent execution: ${stallMessage}]`)
          onProgress?.({ type: 'error', data: stallMessage, agentId })
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
        lastEventType = event.type
        lastEventAt = Date.now()
        lastProgressTime = Date.now()

        // Check if parent has requested abort
        if (toolUseContext.abortController.signal.aborted) {
          console.log(`[AgentTool] Aborting agent ${agentDefinition.agentType} due to parent abort`)
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
        } else if (event.type === 'done') {
          onProgress?.({ type: 'done', duration: Date.now() - startTime, agentId })
          break
        } else if (event.type === 'error') {
          const errorData = typeof event.data === 'string' ? event.data : JSON.stringify(event.data)
          errorMessage = errorData
          hasError = true
          console.error('[AgentTool] Sub-agent error event', {
            agentId,
            agentType: agentDefinition.agentType,
            error: errorData,
            toolCalls,
          })
          textParts.push(`\n[Error: ${errorData}]`)
          onProgress?.({ type: 'error', data: errorData, agentId })
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
    console.error('[AgentTool] runAgent failed', {
      agentId,
      agentType: agentDefinition.agentType,
      error: errMsg,
      toolCalls,
      lastEventType,
      elapsedMs: Date.now() - startTime,
    })
    textParts.push(`\n[Error during agent execution: ${errMsg}]`)
    onProgress?.({ type: 'error', data: errMsg, agentId })
  }

  // For built-in agents with callbacks, call the callback
  if (isBuiltInAgent(agentDefinition) && agentDefinition.callback) {
    agentDefinition.callback()
  }

  const duration = Date.now() - startTime
  console.log(`[AgentTool] Agent ${agentDefinition.agentType} completed in ${duration}ms with ${toolCalls} tool calls`)

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
  }

  // Persist sub-agent messages to its DB session so the session can be replayed
  if (sessionId) {
    const allMessages = subAgent.getMessages()
    if (allMessages.length > 0) {
      try {
        const persistResult = await replaceMessages(sessionId, allMessages, persistGeneration)
        if (!persistResult.success) {
          console.warn(`[AgentTool] Failed to persist sub-agent messages: ${persistResult.reason}`)
        }
      } catch (err) {
        console.warn('[AgentTool] Failed to persist sub-agent messages:', err)
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
