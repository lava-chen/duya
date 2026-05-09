/**
 * PerformanceMonitor - Performance metrics collection and reporting
 *
 * Features:
 * - Message latency tracking (avg, p99, p50)
 * - Message throughput measurement
 * - Memory usage monitoring
 * - Error rate tracking
 * - Reconnect count tracking
 * - Prometheus-compatible metrics export
 */

import { app } from 'electron';

// =============================================================================
// TYPES & INTERFACES
// =============================================================================

export interface PerformanceMetrics {
  messageLatency: number[];
  throughput: number;
  memoryUsage: number;
  errorRate: number;
  reconnectCount: number;
}

export interface LatencyStats {
  avg: number;
  p50: number;
  p90: number;
  p99: number;
  min: number;
  max: number;
  count: number;
}

export interface ChannelMetrics {
  latency: LatencyStats;
  throughput: number;
  errorRate: number;
  reconnectCount: number;
  lastActivity: number;
}

export interface MemorySnapshot {
  rss: number;        // Resident Set Size in MB
  heapTotal: number;  // Total heap size in MB
  heapUsed: number;   // Used heap size in MB
  external: number;    // External memory in MB
  timestamp: number;
}

export interface PerformanceReport {
  channels: Record<string, ChannelMetrics>;
  memory: MemorySnapshot;
  uptime: number;
  timestamp: number;
}

export interface MemoryLeakAlert {
  type: 'memory_leak_suspected';
  heapUsedSlope: number;       // MB per minute
  rssSlope: number;            // MB per minute
  sampleCount: number;
  durationMs: number;
  currentHeapUsedMB: number;
  thresholdSlopeMBPerMin: number;
  timestamp: number;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const LATENCY_SAMPLE_MAX_SIZE = 1000;
const METRICS_EXPORT_INTERVAL = 60000; // 1 minute
const MEMORY_LEAK_MIN_SAMPLES = 20;
const MEMORY_LEAK_SLOPE_THRESHOLD = 1.0; // MB per minute
const MEMORY_LEAK_MIN_DURATION_MS = 5 * 60 * 1000; // 5 minutes

// =============================================================================
// PERFORMANCE MONITOR CLASS
// =============================================================================

export class PerformanceMonitor {
  private latencySamples = new Map<string, number[]>();
  private errorCounts = new Map<string, number>();
  private messageCounts = new Map<string, number>();
  private reconnectCounts = new Map<string, number>();
  private lastActivity = new Map<string, number>();
  private startTime = Date.now();
  private memorySnapshots: MemorySnapshot[] = [];
  private exportTimer: NodeJS.Timeout | null = null;
  private eventHandlers = new Map<string, Set<(data: unknown) => void>>();

  constructor() {
    this.startAutoExport();
  }

  // =============================================================================
  // METRIC RECORDING
  // =============================================================================

  /**
   * Record message latency for a channel
   */
  recordLatency(channel: string, latencyMs: number): void {
    const samples = this.latencySamples.get(channel) || [];
    samples.push(latencyMs);

    // Keep only recent samples
    if (samples.length > LATENCY_SAMPLE_MAX_SIZE) {
      samples.shift();
    }

    this.latencySamples.set(channel, samples);
    this.updateLastActivity(channel);
  }

  /**
   * Record a message sent on a channel
   */
  recordMessage(channel: string): void {
    const count = this.messageCounts.get(channel) || 0;
    this.messageCounts.set(channel, count + 1);
    this.updateLastActivity(channel);
  }

  /**
   * Record an error on a channel
   */
  recordError(channel: string): void {
    const count = this.errorCounts.get(channel) || 0;
    this.errorCounts.set(channel, count + 1);
    this.updateLastActivity(channel);
  }

  /**
   * Record a reconnection event on a channel
   */
  recordReconnect(channel: string): void {
    const count = this.reconnectCounts.get(channel) || 0;
    this.reconnectCounts.set(channel, count + 1);
    this.updateLastActivity(channel);
  }

  /**
   * Record memory snapshot
   */
  recordMemorySnapshot(): MemorySnapshot {
    const usage = process.memoryUsage();
    const snapshot: MemorySnapshot = {
      rss: usage.rss / 1024 / 1024,
      heapTotal: usage.heapTotal / 1024 / 1024,
      heapUsed: usage.heapUsed / 1024 / 1024,
      external: usage.external / 1024 / 1024,
      timestamp: Date.now(),
    };

    this.memorySnapshots.push(snapshot);

    // Keep only recent snapshots (last 100)
    if (this.memorySnapshots.length > 100) {
      this.memorySnapshots.shift();
    }

    return snapshot;
  }

  private updateLastActivity(channel: string): void {
    this.lastActivity.set(channel, Date.now());
  }

  // =============================================================================
  // STATISTICS CALCULATION
  // =============================================================================

  /**
   * Calculate latency statistics for a channel
   */
  getLatencyStats(channel: string): LatencyStats {
    const samples = this.latencySamples.get(channel) || [];
    if (samples.length === 0) {
      return { avg: 0, p50: 0, p90: 0, p99: 0, min: 0, max: 0, count: 0 };
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);

    return {
      avg: sum / sorted.length,
      p50: this.percentile(sorted, 0.50),
      p90: this.percentile(sorted, 0.90),
      p99: this.percentile(sorted, 0.99),
      min: sorted[0],
      max: sorted[sorted.length - 1],
      count: sorted.length,
    };
  }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.ceil(sorted.length * p) - 1;
    return sorted[Math.max(0, index)];
  }

  /**
   * Calculate throughput for a channel (messages per second)
   */
  getThroughput(channel: string): number {
    const count = this.messageCounts.get(channel) || 0;
    const elapsed = (Date.now() - this.startTime) / 1000;
    return elapsed > 0 ? count / elapsed : 0;
  }

  /**
   * Calculate error rate for a channel (percentage)
   */
  getErrorRate(channel: string): number {
    const errors = this.errorCounts.get(channel) || 0;
    const messages = this.messageCounts.get(channel) || 0;
    if (messages === 0) return 0;
    return (errors / messages) * 100;
  }

  /**
   * Get reconnect count for a channel
   */
  getReconnectCount(channel: string): number {
    return this.reconnectCounts.get(channel) || 0;
  }

  /**
   * Get last activity timestamp for a channel
   */
  getLastActivity(channel: string): number {
    return this.lastActivity.get(channel) || this.startTime;
  }

  /**
   * Get current memory snapshot
   */
  getMemorySnapshot(): MemorySnapshot {
    const usage = process.memoryUsage();
    return {
      rss: usage.rss / 1024 / 1024,
      heapTotal: usage.heapTotal / 1024 / 1024,
      heapUsed: usage.heapUsed / 1024 / 1024,
      external: usage.external / 1024 / 1024,
      timestamp: Date.now(),
    };
  }

  /**
   * Get average memory usage across all snapshots
   */
  getAverageMemory(): { rss: number; heapUsed: number } {
    if (this.memorySnapshots.length === 0) {
      const current = this.getMemorySnapshot();
      return { rss: current.rss, heapUsed: current.heapUsed };
    }

    const sum = this.memorySnapshots.reduce(
      (acc, s) => ({
        rss: acc.rss + s.rss,
        heapUsed: acc.heapUsed + s.heapUsed,
      }),
      { rss: 0, heapUsed: 0 }
    );

    return {
      rss: sum.rss / this.memorySnapshots.length,
      heapUsed: sum.heapUsed / this.memorySnapshots.length,
    };
  }

  /**
   * Record memory snapshot after a chat turn completes.
   * Call this on chat:done events to track per-turn memory trends.
   */
  recordTurnMemory(sessionId: string): MemorySnapshot {
    const snapshot = this.recordMemorySnapshot();
    console.log(`[PerformanceMonitor] Turn memory for ${sessionId}: heapUsed=${snapshot.heapUsed.toFixed(1)}MB, rss=${snapshot.rss.toFixed(1)}MB`);
    return snapshot;
  }

  /**
   * Detect potential memory leak using linear regression on recent snapshots.
   *
   * Analyzes the last N heapUsed samples. If the slope of the trend line
   * is positive and exceeds the threshold over the minimum duration,
   * a memory leak is suspected.
   *
   * @returns MemoryLeakAlert if leak suspected, null otherwise
   */
  detectMemoryLeak(): MemoryLeakAlert | null {
    const snapshots = this.memorySnapshots;
    if (snapshots.length < MEMORY_LEAK_MIN_SAMPLES) {
      return null;
    }

    const recent = snapshots.slice(-MEMORY_LEAK_MIN_SAMPLES);
    const durationMs = recent[recent.length - 1].timestamp - recent[0].timestamp;
    if (durationMs < MEMORY_LEAK_MIN_DURATION_MS) {
      return null;
    }

    const heapSlope = this.calculateSlope(recent, 'heapUsed');
    const rssSlope = this.calculateSlope(recent, 'rss');
    const durationMinutes = durationMs / 60000;

    // Normalize slope to MB per minute (heapSlope is MB/sec, multiply by 60)
    const heapSlopePerMin = heapSlope * 60;
    const rssSlopePerMin = rssSlope * 60;

    if (heapSlopePerMin > MEMORY_LEAK_SLOPE_THRESHOLD) {
      const current = recent[recent.length - 1];
      const alert: MemoryLeakAlert = {
        type: 'memory_leak_suspected',
        heapUsedSlope: parseFloat(heapSlopePerMin.toFixed(2)),
        rssSlope: parseFloat(rssSlopePerMin.toFixed(2)),
        sampleCount: recent.length,
        durationMs,
        currentHeapUsedMB: parseFloat(current.heapUsed.toFixed(1)),
        thresholdSlopeMBPerMin: MEMORY_LEAK_SLOPE_THRESHOLD,
        timestamp: Date.now(),
      };
      console.warn('[PerformanceMonitor] Memory leak suspected:', alert);
      return alert;
    }

    return null;
  }

  /**
   * Calculate the linear regression slope for a field across snapshots.
   * Uses simple linear regression: slope = Σ((x-x̄)(y-ȳ)) / Σ((x-x̄)²)
   */
  private calculateSlope(snapshots: MemorySnapshot[], field: 'heapUsed' | 'rss'): number {
    const n = snapshots.length;
    if (n < 2) return 0;

    // Use timestamps as x-axis (in seconds for numerical stability)
    const baseTime = snapshots[0].timestamp;
    const xs = snapshots.map(s => (s.timestamp - baseTime) / 1000);
    const ys = snapshots.map(s => s[field]);

    const meanX = xs.reduce((a, b) => a + b, 0) / n;
    const meanY = ys.reduce((a, b) => a + b, 0) / n;

    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - meanX;
      numerator += dx * (ys[i] - meanY);
      denominator += dx * dx;
    }

    return denominator === 0 ? 0 : numerator / denominator; // MB per second
  }

  // =============================================================================
  // COMPREHENSIVE REPORTS
  // =============================================================================

  /**
   * Get metrics for a specific channel
   */
  getChannelMetrics(channel: string): ChannelMetrics {
    return {
      latency: this.getLatencyStats(channel),
      throughput: this.getThroughput(channel),
      errorRate: this.getErrorRate(channel),
      reconnectCount: this.getReconnectCount(channel),
      lastActivity: this.getLastActivity(channel),
    };
  }

  /**
   * Get metrics for all channels
   */
  getAllChannelMetrics(): Record<string, ChannelMetrics> {
    const allChannels = new Set([
      ...this.latencySamples.keys(),
      ...this.messageCounts.keys(),
    ]);

    const metrics: Record<string, ChannelMetrics> = {};
    for (const channel of allChannels) {
      metrics[channel] = this.getChannelMetrics(channel);
    }
    return metrics;
  }

  /**
   * Get full performance report
   */
  getReport(): PerformanceReport {
    return {
      channels: this.getAllChannelMetrics(),
      memory: this.getMemorySnapshot(),
      uptime: (Date.now() - this.startTime) / 1000,
      timestamp: Date.now(),
    };
  }

  // =============================================================================
  // PROMETHEUS EXPORT
  // =============================================================================

  /**
   * Export metrics in Prometheus format
   */
  exportPrometheus(): string {
    const lines: string[] = [];
    const now = Date.now();

    lines.push(`# HELP duya_message_latency_ms Message latency in milliseconds`);
    lines.push(`# TYPE duya_message_latency_ms gauge`);

    lines.push(`# HELP duya_message_throughput Messages per second`);
    lines.push(`# TYPE duya_message_throughput gauge`);

    lines.push(`# HELP duya_error_rate_percent Error rate percentage`);
    lines.push(`# TYPE duya_error_rate_percent gauge`);

    lines.push(`# HELP duya_reconnect_count Total reconnection attempts`);
    lines.push(`# TYPE duya_reconnect_count counter`);

    lines.push(`# HELP duya_memory_bytes Memory usage in bytes`);
    lines.push(`# TYPE duya_memory_bytes gauge`);

    lines.push(`# HELP duya_uptime_seconds Process uptime in seconds`);
    lines.push(`# TYPE duya_uptime_seconds gauge`);

    for (const [channel, samples] of this.latencySamples) {
      const stats = this.getLatencyStats(channel);
      const throughput = this.getThroughput(channel);
      const errorRate = this.getErrorRate(channel);
      const reconnectCount = this.getReconnectCount(channel);

      lines.push(`duya_message_latency_ms{channel="${channel}",stat="avg"} ${stats.avg.toFixed(2)} ${now}`);
      lines.push(`duya_message_latency_ms{channel="${channel}",stat="p50"} ${stats.p50.toFixed(2)} ${now}`);
      lines.push(`duya_message_latency_ms{channel="${channel}",stat="p90"} ${stats.p90.toFixed(2)} ${now}`);
      lines.push(`duya_message_latency_ms{channel="${channel}",stat="p99"} ${stats.p99.toFixed(2)} ${now}`);
      lines.push(`duya_message_throughput{channel="${channel}"} ${throughput.toFixed(4)} ${now}`);
      lines.push(`duya_error_rate_percent{channel="${channel}"} ${errorRate.toFixed(2)} ${now}`);
      lines.push(`duya_reconnect_count{channel="${channel}"} ${reconnectCount} ${now}`);
    }

    const mem = this.getMemorySnapshot();
    lines.push(`duya_memory_bytes{type="rss"} ${(mem.rss * 1024 * 1024).toFixed(0)} ${now}`);
    lines.push(`duya_memory_bytes{type="heap_used"} ${(mem.heapUsed * 1024 * 1024).toFixed(0)} ${now}`);
    lines.push(`duya_memory_bytes{type="heap_total"} ${(mem.heapTotal * 1024 * 1024).toFixed(0)} ${now}`);

    const uptime = (Date.now() - this.startTime) / 1000;
    lines.push(`duya_uptime_seconds ${uptime.toFixed(0)} ${now}`);

    return lines.join('\n');
  }

  // =============================================================================
  // AUTO EXPORT
  // =============================================================================

  private startAutoExport(): void {
    this.exportTimer = setInterval(() => {
      this.recordMemorySnapshot();
      const leakAlert = this.detectMemoryLeak();
      if (leakAlert) {
        this.emit('memory:leak_alert', leakAlert);
      }
      const prometheusMetrics = this.exportPrometheus();
      this.emit('metrics:export', { metrics: prometheusMetrics, timestamp: Date.now() });
    }, METRICS_EXPORT_INTERVAL);
  }

  private stopAutoExport(): void {
    if (this.exportTimer) {
      clearInterval(this.exportTimer);
      this.exportTimer = null;
    }
  }

  // =============================================================================
  // EVENT HANDLING
  // =============================================================================

  onMetrics(handler: (report: PerformanceReport) => void): () => void {
    return this.on('metrics:report', handler as (data: unknown) => void);
  }

  onExport(handler: (data: { metrics: string; timestamp: number }) => void): () => void {
    return this.on<{ metrics: string; timestamp: number }>('metrics:export', handler);
  }

  on<T = unknown>(event: string, handler: (data: T) => void): () => void {
    const handlers = this.eventHandlers.get(event) as Set<(data: T) => void> || new Set();
    handlers.add(handler);
    this.eventHandlers.set(event, handlers as Set<(data: unknown) => void>);
    return () => {
      const h = this.eventHandlers.get(event) as Set<(data: T) => void> | undefined;
      if (h) {
        h.delete(handler);
      }
    };
  }

  private emit(event: string, data: unknown): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data);
        } catch (err) {
          console.error(`[PerformanceMonitor] Handler error:`, err);
        }
      }
    }
  }

  // =============================================================================
  // RESET & SHUTDOWN
  // =============================================================================

  reset(): void {
    this.latencySamples.clear();
    this.errorCounts.clear();
    this.messageCounts.clear();
    this.reconnectCounts.clear();
    this.lastActivity.clear();
    this.memorySnapshots = [];
    this.startTime = Date.now();
  }

  shutdown(): void {
    this.stopAutoExport();
    this.eventHandlers.clear();
  }
}

// =============================================================================
// SINGLETON
// =============================================================================

let performanceMonitor: PerformanceMonitor | null = null;

export function getPerformanceMonitor(): PerformanceMonitor {
  if (!performanceMonitor) {
    performanceMonitor = new PerformanceMonitor();
  }
  return performanceMonitor;
}

export function initPerformanceMonitor(): PerformanceMonitor {
  if (performanceMonitor) {
    console.warn('[PerformanceMonitor] Already initialized');
    return performanceMonitor;
  }
  performanceMonitor = new PerformanceMonitor();
  return performanceMonitor;
}
