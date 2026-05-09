/**
 * ToolStreamBuffer - Ring buffer for tool output streaming
 *
 * Features:
 * - Circular buffer with configurable max lines/bytes
 * - Automatic old data eviction when limits reached
 * - Batch flushing at configurable intervals
 * - Pause/resume functionality
 * - Memory-efficient design
 * - Zero-copy transfer support via TransferableBuffer
 */

import { EventEmitter } from 'events';
import { BufferConfig, BufferStats, DEFAULT_BUFFER_CONFIG, StreamChunk, StreamType } from './stream-types.js';

// Re-export types for external use
export type { StreamChunk, StreamType, BufferConfig, BufferStats } from './stream-types.js';

// =============================================================================
// TYPES & INTERFACES
// =============================================================================

export interface FlushResult {
  toolUseId: string;
  items: StreamChunk[];
  byteSize: number;
}

// =============================================================================
// RING BUFFER
// =============================================================================

/**
 * Efficient circular buffer implementation
 */
class RingBuffer<T> {
  private buffer: (T | undefined)[];
  private head = 0;  // Next write position
  private tail = 0;  // Next read position
  private _size = 0;
  private capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
  }

  /**
   * Add an item to the buffer
   */
  push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;

    if (this._size < this.capacity) {
      this._size++;
    } else {
      // Buffer is full, move tail forward (evict oldest)
      this.tail = (this.tail + 1) % this.capacity;
    }
  }

  /**
   * Remove and return the oldest item
   */
  shift(): T | undefined {
    if (this._size === 0) return undefined;

    const item = this.buffer[this.tail];
    this.buffer[this.tail] = undefined;
    this.tail = (this.tail + 1) % this.capacity;
    this._size--;
    return item;
  }

  /**
   * Drain all items from the buffer
   */
  drain(): T[] {
    const result: T[] = [];
    while (this._size > 0) {
      const item = this.shift();
      if (item !== undefined) {
        result.push(item);
      }
    }
    return result;
  }

  /**
   * Get current number of items
   */
  get size(): number {
    return this._size;
  }

  /**
   * Check if buffer is empty
   */
  get isEmpty(): boolean {
    return this._size === 0;
  }

  /**
   * Clear the buffer
   */
  clear(): void {
    this.buffer = new Array(this.capacity);
    this.head = 0;
    this.tail = 0;
    this._size = 0;
  }
}

// =============================================================================
// TOOL STREAM BUFFER
// =============================================================================

export class ToolStreamBuffer extends EventEmitter {
  private buffers = new Map<string, RingBuffer<StreamChunk>>();
  private byteSizes = new Map<string, number>();
  private flushTimers = new Map<string, NodeJS.Timeout>();
  private pausedTools = new Set<string>();
  private config: BufferConfig;

  // Per-tool statistics
  private toolStats = new Map<string, BufferStats>();

  constructor(config: Partial<BufferConfig> = {}) {
    super();
    this.config = { ...DEFAULT_BUFFER_CONFIG, ...config };
  }

  // =============================================================================
  // BUFFER MANAGEMENT
  // =============================================================================

  /**
   * Add output to the buffer for a specific tool
   */
  addOutput(toolUseId: string, stream: StreamType, data: string): void {
    // Don't buffer if paused
    if (this.pausedTools.has(toolUseId)) {
      return;
    }

    // Truncate data if it exceeds max chunk size
    let processedData = data;
    const dataBytes = Buffer.byteLength(data, 'utf8');
    if (dataBytes > this.config.maxChunkSize) {
      processedData = data.slice(0, this.config.maxChunkSize);
      console.warn(`[ToolStreamBuffer] Data truncated for ${toolUseId}: ${dataBytes} > ${this.config.maxChunkSize}`);
    }

    let buffer = this.buffers.get(toolUseId);
    if (!buffer) {
      buffer = new RingBuffer<StreamChunk>(this.config.maxLines);
      this.buffers.set(toolUseId, buffer);
      this.byteSizes.set(toolUseId, 0);
      // Initialize stats for this tool
      this.toolStats.set(toolUseId, {
        totalLines: 0,
        totalBytes: 0,
        droppedLines: 0,
        flushCount: 0,
      });
    }

    const currentBytes = this.byteSizes.get(toolUseId) || 0;

    // Check if we need to make space
    if (currentBytes + processedData.length > this.config.maxBytes) {
      this.makeSpace(toolUseId, processedData.length);
    }

    const item: StreamChunk = {
      stream,
      data: processedData,
      timestamp: Date.now(),
    };

    buffer.push(item);
    const newByteSize = (this.byteSizes.get(toolUseId) || 0) + processedData.length;
    this.byteSizes.set(toolUseId, newByteSize);

    // Update stats
    const stats = this.toolStats.get(toolUseId);
    if (stats) {
      stats.totalLines++;
      stats.totalBytes += processedData.length;
    }

    // Emit item added event
    this.emit('item', { toolUseId, item });

    // Schedule batch flush
    this.scheduleFlush(toolUseId);
  }

  /**
   * Make space by evicting old data
   */
  private makeSpace(toolUseId: string, neededBytes: number): void {
    const buffer = this.buffers.get(toolUseId);
    if (!buffer) return;

    let currentBytes = this.byteSizes.get(toolUseId) || 0;
    const stats = this.toolStats.get(toolUseId);

    // Keep evicting until we have enough space
    while (currentBytes + neededBytes > this.config.maxBytes && buffer.size > 0) {
      const removed = buffer.shift();
      if (removed) {
        const removedBytes = Buffer.byteLength(removed.data, 'utf8');
        currentBytes -= removedBytes;
        if (stats) {
          stats.droppedLines++;
        }
      }
    }

    this.byteSizes.set(toolUseId, currentBytes);
  }

  /**
   * Schedule a batch flush for a tool
   */
  private scheduleFlush(toolUseId: string): void {
    // Don't schedule if already scheduled or paused
    if (this.flushTimers.has(toolUseId) || this.pausedTools.has(toolUseId)) {
      return;
    }

    const timer = setTimeout(() => {
      this.flushTimers.delete(toolUseId);
      const result = this.flush(toolUseId);
      if (result.items.length > 0) {
        this.emit('flush', result);
      }
    }, this.config.flushInterval);

    this.flushTimers.set(toolUseId, timer);
  }

  /**
   * Flush buffered items for a specific tool
   */
  flush(toolUseId: string): FlushResult {
    const buffer = this.buffers.get(toolUseId);
    const byteSize = this.byteSizes.get(toolUseId) || 0;

    if (!buffer || buffer.size === 0) {
      return { toolUseId, items: [], byteSize: 0 };
    }

    const items = buffer.drain();
    const actualByteSize = items.reduce((sum, item) => sum + Buffer.byteLength(item.data, 'utf8'), 0);

    // Update stats
    const stats = this.toolStats.get(toolUseId);
    if (stats) {
      stats.flushCount++;
    }

    // Clean up
    this.buffers.delete(toolUseId);
    this.byteSizes.delete(toolUseId);

    return {
      toolUseId,
      items,
      byteSize: actualByteSize,
    };
  }

  /**
   * Flush all buffered items
   */
  flushAll(): FlushResult[] {
    const results: FlushResult[] = [];

    // Clear all timers
    for (const timer of this.flushTimers.values()) {
      clearTimeout(timer);
    }
    this.flushTimers.clear();

    // Flush all buffers
    for (const toolUseId of this.buffers.keys()) {
      const result = this.flush(toolUseId);
      if (result.items.length > 0) {
        results.push(result);
      }
    }

    return results;
  }

  // =============================================================================
  // PAUSE / RESUME
  // =============================================================================

  /**
   * Pause buffering for a tool (data is discarded, not buffered)
   */
  pause(toolUseId: string): void {
    this.pausedTools.add(toolUseId);

    // Cancel pending flush
    const timer = this.flushTimers.get(toolUseId);
    if (timer) {
      clearTimeout(timer);
      this.flushTimers.delete(toolUseId);
    }

    this.emit('pause', { toolUseId });
  }

  /**
   * Resume buffering for a tool
   */
  resume(toolUseId: string): void {
    this.pausedTools.delete(toolUseId);
    this.emit('resume', { toolUseId });
  }

  /**
   * Check if a tool is paused
   */
  isPaused(toolUseId: string): boolean {
    return this.pausedTools.has(toolUseId);
  }

  // =============================================================================
  // STATUS & METRICS
  // =============================================================================

  /**
   * Get current buffer status for a tool
   */
  getStatus(toolUseId: string): { lineCount: number; byteSize: number; isPaused: boolean } {
    const buffer = this.buffers.get(toolUseId);
    return {
      lineCount: buffer?.size || 0,
      byteSize: this.byteSizes.get(toolUseId) || 0,
      isPaused: this.pausedTools.has(toolUseId),
    };
  }

  /**
   * Get all tracked tool IDs
   */
  getTrackedTools(): string[] {
    return Array.from(this.buffers.keys());
  }

  /**
   * Get buffer statistics
   */
  getStats(): {
    activeBuffers: number;
    queuedItems: number;
    toolStats: Map<string, BufferStats>;
  } {
    let queuedItems = 0;
    for (const buffer of this.buffers.values()) {
      queuedItems += buffer.size;
    }

    return {
      activeBuffers: this.buffers.size,
      queuedItems,
      toolStats: new Map(this.toolStats),
    };
  }

  /**
   * Get statistics for a specific tool
   */
  getToolStats(toolUseId: string): BufferStats | undefined {
    return this.toolStats.get(toolUseId);
  }

  /**
   * Clean up stats for a completed tool
   */
  cleanupStats(toolUseId: string): void {
    this.toolStats.delete(toolUseId);
  }

  /**
   * Check if any tool has buffered data
   */
  hasBufferedData(): boolean {
    for (const buffer of this.buffers.values()) {
      if (buffer.size > 0) return true;
    }
    return false;
  }

  // =============================================================================
  // CLEANUP
  // =============================================================================

  /**
   * Clear all buffers
   */
  clear(): void {
    // Clear all timers
    for (const timer of this.flushTimers.values()) {
      clearTimeout(timer);
    }
    this.flushTimers.clear();

    // Clear all buffers
    for (const buffer of this.buffers.values()) {
      buffer.clear();
    }
    this.buffers.clear();
    this.byteSizes.clear();
    this.pausedTools.clear();
    this.toolStats.clear();
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.clear();
    this.removeAllListeners();
  }
}

// =============================================================================
// SINGLETON FACTORY
// =============================================================================

let globalBuffer: ToolStreamBuffer | null = null;

export function getGlobalStreamBuffer(): ToolStreamBuffer {
  if (!globalBuffer) {
    globalBuffer = new ToolStreamBuffer();
  }
  return globalBuffer;
}

export function createStreamBuffer(config?: Partial<BufferConfig>): ToolStreamBuffer {
  return new ToolStreamBuffer(config);
}
