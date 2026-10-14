/**
 * TransferableBuffer - Zero-copy transfer support for large data
 *
 * Uses ArrayBuffer transfer for efficient cross-context data passing
 * (e.g., between main thread and Web Workers via MessagePort)
 */

/**
 * A transferable chunk that can be efficiently transferred via MessagePort
 */
export interface TransferableChunk {
  stream: 'stdout' | 'stderr';
  buffer: ArrayBuffer;
  length: number;
  timestamp: number;
}

/**
 * Message format for transferable tool output
 */
export interface TransferableMessage {
  type: 'tool:output';
  toolUseId: string;
  stream: 'stdout' | 'stderr';
  buffer: ArrayBuffer;
  length: number;
  timestamp: number;
}

/**
 * Result from creating a transferable message
 */
export interface TransferableResult {
  message: TransferableMessage;
  transfer: ArrayBuffer[];
}

/**
 * TransferableBuffer provides zero-copy encoding and transfer support
 */
export class TransferableBuffer {
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();

  /**
   * Encode a string to ArrayBuffer
   */
  encode(data: string): ArrayBuffer {
    return this.encoder.encode(data).buffer as ArrayBuffer;
  }

  /**
   * Decode an ArrayBuffer to string
   */
  decode(buffer: ArrayBuffer): string {
    return this.decoder.decode(buffer);
  }

  /**
   * Create a transferable message for efficient cross-context transfer
   */
  createTransferableMessage(
    toolUseId: string,
    stream: 'stdout' | 'stderr',
    data: string
  ): TransferableResult {
    const buffer = this.encode(data);

    const message: TransferableMessage = {
      type: 'tool:output',
      toolUseId,
      stream,
      buffer,
      length: data.length,
      timestamp: Date.now(),
    };

    // Return buffer in transfer array for zero-copy transfer
    return { message, transfer: [buffer] };
  }

  /**
   * Create multiple transferable messages from chunks
   */
  createBatchTransferableMessages(
    toolUseId: string,
    chunks: Array<{ stream: 'stdout' | 'stderr'; data: string }>
  ): TransferableResult[] {
    const results: TransferableResult[] = [];

    for (const chunk of chunks) {
      results.push(this.createTransferableMessage(toolUseId, chunk.stream, chunk.data));
    }

    return results;
  }

  /**
   * Extract readable chunks from transferable message
   */
  extractChunk(result: TransferableResult): { stream: 'stdout' | 'stderr'; data: string; timestamp: number } {
    return {
      stream: result.message.stream,
      data: this.decode(result.message.buffer),
      timestamp: result.message.timestamp,
    };
  }
}

/**
 * Helper to check if a value is a transferable result
 */
export function isTransferableResult(value: unknown): value is TransferableResult {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    obj.message !== undefined &&
    typeof obj.message === 'object' &&
    (obj.transfer === undefined || Array.isArray(obj.transfer))
  );
}
