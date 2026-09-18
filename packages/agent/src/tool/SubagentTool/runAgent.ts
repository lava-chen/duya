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
import { resolveAgentTools, SUBAGENT_FORBIDDEN_TOOLS } from './subagentToolUtils.js'
import { ToolRegistry } from '../registry.js'
import { getPromptProfileForSubagentType } from '../../prompts/modes/index.js'
import { PromptsRegistry } from '../../prompts/registry.js'
import type { PromptSystem } from '../../prompts/PromptSystem.js'
import { appendMessages } from '../../session/db.js'; // eslint-disable-line @typescript-eslint/no-unused-vars
import type { TokenUsage } from '../../types.js'
import { logger } from '../../utils/logger.js'
import { composeSubagentSystemPrompt } from './promptComposition.js'
import { isSubagentSlimAgentsMdEnabled } from '../../config/feature-flags.js'

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

/**
 * If the sub-agent emits no SSE event within this window while it is idle
 * (no tool in flight), the stream is assumed dead. This is a backstop: the
 * AI layer already enforces a 120s per-chunk stream idle timeout that
 * surfaces stalled provider streams through the retry path first, so this
 * watchdog only catches a stream that is genuinely wedged.
 */
const SUBAGENT_IDLE_STALL_TIMEOUT_MS = 5 * 60 * 1000
/**
 * While a tool is executing no SSE events are emitted until it returns, so a
 * legitimate long tool call (browser automation, tests, big builds) must not
 * trip the idle stall watchdog. Each tool already enforces its own timeout;
 * this is only a generous backstop against a tool executor that never
 * resolves.
 */
const SUBAGENT_TOOL_STALL_TIMEOUT_MS = 30 * 60 * 1000

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

  // Determine max turns — no implicit fallback (pi-aligned). If neither
  // the caller's `maxTurns` nor `agentDefinition.maxTurns` is set, the
  // child agent runs uncapped and exits on natural completion, token
  // exhaustion, abort, or a tool `terminate: true` signal.
  const agentMaxTurns = maxTurns ?? agentDefinition.maxTurns

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

  // Resolve a PromptSystem for the 'general' config with this subagent's profile.
  // Subagents always use the general prompt system; the profile gates which
  // sections render (e.g. fork drops memory/skills/personality).
  const promptSystem: PromptSystem | undefined = PromptsRegistry.getOrCreate('general', promptProfile)
  if (!promptSystem) {
    const errorMsg = `[Agent ${agentDefinition.agentType}] Error: 'general' prompt system not registered`
    logger.error('[SubAgent] general prompt system missing', undefined, {
      agentId,
      agentType: agentDefinition.agentType,
    }, 'SubAgent')
    onProgress?.({ type: 'error', data: errorMsg, agentId })
    yield {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: [{ type: 'text', text: errorMsg }],
      timestamp: Date.now(),
      metadata: { agentError: errorMsg },
    }
    return
  }

  // Create real tool registry with actual tool executors
  const { createBuiltinRegistry } = await import('../builtin.js')
  const registry = createBuiltinRegistry()
  const allTools = registry.getAllTools()
  const toolNames = new Set(resolvedTools.map(t => t.name))
  let toolsToUse = toolNames.size > 0
    ? allTools.filter(t => toolNames.has(t.name))
    : allTools

  // Prevent recursive agent calls - strip every agent-orchestration tool
  // (subagent spawn, inter-agent messaging, background-task management) from
  // sub-agents so a sub-agent can never spawn or delegate to another agent.
  toolsToUse = toolsToUse.filter(t => !SUBAGENT_FORBIDDEN_TOOLS.has(t.name))

  // Inherit the parent's live MCP tools when the agent opts in via `mcpTools`.
  // The parent captures the MCP client inside the executor closure, so the
  // sub-agent reuses the already-connected runtime instead of reconnecting
  // servers. Definition + executor are merged into the sub-agent's registry
  // and tool surface; forbidden orchestration tools are still withheld.
  if (agentDefinition.mcpTools) {
    const mcpExecutors = toolUseContext.options.mcpToolExecutors
    const mcpTools = availableTools.filter(
      (t) => t.mcpInfo && !SUBAGENT_FORBIDDEN_TOOLS.has(t.name),
    )
    for (const mcpTool of mcpTools) {
      const executor = mcpExecutors?.get(mcpTool.name)
      if (!executor) continue
      registry.registerWithKey(mcpTool.internalKey ?? mcpTool.name, mcpTool, executor)
      if (!toolsToUse.some((t) => t.name === mcpTool.name)) {
        toolsToUse.push(mcpTool)
      }
    }
  }

  const omitAgentsMd =
    agentDefinition.omitClaudeMd === true &&
    isSubagentSlimAgentsMdEnabled()
  const context = promptSystem.buildContext({
    sessionId,
    workingDirectory,
    modelId: agentModel,
    modelName: agentModel,
    language: toolUseContext.options.language,
    enabledTools: new Set(toolsToUse.map(tool => tool.name)),
    omitAgentsMd,
    // Plan 525 / 408 follow-up: pass the project-entity home into the
    // sub-agent's promptSystem.buildContext so the preBuildHook can
    // load `<projectHome>/AGENTS.md` as a `'Project entity'` source.
    // Read from the parent's ToolUseContext.options when available;
    // undefined when the session is not bound to a registered duya project.
    projectHome: toolUseContext.options.projectHome,
  })
  const systemPromptResult = await promptSystem.buildSystemPrompt(context)
  const harnessPrompt = [...systemPromptResult].join('\n\n')
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
    // Plan 525 / 408 follow-up: project-entity home directory
    // propagated into the sub-agent instance so any further
    // _buildSystemPrompt call inside the sub-agent (e.g. for further
    // sub-spawns) keeps the entity-home binding. Undefined when the
    // parent has no projectHome.
    projectHome: toolUseContext.options.projectHome,
    omitAgentsMd,
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
  // True between a tool_use and its tool_result: no SSE events are emitted
  // while a tool is executing, so the stall watchdog must not treat a long
  // tool call as a dead stream.
  let toolInFlight = false
  // Plan 441: the 3-second `persistInterval` was deleted. Sub-agents are
  // `DuyaAgent` instances and inherit the per-event Journal from the agent
  // core: every `_pushDurable` boundary (user_msg_added,
  // assistant_message_finalized, tool_result_added) lands in the rollout
  // immediately, so the manual tail-append + `lastPersistedIndex` slice is
  // redundant. The wiring in `SubagentTool.ts` constructs the sub-agent via
  // `new duyaAgent({...})` exactly like the main agent, and the Journal
  // fires automatically.

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
        const stallMs = toolInFlight
          ? SUBAGENT_TOOL_STALL_TIMEOUT_MS
          : SUBAGENT_IDLE_STALL_TIMEOUT_MS
        const stallTimeoutPromise = new Promise<IteratorResult<SSEEvent>>((_, reject) => {
          stallTimer = setTimeout(() => {
            reject(
              new Error(
                `Sub-agent stalled: no events for ${Math.round(stallMs / 1000)}s${toolInFlight ? ' (tool in flight)' : ''}`
              )
            )
          }, stallMs)
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
          toolInFlight = true
          const toolData = event.data as { name: string; input: Record<string, unknown> } | undefined
          onProgress?.({
            type: 'tool_use',
            toolName: toolData?.name || '',
            toolInput: toolData?.input,
            agentId,
          })
        } else if (event.type === 'tool_result') {
          toolInFlight = false
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
      // Plan 441: the final `appendMessages` flush is no longer needed.
      // Every sub-agent message boundary was already persisted by the
      // journal trigger at the moment `_pushDurable` ran (see the
      // 3-second-tick comment above for the unified rationale). We still
      // attach the tokenUsage to the last assistant message in-memory so
      // a subsequent load-from-DB round-trip carries the usage, but we do
      // NOT emit a redundant append.
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
      // Suppress unused-variable warning while keeping the in-memory
      // mutation above for future re-emit if a manual persist is ever
      // re-introduced. The message shape is updated for the next turn's
      // projection (load → setMessages).
      void messagesToPersist;
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
