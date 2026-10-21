/**
 * Stream Types - Type definitions for tool output streaming
 */

/**
 * Stream output type
 */
export type StreamType = 'stdout' | 'stderr';

/**
 * A single chunk of stream output
 */
export interface StreamChunk {
  stream: StreamType;
  data: string;
  timestamp: number;
}

/**
 * Configuration for buffer behavior
 */
export interface BufferConfig {
  maxLines: number;        // Maximum cached lines
  maxBytes: number;       // Maximum cached bytes
  flushInterval: number;  // Batch flush interval (ms)
  maxChunkSize: number;    // Maximum single chunk size in bytes
}

/**
 * Statistics for buffer monitoring
 */
export interface BufferStats {
  totalLines: number;     // Total lines added
  totalBytes: number;     // Total bytes added
  droppedLines: number;   // Lines dropped due to buffer overflow
  flushCount: number;     // Number of flush operations
}

/**
 * Default buffer configuration
 */
export const DEFAULT_BUFFER_CONFIG: BufferConfig = {
  maxLines: 1000,
  maxBytes: 1024 * 1024,    // 1MB
  flushInterval: 50,        // 50ms
  maxChunkSize: 64 * 1024,  // 64KB
};
