/**
 * StreamingToolExecutor (Enhanced) - Tool execution with concurrency control and progress feedback
 *
 * Enhanced features from claude-code-haha:
 * 1. Detailed progress tracking with stages (starting, running, completing)
 * 2. Tool execution statistics (duration, tokens, etc.)
 * 3. Progress callbacks for real-time UI updates
 * 4. Error categorization and recovery suggestions
 * 5. Tool grouping for related operations
 */

import type {
  Message,
  Tool,
  ToolResult,
  ToolUse,
  ToolUseContext,
  AgentProgressEvent,
} from '../types.js'
import type { ToolRegistry } from './registry.js'
import { ToolRetryExecutor } from './retry/ToolRetryExecutor.js'
import { DEFAULT_RETRY_STRATEGIES } from './retry/BuiltInStrategies.js'
import type { RetryStrategy } from './retry/types.js'
import { WorkerPool, getWorkerPool, type WorkerTask, type WorkerTaskExtended } from './WorkerPool.js'
import { ToolStreamBuffer } from './ToolStreamBuffer.js'
import { TransferableBuffer } from './TransferableBuffer.js'
import type { StreamChunk, BufferConfig } from './stream-types.js'
import { classifyTool } from './orchestration/classify.js'
import { ToolBatch, BATCH_STRATEGY } from './orchestration/types.js'
import { createChildAbortController } from '../abort/index.js'

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

/**
 * Tool execution status - enhanced with more states
 */
export type ToolStatus =
  | 'queued'
  | 'starting'
  | 'executing'
  | 'streaming'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'yielded'

/**
 * Progress stage for detailed status reporting
 */
export type ProgressStage =
  | 'initializing'
  | 'validating_input'
  | 'checking_permissions'
  | 'executing_command'
  | 'processing_results'
  | 'backgrounded'
  | 'finalizing'
  | 'completed'
  | 'error'

/**
 * Enhanced progress message structure
 */
export interface ToolProgress {
  toolUseId: string
  toolName: string
  status: ToolStatus
  stage: ProgressStage
  elapsedSeconds: number
  /** Estimated remaining time in seconds (if available) */
  estimatedRemaining?: number
  /** Percentage complete (0-100) */
  percentComplete?: number
  /** Current operation description */
  currentOperation?: string
  /** Additional data */
  data?: Record<string, unknown>
}

/**
 * Tool execution statistics
 */
export interface ToolExecutionStats {
  toolName: string
  toolUseId: string
  startTime: number
  endTime?: number
  duration?: number
  inputSize?: number
  outputSize?: number
  error?: string
  cancelledBy?: string
}

/**
 * Callback types for progress updates
 */
export type ProgressCallback = (progress: ToolProgress) => void
export type ToolStartCallback = (toolName: string, input: Record<string, unknown>) => void
export type ToolCompleteCallback = (stats: ToolExecutionStats) => void
export type ToolErrorCallback = (stats: ToolExecutionStats, error: Error) => void

/**
 * Tracked tool entry for monitoring execution state
 */
export interface TrackedTool {
  id: string
  block: ToolUse
  status: ToolStatus
  batch: ToolBatch
  promise?: Promise<void>
  results?: Message[]
  pendingProgress: Message[]
  elapsedSeconds: number
  error?: Error
  background?: boolean
  backgroundDone?: boolean

  // Enhanced fields
  stage: ProgressStage
  startTime: number
  endTime?: number
  percentComplete?: number
  currentOperation?: string
  stats: ToolExecutionStats
}

/**
 * Context passed during tool execution
 */
export interface ToolExecutionContext {
  abortController: AbortController
  tools: Tool[]
  canUseTool: (toolName: string) => Promise<boolean>
  toolUseContext: ToolUseContext
}

/**
 * Result from a single tool execution
 */
export interface ToolExecutionResult {
  message: Message
  contextModifier?: (context: ToolUseContext) => ToolUseContext
}

/**
 * Update from the executor containing messages and/or context changes
 */
export interface MessageUpdate {
  message?: Message
  newContext?: ToolUseContext
}

/**
 * Permission decision from canUseTool
 */
export interface CanUseToolDecision {
  allowed: boolean
  behavior?: 'allow' | 'ask' | 'deny'
}

/**
 * Callback type for checking if a tool can be used
 */
export type CanUseToolFn = (toolName: string) => Promise<boolean | CanUseToolDecision>

/**
 * Executor configuration options
 */
export interface ExecutorConfig {
  /** Interval between progress updates (ms) */
  progressIntervalMs?: number
  /** Maximum execution time per tool (ms) */
  maxExecutionTimeMs?: number
  /** Enable detailed progress tracking */
  enableDetailedProgress?: boolean
  /** Enable concurrent execution for safe tools */
  enableConcurrentExecution?: boolean
  /** Retry strategies for tool failures */
  retryStrategies?: RetryStrategy[]
  /** Enable automatic retry on tool failure */
  enableRetry?: boolean
  /** Maximum output size per tool (bytes). 0 = no limit. Default: 5MB */
  maxOutputSizeBytes?: number
  /** Memory warning threshold (MB). Default: 500 */
  memoryWarningThresholdMB?: number
  /** Tools that should run in worker processes (for streaming) */
  workerTools?: string[]
  /** Minimum execution time (ms) before delegating to worker */
  workerThresholdMs?: number
}



// ============================================================================
// MESSAGE CREATORS
// ============================================================================

/**
 * Creates an error tool message for tool execution errors
 */
function createErrorMessage(
  toolUseId: string,
  content: string,
  isError: boolean = true,
): Message {
  return {
    role: 'tool',
    content: `<tool_error>${content}</tool_error>`,
    tool_call_id: toolUseId,
    status: 'error',
  }
}

/**
 * Creates a permission required message (does not wrap in tool_error)
 */
function createPermissionRequiredMessage(
  toolUseId: string,
  content: string,
): Message {
  return {
    role: 'tool',
    content,
    tool_call_id: toolUseId,
  }
}

/**
 * Creates a detailed progress message for tool execution
 */
function createDetailedProgressMessage(
  tool: TrackedTool,
): Message {
  const progressData: Record<string, unknown> = {
    toolUseId: tool.id,
    toolName: tool.block.name,
    status: tool.status,
    stage: tool.stage,
    elapsedSeconds: Math.round(tool.elapsedSeconds * 10) / 10,
    percentComplete: tool.percentComplete ?? 0,
    currentOperation: tool.currentOperation,
  }

  return {
    role: 'user',
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(progressData),
        },
    ],
    metadata: {
      type: 'tool_progress',
      toolId: tool.id,
      toolName: tool.block.name,
    },
  } as Message
}

/**
 * Creates a simple progress message (backward compatible)
 */
function createSimpleProgressMessage(
  toolUseId: string,
  toolName: string,
  elapsedSeconds: number,
): Message {
  return {
    role: 'user',
    content: [
      {
        type: 'text' as const,
        text: `[Progress] ${toolName} (${toolUseId}): ${elapsedSeconds.toFixed(1)}s`,
      },
    ],
  }
}

function summarizeInputForLog(input: unknown): string {
  try {
    const raw = JSON.stringify(input)
    if (!raw) return '(empty)'
    return raw.length > 500 ? `${raw.slice(0, 500)}...` : raw
  } catch {
    return String(input)
  }
}

function normalizeWorkerInput(
  toolName: string,
  input: Record<string, unknown>,
): {
  input: Record<string, unknown>
  normalizationNote?: string
} {
  if (toolName.toLowerCase() !== 'bash') {
    return { input }
  }

  if (typeof input.command === 'string' && input.command.trim().length > 0) {
    return { input }
  }

  if (typeof input.cmd === 'string' && input.cmd.trim().length > 0) {
    return {
      input: { ...input, command: input.cmd },
      normalizationNote: 'normalized cmd -> command',
    }
  }

  if (typeof input.script === 'string' && input.script.trim().length > 0) {
    return {
      input: { ...input, command: input.script },
      normalizationNote: 'normalized script -> command',
    }
  }

  return { input }
}

// ============================================================================
// MAIN EXECUTOR CLASS
// ============================================================================

/**
 * StreamingToolExecutor manages concurrent tool execution with queue management
 * and detailed progress feedback.
 *
 * Features:
 * - Queue-based execution with concurrency control
 * - Detailed progress tracking with stages
 * - Real-time progress callbacks for UI updates
 * - Execution statistics collection
 * - Abort signal handling for cancellation
 * - Error handling with categorization
 */
export class StreamingToolExecutor {
  private tools: TrackedTool[] = []
  private toolUseContext: ToolUseContext
  private toolRegistry: ToolRegistry
  private hasErrored = false
  private erroredToolDescription = ''
  private discarded = false

  private siblingAbortController: AbortController
  private progressAvailableResolve?: () => void

  // Configuration
  private config: Required<ExecutorConfig>

  // Callbacks
  private onProgress?: ProgressCallback
  private onToolStart?: ToolStartCallback
  private onToolComplete?: ToolCompleteCallback
  private onToolError?: ToolErrorCallback

  // Statistics collector
  private allStats: ToolExecutionStats[] = []

  // Retry support
  private retryExecutor: ToolRetryExecutor
  private retryStrategies: RetryStrategy[]

  // Memory protection
  private totalOutputBytes = 0
  private memoryWarningCallback?: (currentMB: number, thresholdMB: number) => void

  // WeakRef cleanup support
  private readonly toolWeakRefs = new Set<WeakRef<TrackedTool>>()

  // Worker pool for long-running tools
  private workerPool?: WorkerPool
  private workerTools: Set<string>
  private workerThresholdMs: number

  // Tool stream buffer for high-frequency output
  private streamBuffer: ToolStreamBuffer
  private transferableBuffer: TransferableBuffer

  constructor(
    toolRegistry: ToolRegistry,
    private readonly canUseTool: CanUseToolFn,
    toolUseContext: ToolUseContext,
    config?: ExecutorConfig,
  ) {
    this.toolRegistry = toolRegistry
    this.toolUseContext = toolUseContext
    this.siblingAbortController = createChildAbortController(
      toolUseContext.abortController,
    )

    this.config = {
      progressIntervalMs: config?.progressIntervalMs ?? 1000,
      maxExecutionTimeMs: config?.maxExecutionTimeMs ?? 300000,
      enableDetailedProgress: config?.enableDetailedProgress ?? true,
      enableConcurrentExecution: config?.enableConcurrentExecution ?? true,
      retryStrategies: config?.retryStrategies ?? DEFAULT_RETRY_STRATEGIES,
      enableRetry: config?.enableRetry ?? true,
      maxOutputSizeBytes: config?.maxOutputSizeBytes ?? 5 * 1024 * 1024, // 5MB default
      memoryWarningThresholdMB: config?.memoryWarningThresholdMB ?? 500,
      workerTools: config?.workerTools ?? ['bash'],
      workerThresholdMs: config?.workerThresholdMs ?? 5000,
    }

    this.retryExecutor = new ToolRetryExecutor()
    this.retryStrategies = this.config.retryStrategies
    this.workerTools = new Set(this.config.workerTools)
    this.workerThresholdMs = this.config.workerThresholdMs

    // Initialize worker pool for streaming tools
    if (this.workerTools.size > 0) {
      this.workerPool = getWorkerPool()
    }

    // Initialize stream buffer for high-frequency output buffering
    this.streamBuffer = new ToolStreamBuffer({
      maxLines: 1000,
      maxBytes: 1024 * 1024,  // 1MB
      flushInterval: 50,         // 50ms
      maxChunkSize: 64 * 1024,  // 64KB
    })

    // Initialize transferable buffer for zero-copy transfer
    this.transferableBuffer = new TransferableBuffer()

    // Set up stream buffer flush handler
    this.streamBuffer.on('flush', (result: { toolUseId: string; items: StreamChunk[] }) => {
      this.handleBufferFlush(result.toolUseId, result.items)
    })
  }

  /**
   * Set callback handlers for progress events
   */
  setCallbacks(callbacks: {
    onProgress?: ProgressCallback
    onToolStart?: ToolStartCallback
    onToolComplete?: ToolCompleteCallback
    onToolError?: ToolErrorCallback
  }): void {
    this.onProgress = callbacks.onProgress
    this.onToolStart = callbacks.onToolStart
    this.onToolComplete = callbacks.onToolComplete
    this.onToolError = callbacks.onToolError
  }

  /**
   * Set memory warning callback
   */
  setMemoryWarningCallback(callback: (currentMB: number, thresholdMB: number) => void): void {
    this.memoryWarningCallback = callback
  }

  /**
   * Get current memory usage in MB (approximate)
   */
  getMemoryUsageMB(): number {
    if (typeof process !== 'undefined' && process.memoryUsage) {
      const usage = process.memoryUsage()
      return usage.heapUsed / 1024 / 1024
    }
    return 0
  }

  /**
   * Check memory and emit warning if threshold exceeded
   */
  private checkMemoryWarning(): void {
    const currentMB = this.getMemoryUsageMB()
    if (currentMB > this.config.memoryWarningThresholdMB && this.memoryWarningCallback) {
      this.memoryWarningCallback(currentMB, this.config.memoryWarningThresholdMB)
    }
  }

  /**
   * Calculate output size in bytes
   */
  private calculateOutputSize(messages: Message[]): number {
    let size = 0
    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        size += msg.content.length
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            size += block.text.length
          }
        }
      }
    }
    return size
  }

  /**
   * Truncate messages if they exceed max output size
   */
  private truncateOutput(messages: Message[], maxBytes: number): Message[] {
    const size = this.calculateOutputSize(messages)
    if (size <= maxBytes) return messages

    let currentSize = 0
    const truncated: Message[] = []

    for (const msg of messages) {
      const msgSize = this.calculateOutputSize([msg])
      if (currentSize + msgSize > maxBytes) {
        // Add truncation message
        truncated.push({
          role: 'tool',
          content: `... [Output truncated. Original size: ${size} bytes, limit: ${maxBytes} bytes]`,
          tool_call_id: msg.tool_call_id,
        })
        break
      }
      truncated.push(msg)
      currentSize += msgSize
    }

    return truncated
  }

  /**
   * Clean up WeakRefs to allow garbage collection
   */
  private cleanupWeakRefs(): void {
    for (const ref of this.toolWeakRefs) {
      const tool = ref.deref()
      if (tool === undefined) {
        this.toolWeakRefs.delete(ref)
      }
    }
  }

  /**
   * Discards all pending and in-progress tools
   */
  discard(): void {
    this.discarded = true
  }

  /**
   * Add a tool to the execution queue
   */
  addTool(block: ToolUse): void {
    const toolDefinition = this.toolRegistry.getTool(block.name)

    if (!toolDefinition) {
      this.tools.push({
        id: block.id,
        block,
        status: 'completed',
        batch: ToolBatch.SYSTEM,
        pendingProgress: [],
        elapsedSeconds: 0,
        stage: 'error',
        startTime: Date.now(),
        stats: {
          toolName: block.name,
          toolUseId: block.id,
          startTime: Date.now(),
          error: `No such tool available: ${block.name}`,
        },
        results: [
          createErrorMessage(
            block.id,
            `<tool_use_error>Error: No such tool available: ${block.name}</tool_use_error>`,
          ),
        ],
      })
      return
    }

    const batch = classifyTool(block.name)

    const trackedTool: TrackedTool = {
      id: block.id,
      block,
      status: 'queued',
      batch,
      pendingProgress: [],
      elapsedSeconds: 0,
      stage: 'initializing',
      startTime: Date.now(),
      stats: {
        toolName: block.name,
        toolUseId: block.id,
        startTime: Date.now(),
        inputSize: JSON.stringify(block.input).length,
      },
    }

    this.tools.push(trackedTool)

    void this.processQueue()
  }

  /**
   * Check if a tool can execute based on current concurrency state
   */
  private canExecuteTool(toolName: string, batch: ToolBatch): boolean {
    if (!this.config.enableConcurrentExecution) {
      const executingTools = this.tools.filter(t => t.status === 'executing')
      return executingTools.length === 0
    }

    const executingTools = this.tools.filter(t =>
      t.status === 'executing' || t.status === 'starting' || t.status === 'streaming'
    )

    if (executingTools.length === 0) return true

    const executingBatch = executingTools[0].batch
    const allSameBatch = executingTools.every(t => t.batch === executingBatch)

    if (!allSameBatch) return false

    if (batch !== executingBatch) return false

    if (batch === ToolBatch.READ) {
      return executingTools.length < BATCH_STRATEGY[ToolBatch.READ].maxConcurrency
    }

    if (batch === ToolBatch.SYSTEM) {
      const isNewSafe = this.toolRegistry.isToolConcurrencySafe(toolName)
      const allExistingSafe = executingTools.every(t =>
        this.toolRegistry.isToolConcurrencySafe(t.block.name)
      )
      if (isNewSafe && allExistingSafe) {
        return executingTools.length < BATCH_STRATEGY[ToolBatch.SYSTEM].maxConcurrency
      }
      return false
    }

    return false
  }

  /**
   * Check if a tool should be delegated to a worker process
   */
  private shouldDelegateToWorker(toolName: string): boolean {
    return (
      this.workerPool !== undefined &&
      this.workerTools.has(toolName) &&
      this.workerTools.size > 0
    )
  }

  /**
   * Execute tool in worker process (for streaming output)
   */
  private async executeInWorker(
    tool: TrackedTool,
    toolAbortController: AbortController,
  ): Promise<Message[]> {
    const messages: Message[] = []
    const startTime = Date.now()
    const input = (tool.block.input ?? {}) as Record<string, unknown>
    const { input: normalizedInput, normalizationNote } = normalizeWorkerInput(
      tool.block.name,
      input,
    )
    const commandPreview = (() => {
      const raw = normalizedInput?.command
      if (typeof raw !== 'string') return ''
      return raw.length > 200 ? `${raw.slice(0, 200)}...` : raw
    })()

    if (normalizationNote) {
      console.warn('[StreamingToolExecutor] executeInWorker:normalized-input', {
        toolId: tool.id,
        toolName: tool.block.name,
        note: normalizationNote,
      })
    }

    if (tool.block.name.toLowerCase() === 'bash' && !commandPreview) {
      const inputKeys = Object.keys(normalizedInput)
      console.error('[StreamingToolExecutor] executeInWorker:missing-command', {
        toolId: tool.id,
        toolName: tool.block.name,
        inputKeys,
        inputSummary: summarizeInputForLog(normalizedInput),
      })
      messages.push(
        createErrorMessage(
          tool.id,
          `<tool_use_error>Invalid bash input: missing required field "command". input keys: ${inputKeys.join(', ') || '(none)'}</tool_use_error>`,
        ),
      )
      return messages
    }

    // Use extended task with onOutput callback for stream buffering
    const task: WorkerTaskExtended = {
      id: tool.id,
      toolName: tool.block.name,
      input: normalizedInput,
      workingDirectory: this.toolUseContext.options.workingDirectory,
      abortController: toolAbortController,
      onOutput: (stream, data) => {
        // Only buffer actual output streams; progress is metadata only
        if (stream === 'stdout' || stream === 'stderr') {
          this.streamBuffer.addOutput(tool.id, stream, data)
        }
      },
      timeoutMs: typeof normalizedInput.timeout === 'number' ? normalizedInput.timeout : undefined,
    }

    tool.status = 'streaming'
    this.updateProgress(tool, {
      status: 'streaming',
      stage: 'executing_command',
      currentOperation: `Executing ${tool.block.name} in worker...`,
      percentComplete: 20,
    })

    try {
      console.log('[StreamingToolExecutor] executeInWorker:start', {
        toolId: tool.id,
        toolName: tool.block.name,
        hasCommand: !!commandPreview,
        commandPreview,
        inputKeys: Object.keys(normalizedInput),
      })
      const result = await this.workerPool!.executeTask(task)

      // Flush remaining buffered output
      this.streamBuffer.flush(tool.id)

      const duration = Date.now() - startTime
      console.log('[StreamingToolExecutor] executeInWorker:result', {
        toolId: tool.id,
        toolName: tool.block.name,
        success: result.success,
        durationMs: duration,
        error: result.error,
      })

      if (result.success) {
        const content = result.backgrounded
          ? `${result.result}\n\nBackground task info:\n- Task ID: ${tool.id}\n- PID: ${result.pid}\n- Output file: ${result.outputFile || 'N/A'}\n- Use task_output("${tool.id}") to check progress later.`
          : (typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result));

        messages.push({
          role: 'tool' as const,
          content,
          tool_call_id: tool.id,
          duration_ms: duration,
        })

        if (result.backgrounded) {
          tool.status = 'streaming'
          this.updateProgress(tool, {
            status: 'streaming',
            stage: 'backgrounded',
            currentOperation: `Background process (PID: ${result.pid})`,
            percentComplete: 50,
          })
        }
      } else {
        messages.push(
          createErrorMessage(
            tool.id,
            `<tool_use_error>${result.error || 'Worker execution failed'}</tool_use_error>`,
          ),
        )
      }

      tool.stats.duration = duration
    } catch (error) {
      // Flush buffer on error too
      this.streamBuffer.flush(tool.id)
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      console.error('[StreamingToolExecutor] executeInWorker:exception', {
        toolId: tool.id,
        toolName: tool.block.name,
        error: errorMsg,
      })
      messages.push(
        createErrorMessage(
          tool.id,
          `<tool_use_error>Worker error: ${errorMsg}</tool_use_error>`,
        ),
      )
    }

    return messages
  }

  /**
   * Update tool progress and emit callback
   */
  private updateProgress(tool: TrackedTool, update: Partial<ToolProgress>): void {
    if ('status' in update) tool.status = update.status!
    if ('stage' in update && update.stage) tool.stage = update.stage
    if ('percentComplete' in update) tool.percentComplete = update.percentComplete
    if ('currentOperation' in update) tool.currentOperation = update.currentOperation

    tool.elapsedSeconds = (Date.now() - tool.startTime) / 1000

    if (this.onProgress && this.config.enableDetailedProgress) {
      this.onProgress({
        toolUseId: tool.id,
        toolName: tool.block.name,
        status: tool.status,
        stage: tool.stage,
        elapsedSeconds: tool.elapsedSeconds,
        percentComplete: tool.percentComplete,
        currentOperation: tool.currentOperation,
        data: update.data,
      })
    }

    // Create progress message for streaming
    const progressMsg = this.config.enableDetailedProgress
      ? createDetailedProgressMessage(tool)
      : createSimpleProgressMessage(tool.id, tool.block.name, tool.elapsedSeconds)

    tool.pendingProgress.push(progressMsg)

    if (this.progressAvailableResolve) {
      this.progressAvailableResolve()
      this.progressAvailableResolve = undefined
    }
  }

  /**
   * Handle buffer flush - process batched stream output
   */
  private handleBufferFlush(toolUseId: string, chunks: StreamChunk[]): void {
    // Group chunks by stream type
    const stdoutChunks = chunks.filter(c => c.stream === 'stdout')
    const stderrChunks = chunks.filter(c => c.stream === 'stderr')

    const stdout = stdoutChunks.map(c => c.data).join('')
    const stderr = stderrChunks.map(c => c.data).join('')

    // Update tool output if we have a tracked tool
    const tool = this.tools.find(t => t.id === toolUseId)
    if (tool) {
      this.updateProgress(tool, {
        status: 'streaming',
        stage: 'executing_command',
        currentOperation: `Streaming ${tool.block.name}: ${stdout.slice(0, 50)}${stdout.length > 50 ? '...' : ''}`,
        percentComplete: 30,
        data: { stdout, stderr },
      })
    }

    // Emit output via onProgress callback if available
    if (this.onProgress && (stdout || stderr)) {
      this.onProgress({
        toolUseId,
        toolName: tool?.block.name ?? 'unknown',
        status: 'streaming',
        stage: 'executing_command',
        elapsedSeconds: tool ? (Date.now() - tool.startTime) / 1000 : 0,
        currentOperation: stdout || stderr,
        data: { stdout, stderr },
      })
    }
  }

  /**
   * Process the queue, starting tools when conditions allow
   */
  private async processQueue(): Promise<void> {
    for (const tool of this.tools) {
      if (tool.status !== 'queued') continue

      if (this.canExecuteTool(tool.block.name, tool.batch)) {
        tool.promise = this.executeTool(tool)
      } else {
        if (tool.batch !== ToolBatch.READ) break
      }
    }
  }

  /**
   * Execute a single tool with full progress tracking
   */
  private async executeTool(tool: TrackedTool): Promise<void> {
    // Starting phase
    tool.status = 'starting'
    tool.stage = 'initializing'
    this.updateProgress(tool, { status: 'starting', stage: 'initializing', currentOperation: 'Initializing...' })

    if (this.onToolStart) {
      this.onToolStart(tool.block.name, tool.block.input as Record<string, unknown>)
    }

    const startTime = Date.now()
    const messages: Message[] = []

    // Check abort conditions
    const initialAbortReason = this.getAbortReason(tool)
    if (initialAbortReason) {
      messages.push(this.createSyntheticErrorMessage(tool.id, initialAbortReason))
      this.finalizeTool(tool, messages, initialAbortReason)
      return
    }

    // Create per-tool abort controller
    const toolAbortController = createChildAbortController(this.siblingAbortController)

    // Validate input
    tool.stage = 'validating_input'
    this.updateProgress(tool, { stage: 'validating_input', currentOperation: 'Validating input...', percentComplete: 5 })

    // Check permissions
    tool.stage = 'checking_permissions'
    this.updateProgress(tool, { stage: 'checking_permissions', currentOperation: 'Checking permissions...', percentComplete: 10 })

    try {
      const canUseResult = await this.canUseTool(tool.block.name)
      const canUse = typeof canUseResult === 'boolean' ? canUseResult : canUseResult.allowed
      const canUseBehavior = typeof canUseResult === 'boolean' ? undefined : canUseResult.behavior

      if (!canUse) {
        messages.push(
          createErrorMessage(
            tool.id,
            `<tool_use_error>Permission denied: tool ${tool.block.name} cannot be used</tool_use_error>`,
          ),
        )
        this.finalizeTool(tool, messages, undefined, 'Permission denied')
        return
      }

      // Check if tool requires user confirmation via checkPermissions
      // Skip confirmation if canUseTool already granted permission (behavior === 'allow')
      const executor = this.toolRegistry.getExecutor(tool.block.name);
      if (executor && 'checkPermissions' in executor && canUseBehavior !== 'allow') {
        // Build proper ToolContext for permission check
        const toolContext = {
          toolUseId: tool.id,
          workingDirectory: this.toolUseContext.options.workingDirectory ?? process.cwd(),
          abortController: toolAbortController,
          sessionId: this.toolUseContext.options.sessionId ?? 'default',
          getAppState: this.toolUseContext.getAppState,
        };
        const permResult = (executor as { checkPermissions: (input: unknown, context: unknown) => { allowed: boolean; requiresUserConfirmation?: boolean; reason?: string } }).checkPermissions(tool.block.input, toolContext);
        if (permResult.requiresUserConfirmation && this.toolUseContext.requestPermission) {
          const permissionRequest = {
            id: crypto.randomUUID(),
            toolName: tool.block.name,
            toolInput: tool.block.input as Record<string, unknown>,
            mode: 'generic' as const,
            expiresAt: Date.now() + 5 * 60 * 1000,
            decisionReason: permResult.reason,
          };

          try {
            const decision = await this.toolUseContext.requestPermission(permissionRequest);

            if (decision === 'deny') {
              messages.push(
                createErrorMessage(tool.id, `<tool_error>Permission denied by user</tool_error>`)
              );
              this.finalizeTool(tool, messages, 'Permission denied');
              return;
            }

            // Permission granted - mark this tool use as approved in appState
            // so that tools can skip their internal permission checks
            if (decision === 'allow') {
              this.toolUseContext.setAppState((prev) => ({
                ...prev,
                _approvedToolUses: {
                  ...(prev._approvedToolUses as Record<string, boolean> || {}),
                  [tool.id]: true,
                },
              }));
            }
          } catch (permError) {
            messages.push(
              createErrorMessage(tool.id, `<tool_error>Permission request failed: ${permError instanceof Error ? permError.message : 'Unknown error'}</tool_error>`)
            );
            this.finalizeTool(tool, messages, 'Permission request failed');
            return;
          }
        }
      }

      // Start actual execution
      tool.status = 'executing'
      tool.stage = 'executing_command'

      // Check if this tool should run in a worker
      if (this.shouldDelegateToWorker(tool.block.name)) {
        const workerMessages = await this.executeInWorker(tool, toolAbortController)
        this.finalizeTool(tool, workerMessages)
        return
      }

      this.updateProgress(tool, {
        status: 'executing',
        stage: 'executing_command',
        currentOperation: `Executing ${tool.block.name}...`,
        percentComplete: 20,
      })

      // Set up timeout
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Tool execution timed out after ${this.config.maxExecutionTimeMs}ms`))
        }, this.config.maxExecutionTimeMs)
      })

      // For Agent tool, create a context with progress callback to stream sub-agent events
      const isAgentTool = tool.block.name === 'Agent'
      const toolContext: ToolUseContext = isAgentTool
        ? {
            ...this.toolUseContext,
            reportAgentProgress: (event: AgentProgressEvent) => {
              if (event.type === 'done') {
                tool.backgroundDone = true
              }
              // Convert sub-agent progress to tool progress messages
              const progressMsg = this.createAgentProgressMessage(tool, event)
              tool.pendingProgress.push(progressMsg)
              if (this.progressAvailableResolve) {
                this.progressAvailableResolve()
              }
            },
          }
        : this.toolUseContext

      // Execute with timeout
      const result = await Promise.race([
        this.toolRegistry.execute(
          tool.block.name,
          tool.block.input as Record<string, unknown>,
          this.toolUseContext.options.workingDirectory,
          toolContext
        ),
        timeoutPromise,
      ])

      // Process results
      tool.stage = 'processing_results'
      this.updateProgress(tool, { stage: 'processing_results', currentOperation: 'Processing results...', percentComplete: 80 })

      if (!result) {
        messages.push(
          createErrorMessage(
            tool.id,
            `<tool_use_error>Error: No such tool available: ${tool.block.name}</tool_use_error>`,
          ),
        )
        this.finalizeTool(tool, messages, undefined, 'Tool not found')
        return
      }

      if (result.error) {
        messages.push(
          createErrorMessage(
            tool.id,
            result.result,
            true,
          ),
        )

        if (tool.block.name.toLowerCase() === 'bash') {
          this.hasErrored = true
          this.erroredToolDescription = this.getToolDescription(tool)
          this.siblingAbortController.abort('sibling_error')
        }

        this.finalizeTool(tool, messages, undefined, result.error ? String(result.result) : undefined)
        return
      }

      // Success
      tool.stage = 'finalizing'
      this.updateProgress(tool, { stage: 'finalizing', currentOperation: 'Finalizing...', percentComplete: 95 })

      const resultContent = typeof result.result === 'string'
        ? result.result
        : JSON.stringify(result.result)

      // Check if result indicates a permission is required
      if (resultContent.includes('<tool_use_permission_required>')) {
        let permissionInfo = result.metadata?.permissionInfo as {
          id: string;
          toolName: string;
          toolInput: Record<string, unknown>;
          mode: 'generic' | 'ask_user_question' | 'exit_plan_mode';
          expiresAt: number;
          decisionReason?: string;
        } | undefined;

        if (!permissionInfo) {
          const match = resultContent.match(/<tool_use_permission_required>(.*?)<\/tool_use_permission_required>/);
          if (match) {
            try {
              permissionInfo = JSON.parse(match[1]);
            } catch {
              // Failed to parse, continue with basic info
            }
          }
        }

        if (permissionInfo && this.toolUseContext.requestPermission) {
          try {
            const decision = await this.toolUseContext.requestPermission(permissionInfo);

            if (decision === 'deny') {
              messages.push(
                createErrorMessage(tool.id, `<tool_error>Permission denied by user</tool_error>`)
              );
              this.finalizeTool(tool, messages, 'Permission denied');
              return;
            }

            // Permission granted - mark this tool use as approved and actually retry execution.
            // Previously we only emitted a "granted" message and returned, which caused
            // empty/no-op tool results after user approval.
            this.toolUseContext.setAppState((prev) => ({
              ...prev,
              _approvedToolUses: {
                ...(prev._approvedToolUses as Record<string, boolean> || {}),
                [tool.id]: true,
              },
            }));

            const retryResult = await this.toolRegistry.execute(
              tool.block.name,
              tool.block.input as Record<string, unknown>,
              this.toolUseContext.options.workingDirectory,
              this.toolUseContext
            );

            if (!retryResult) {
              messages.push(
                createErrorMessage(
                  tool.id,
                  `<tool_use_error>Error: No such tool available: ${tool.block.name}</tool_use_error>`,
                ),
              );
              this.finalizeTool(tool, messages, undefined, 'Tool not found');
              return;
            }

            if (retryResult.error) {
              messages.push(
                createErrorMessage(tool.id, retryResult.result, true),
              );
              this.finalizeTool(tool, messages, undefined, String(retryResult.result));
              return;
            }

            messages.push({
              role: 'tool' as const,
              content: typeof retryResult.result === 'string'
                ? retryResult.result
                : JSON.stringify(retryResult.result),
              tool_call_id: tool.id,
              duration_ms: Date.now() - startTime,
            });
            this.finalizeTool(tool, messages);
            return;

          } catch (permError) {
            messages.push(
              createErrorMessage(tool.id, `<tool_error>Permission request failed: ${permError instanceof Error ? permError.message : 'Unknown error'}</tool_error>`)
            );
            this.finalizeTool(tool, messages, 'Permission request failed');
            return;
          }
        }

        // No requestPermission callback available - treat as denied
        messages.push({
          role: 'tool' as const,
          content: `<tool_error>Permission system not configured</tool_error>`,
          tool_call_id: tool.id,
        });
        this.finalizeTool(tool, messages, 'Permission system not configured');
        return;
      }

      messages.push({
        role: 'tool' as const,
        content: resultContent,
        tool_call_id: tool.id,
        duration_ms: Date.now() - startTime,
      })

      const isBackground =
        tool.block.name === 'Agent' &&
        resultContent.includes('"background":true')
      if (isBackground) {
        tool.background = true
        tool.backgroundDone = false
      }

      this.finalizeTool(tool, messages)

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'

      // Check if we should retry with fallback strategies
      if (this.config.enableRetry && this.retryStrategies.length > 0) {
        const retryResult = await this.retryExecutor.executeWithRetry(
          {
            toolUseId: tool.id,
            toolName: tool.block.name,
            toolInput: tool.block.input as Record<string, unknown>,
          },
          this.retryStrategies,
          async (toolName, toolInput) => {
            try {
              const execResult = await this.toolRegistry.execute(
                toolName,
                toolInput,
                this.toolUseContext.options.workingDirectory,
                this.toolUseContext
              )
              // Handle null case (tool not found)
              if (execResult === null) {
                return { error: `Tool not found: ${toolName}` }
              }
              // Convert ToolResult error format to what ToolRetryExecutor expects
              // error?: boolean → error?: string
              const errorStr = execResult.error ? String(execResult.result) : undefined
              return { result: execResult.result ?? undefined, error: errorStr }
            } catch (e) {
              return { error: e instanceof Error ? e.message : String(e) }
            }
          }
        )

        // If retry succeeded, update messages and continue
        if (retryResult.success && retryResult.result !== undefined) {
          const resultContent = typeof retryResult.result === 'string'
            ? retryResult.result
            : JSON.stringify(retryResult.result)

          messages.push({
            role: 'tool' as const,
            content: resultContent,
            tool_call_id: tool.id,
            duration_ms: Date.now() - startTime,
          })

          this.finalizeTool(tool, messages)
          return
        }

        // If fallback was used, log it
        if (retryResult.finalAction === 'fallback') {
          const fallbackNote = `Fallback executed after ${retryResult.attempts} attempt(s)`
          console.log(`[ToolRetry] ${tool.block.name}: ${fallbackNote}`)
        }
      }

      // Retry failed or disabled - emit error
      messages.push(
        createErrorMessage(
          tool.id,
          `<tool_use_error>Error executing ${tool.block.name}: ${errorMessage}</tool_use_error>`,
        ),
      )

      if (tool.block.name.toLowerCase() === 'bash') {
        this.hasErrored = true
        this.erroredToolDescription = this.getToolDescription(tool)
        this.siblingAbortController.abort('sibling_error')
      }

      this.finalizeTool(tool, messages, errorMessage)
    }
  }

  /**
   * Finalize tool execution and record statistics
   */
  private finalizeTool(
    tool: TrackedTool,
    messages: Message[],
    errorReason?: string,
    errorDetail?: string,
  ): void {
    tool.endTime = Date.now()

    // Apply output size limit if configured
    if (this.config.maxOutputSizeBytes > 0) {
      const outputSize = this.calculateOutputSize(messages)
      if (outputSize > this.config.maxOutputSizeBytes) {
        messages = this.truncateOutput(messages, this.config.maxOutputSizeBytes)
        console.warn(`[StreamingToolExecutor] Output truncated for ${tool.block.name}: ${outputSize} -> ${this.config.maxOutputSizeBytes} bytes`)
      }
    }

    tool.results = messages
    tool.status = errorReason ? 'failed' : 'completed'
    tool.stage = errorReason ? 'error' : 'completed'
    tool.elapsedSeconds = (tool.endTime - tool.startTime) / 1000
    tool.percentComplete = 100

    // Track output size
    const outputSize = this.calculateOutputSize(messages)
    this.totalOutputBytes += outputSize

    // Check memory warning
    this.checkMemoryWarning()

    // Update stats
    tool.stats = {
      ...tool.stats,
      endTime: tool.endTime,
      duration: tool.elapsedSeconds,
      outputSize,
      error: errorDetail || errorReason,
    }

    this.allStats.push(tool.stats)

    // Add WeakRef for cleanup tracking
    this.toolWeakRefs.add(new WeakRef(tool))

    // Periodic WeakRef cleanup (every 10 tools)
    if (this.tools.length % 10 === 0) {
      this.cleanupWeakRefs()
    }

    // Emit final progress
    this.updateProgress(tool, {
      status: tool.status,
      stage: tool.stage,
      percentComplete: 100,
      currentOperation: errorReason ? `Failed: ${errorReason}` : 'Completed',
    })

    // Call completion/error callbacks
    if (errorReason) {
      if (this.onToolError) {
        this.onToolError(tool.stats, tool.error || new Error(errorDetail || errorReason))
      }
    } else {
      if (this.onToolComplete) {
        this.onToolComplete(tool.stats)
      }
    }
  }

  /**
   * Get abort reason for a tool
   */
  private getAbortReason(
    tool: TrackedTool,
  ): 'sibling_error' | 'user_interrupted' | 'streaming_fallback' | null {
    if (this.discarded) return 'streaming_fallback'
    if (this.hasErrored) return 'sibling_error'
    if (this.toolUseContext.abortController.signal.aborted) return 'user_interrupted'
    return null
  }

  /**
   * Create synthetic error message for cancelled tools
   */
  private createSyntheticErrorMessage(
    toolUseId: string,
    reason: 'sibling_error' | 'user_interrupted' | 'streaming_fallback',
  ): Message {
    if (reason === 'user_interrupted') {
      return createErrorMessage(toolUseId, '<tool_use_error>Tool use was interrupted by user</tool_use_error>')
    }
    if (reason === 'streaming_fallback') {
      return createErrorMessage(toolUseId, '<tool_use_error>Error: Streaming fallback - tool execution discarded</tool_use_error>')
    }

    const desc = this.erroredToolDescription
    const msg = desc
      ? `Cancelled: parallel tool call ${desc} errored`
      : 'Cancelled: parallel tool call errored'

    return createErrorMessage(toolUseId, `<tool_use_error>${msg}</tool_use_error>`)
  }

  /**
   * Get human-readable tool description
   */
  private getToolDescription(tool: TrackedTool): string {
    const input = tool.block.input as Record<string, unknown> | undefined
    const summary =
      input?.command ?? input?.file_path ?? input?.pattern ?? input?.prompt ?? ''

    if (typeof summary === 'string' && summary.length > 0) {
      const truncated = summary.length > 40 ? summary.slice(0, 40) + '\u2026' : summary
      return `${tool.block.name}(${truncated})`
    }
    return tool.block.name
  }

  // ==========================================================================
  // RESULT GENERATORS
  // ==========================================================================

  /**
   * Get any completed results that haven't been yielded yet (non-blocking)
   */
  *getCompletedResults(): Generator<MessageUpdate, void> {
    if (this.discarded) return

    for (const tool of this.tools) {
      while (tool.pendingProgress.length > 0) {
        const progressMessage = tool.pendingProgress.shift()!
        yield { message: progressMessage, newContext: this.toolUseContext }
      }

      if (tool.status === 'yielded') continue

      if ((tool.status === 'completed' || tool.status === 'failed' || tool.status === 'cancelled') && tool.results) {
        if (tool.background && !tool.backgroundDone) {
          continue
        }
        tool.status = 'yielded'

        for (const message of tool.results) {
          yield { message, newContext: this.toolUseContext }
        }
      } else if (tool.status === 'executing' && tool.batch !== ToolBatch.READ) {
        break
      }
    }
  }

  /**
   * Wait for remaining tools and yield their results as they complete
   */
  async *getRemainingResults(): AsyncGenerator<MessageUpdate, void> {
    if (this.discarded) return

    while (this.hasUnfinishedTools()) {
      await this.processQueue()

      for (const result of this.getCompletedResults()) {
        yield result
      }

      if (
        this.hasExecutingTools() &&
        !this.hasCompletedResults() &&
        !this.hasPendingProgress()
      ) {
        const executingPromises = this.tools
          .filter(
            t =>
              (t.status === 'executing' ||
                t.status === 'starting' ||
                t.status === 'streaming') &&
              t.promise
          )
          .map(t => t.promise!)

        const progressPromise = new Promise<void>(resolve => {
          this.progressAvailableResolve = resolve
        })

        if (executingPromises.length > 0) {
          await Promise.race([...executingPromises, progressPromise])
        } else {
          // Fallback to avoid a tight loop when states are temporarily out of sync.
          await new Promise(resolve => setTimeout(resolve, 10))
        }
      } else if (
        !this.hasExecutingTools() &&
        !this.hasCompletedResults() &&
        !this.hasPendingProgress() &&
        this.hasUnfinishedTools()
      ) {
        // Background tools are waiting for completion; wait for progress events
        const progressPromise = new Promise<void>(resolve => {
          this.progressAvailableResolve = resolve
        })
        await Promise.race([
          progressPromise,
          new Promise(resolve => setTimeout(resolve, 5000)),
        ])
      }
    }

    for (const result of this.getCompletedResults()) {
      yield result
    }
  }

  // ==========================================================================
  // STATUS HELPERS
  // ==========================================================================

  private hasPendingProgress(): boolean {
    return this.tools.some(t => t.pendingProgress.length > 0)
  }

  private hasCompletedResults(): boolean {
    return this.tools.some(t => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled')
  }

  private hasExecutingTools(): boolean {
    return this.tools.some(
      t =>
        t.status === 'executing' ||
        t.status === 'starting' ||
        t.status === 'streaming'
    )
  }

  private hasUnfinishedTools(): boolean {
    return this.tools.some(
      t =>
        t.status !== 'yielded' ||
        (t.background === true && !t.backgroundDone)
    )
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  /**
   * Get all tracked tools with their current status
   */
  getTools(): TrackedTool[] {
    return this.tools
  }

  /**
   * Get current progress for all tools
   */
  getProgress(): ToolProgress[] {
    return this.tools.map(tool => ({
      toolUseId: tool.id,
      toolName: tool.block.name,
      status: tool.status,
      stage: tool.stage,
      elapsedSeconds: tool.elapsedSeconds,
      percentComplete: tool.percentComplete,
      currentOperation: tool.currentOperation,
    }))
  }

  /**
   * Get execution statistics for all completed tools
   */
  getStatistics(): ToolExecutionStats[] {
    return [...this.allStats]
  }

  /**
   * Get total execution time across all tools
   */
  getTotalExecutionTime(): number {
    if (this.allStats.length === 0) return 0

    const start = Math.min(...this.allStats.map(s => s.startTime))
    const end = Math.max(...this.allStats.map(s => s.endTime ?? Date.now()))
    return (end - start) / 1000
  }

  /**
   * Get the updated context
   */
  getUpdatedContext(): ToolUseContext {
    return this.toolUseContext
  }

  /**
   * Check if there are any active/queued tools
   */
  isActive(): boolean {
    return this.tools.some(t =>
      t.status === 'queued' ||
      t.status === 'starting' ||
      t.status === 'executing' ||
      t.status === 'streaming'
    )
  }

  /**
   * Create a progress message from a sub-agent progress event.
   * This allows the UI to see what the sub-agent is doing in real-time.
   */
  private createAgentProgressMessage(
    tool: TrackedTool,
    event: AgentProgressEvent
  ): Message {
    const progressData: Record<string, unknown> = {
      toolUseId: tool.id,
      toolName: tool.block.name,
      agentEventType: event.type,
      agentData: event.data,
      agentToolName: event.toolName,
      agentToolInput: event.toolInput,
      agentToolResult: event.toolResult,
      agentDuration: event.duration,
      elapsedSeconds: Math.round(tool.elapsedSeconds * 10) / 10,
    }

    return {
      role: 'user',
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(progressData),
        },
      ],
      metadata: {
        type: 'agent_progress',
        toolId: tool.id,
        toolName: tool.block.name,
        agentEvent: event,
      },
    } as Message
  }
}

export default StreamingToolExecutor
