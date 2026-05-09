/**
 * DatabaseBridge.ts - Async database bridge for Daemon
 *
 * Provides non-blocking database write operations by sending requests
 * to the Main Process via IPC and returning Promises that resolve
 * when responses are received.
 */

/**
 * DB Request message sent to Main Process
 */
interface DbRequest {
  type: 'db:request';
  id: string;
  action: string;
  payload: unknown;
}

/**
 * DB Response message received from Main Process
 */
interface DbResponse {
  type: 'db:response';
  id: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

interface DaemonMessage {
  type: string;
  [key: string]: unknown;
}

/**
 * Async database bridge for the Daemon process.
 * Sends database requests to Main Process without blocking streaming output.
 */
export class DatabaseBridge {
  private pendingRequests = new Map<string, PendingRequest>();
  private requestId = 0;

  constructor(private send: (message: DaemonMessage) => void) {}

  /**
   * Generate unique request ID
   */
  private generateRequestId(): string {
    return `db-${Date.now()}-${++this.requestId}`;
  }

  /**
   * Insert a record into the specified table.
   */
  async insert(table: string, data: Record<string, unknown>): Promise<void> {
    return this.request<void>('db:insert', { table, data });
  }

  /**
   * Update records in the specified table matching the where clause.
   * Returns the number of affected rows.
   */
  async update(
    table: string,
    where: Record<string, unknown>,
    values: Record<string, unknown>
  ): Promise<number> {
    return this.request<number>('db:update', { table, where, values });
  }

  /**
   * Query records from the specified table.
   * Returns array of matching records.
   */
  async query<T>(
    table: string,
    where?: Record<string, unknown>
  ): Promise<T[]> {
    return this.request<T[]>('db:query', { table, where });
  }

  /**
   * Query a single record from the specified table.
   * Returns the first matching record or null if not found.
   */
  async queryOne<T>(
    table: string,
    where: Record<string, unknown>
  ): Promise<T | null> {
    const results = await this.query<T>(table, where);
    return results[0] || null;
  }

  /**
   * Handle database response from Main Process.
   * Resolves or rejects the pending request.
   */
  handleResponse(response: DbResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      console.warn('[DatabaseBridge] Received response for unknown request:', response.id);
      return;
    }

    this.pendingRequests.delete(response.id);

    if (response.success) {
      pending.resolve(response.result);
    } else {
      pending.reject(new Error(response.error || 'Unknown database error'));
    }
  }

  /**
   * Send a database request and wait for response.
   */
  private async request<T>(operation: string, data: Record<string, unknown>): Promise<T> {
    const id = this.generateRequestId();

    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (this.pendingRequests.delete(id)) {
          reject(new Error(`Database request timeout: ${operation}`));
        }
      }, 30000);

      this.pendingRequests.set(id, {
        resolve: (result: unknown) => {
          clearTimeout(timeoutId);
          this.pendingRequests.delete(id);
          resolve(result as T);
        },
        reject: (error: Error) => {
          clearTimeout(timeoutId);
          this.pendingRequests.delete(id);
          reject(error);
        },
      });

      const request: DbRequest = {
        type: 'db:request',
        id,
        action: operation,
        payload: data,
      };

      this.send(request as unknown as DaemonMessage);
    });
  }
}
