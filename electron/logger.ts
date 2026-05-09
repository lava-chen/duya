import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { EventEmitter } from 'events'

/**
 * Professional Logger - Advanced Application Logging System
 *
 * Features:
 * - Structured JSON logging with context support
 * - Async stream-based writing for non-blocking I/O
 * - Log rotation by size (5MB) and count (5 backups)
 * - Log sampling to prevent flooding
 * - Trace ID support for distributed tracing
 * - Multiple output formats (text, json)
 * - Log level filtering
 * - Export logs for bug reporting
 * - Performance metrics tracking
 */

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL'

export interface LogContext {
  [key: string]: unknown
}

// =============================================================================
// Standard Component Names - Use these constants for consistent logging
// =============================================================================

export const LogComponent = {
  // Core system
  Main: 'Main',
  Logger: 'Logger',
  ConfigManager: 'ConfigManager',
  ChannelManager: 'ChannelManager',
  PortManager: 'PortManager',
  SessionManager: 'SessionManager',
  PerformanceMonitor: 'PerformanceMonitor',

  // Database
  DB: 'DB',
  DBMigration: 'DBMigration',

  // Agent system
  AgentProcessPool: 'AgentProcessPool',
  AgentProcess: 'AgentProcess',
  AgentCommunicator: 'AgentCommunicator',

  // Gateway & network
  GatewayCommunicator: 'GatewayCommunicator',
  NetHandlers: 'NetHandlers',
  BrowserDaemon: 'BrowserDaemon',

  // Boot & settings
  BootConfig: 'BootConfig',
  Settings: 'Settings',

  // Preload (renderer side)
  Preload: 'Preload',

  // Generic
  Updater: 'Updater',
  Notification: 'Notification',
  Skills: 'Skills',
  Files: 'Files',
} as const

export type LogComponentName = (typeof LogComponent)[keyof typeof LogComponent]

export interface LogEntry {
  timestamp: string
  level: LogLevel
  message: string
  component?: string
  traceId?: string
  context?: LogContext
  error?: {
    message: string
    stack?: string
    code?: string
  }
  duration?: number
}

export interface LoggerConfig {
  level: LogLevel
  format: 'text' | 'json'
  maxSize: number
  maxFiles: number
  sampleRate: number
  async: boolean
  console: boolean
  includeStackTrace: boolean
}

export interface LogStats {
  totalLogs: number
  errorCount: number
  warnCount: number
  lastError?: LogEntry
  startTime: Date
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  FATAL: 4,
}

class Logger extends EventEmitter {
  private logDir: string
  private logPath: string
  private config: LoggerConfig
  private writeStream: fs.WriteStream | null = null
  private isDev: boolean
  private stats: LogStats
  private logQueue: string[] = []
  private isWriting = false
  private flushInterval: NodeJS.Timeout | null = null
  private currentTraceId: string | null = null

  constructor(config: Partial<LoggerConfig> = {}) {
    super()
    this.isDev = !app.isPackaged
    this.logDir = path.join(app.getPath('userData'), 'logs')
    this.logPath = path.join(this.logDir, 'app.log')

    this.config = {
      level: (process.env.LOG_LEVEL as LogLevel) || 'INFO',
      format: (process.env.LOG_FORMAT as 'text' | 'json') || 'text',
      maxSize: 5 * 1024 * 1024, // 5MB
      maxFiles: 5,
      sampleRate: 1.0, // 100% sampling by default
      async: true,
      console: this.isDev,
      includeStackTrace: true,
      ...config,
    }

    this.stats = {
      totalLogs: 0,
      errorCount: 0,
      warnCount: 0,
      startTime: new Date(),
    }

    this.ensureLogDir()
    this.initWriteStream()
    this.startFlushInterval()

    // Handle process exit
    process.on('exit', () => this.cleanup())
    process.on('SIGINT', () => this.cleanup())
    process.on('SIGTERM', () => this.cleanup())
  }

  private ensureLogDir(): void {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true })
    }
  }

  private initWriteStream(): void {
    if (!this.config.async) return

    try {
      this.rotateIfNeeded()
      this.writeStream = fs.createWriteStream(this.logPath, {
        flags: 'a',
        encoding: 'utf-8',
        autoClose: true,
      })

      this.writeStream.on('error', (err) => {
        this.emit('error', err)
      })
    } catch (error) {
      // Fallback: cannot use logger here since it's being initialized
      // eslint-disable-next-line no-console
      console.error('[Logger] Failed to create write stream:', error)
    }
  }

  private startFlushInterval(): void {
    if (this.config.async) {
      this.flushInterval = setInterval(() => {
        this.flush()
      }, 1000) // Flush every second
    }
  }

  private getTimestamp(): string {
    return new Date().toISOString()
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.config.level]
  }

  private shouldSample(): boolean {
    return Math.random() < this.config.sampleRate
  }

  private formatEntry(entry: LogEntry): string {
    if (this.config.format === 'json') {
      return JSON.stringify(entry) + '\n'
    }

    // Text format
    let line = `[${entry.timestamp}] [${entry.level}]`

    if (entry.component) {
      line += ` [${entry.component}]`
    }

    if (entry.traceId) {
      line += ` [${entry.traceId}]`
    }

    line += ` ${entry.message}`

    if (entry.duration !== undefined) {
      line += ` (${entry.duration}ms)`
    }

    if (entry.context && Object.keys(entry.context).length > 0) {
      try {
        line += ` ${JSON.stringify(entry.context)}`
      } catch {
        line += ' [Context serialization failed]'
      }
    }

    if (entry.error) {
      line += `\n  Error: ${entry.error.message}`
      if (entry.error.stack && this.config.includeStackTrace) {
        line += `\n  Stack: ${entry.error.stack}`
      }
      if (entry.error.code) {
        line += `\n  Code: ${entry.error.code}`
      }
    }

    return line + '\n'
  }

  private createLogEntry(
    level: LogLevel,
    message: string,
    options: {
      component?: string
      context?: LogContext
      error?: Error
      duration?: number
    } = {}
  ): LogEntry {
    const entry: LogEntry = {
      timestamp: this.getTimestamp(),
      level,
      message,
      component: options.component,
      traceId: this.currentTraceId || undefined,
      context: options.context,
      duration: options.duration,
    }

    if (options.error) {
      entry.error = {
        message: options.error.message,
        stack: options.error.stack,
        code: (options.error as { code?: string }).code,
      }
    }

    return entry
  }

  private write(entry: LogEntry): void {
    // Update stats
    this.stats.totalLogs++
    if (entry.level === 'ERROR' || entry.level === 'FATAL') {
      this.stats.errorCount++
      this.stats.lastError = entry
    } else if (entry.level === 'WARN') {
      this.stats.warnCount++
    }

    const formatted = this.formatEntry(entry)

    // Console output
    if (this.config.console) {
      const consoleMethod =
        entry.level === 'ERROR' || entry.level === 'FATAL'
          ? console.error
          : entry.level === 'WARN'
            ? console.warn
            : entry.level === 'DEBUG'
              ? console.debug
              : console.log
      consoleMethod(formatted.trim())
    }

    // File output
    if (this.config.async && this.writeStream) {
      this.logQueue.push(formatted)
    } else {
      try {
        this.rotateIfNeeded()
        fs.appendFileSync(this.logPath, formatted, 'utf-8')
      } catch {
        // Fallback if file write fails - already attempted console output above
      }
    }

    // Emit event for potential real-time monitoring
    this.emit('log', entry)
  }

  private flush(): void {
    if (this.isWriting || this.logQueue.length === 0 || !this.writeStream) {
      return
    }

    this.isWriting = true
    const batch = this.logQueue.splice(0, 100).join('')

    this.writeStream.write(batch, (err) => {
      this.isWriting = false
      if (err) {
        // Put failed logs back to queue for retry
        this.logQueue.unshift(batch)
      }
    })
  }

  private rotateIfNeeded(): void {
    try {
      if (!fs.existsSync(this.logPath)) {
        return
      }

      const stats = fs.statSync(this.logPath)
      if (stats.size < this.config.maxSize) {
        return
      }

      // Close current stream
      if (this.writeStream) {
        this.writeStream.end()
        this.writeStream = null
      }

      // Rotate existing backup files
      for (let i = this.config.maxFiles - 1; i >= 1; i--) {
        const oldPath = path.join(this.logDir, `app.log.${i}`)
        const newPath = path.join(this.logDir, `app.log.${i + 1}`)

        if (fs.existsSync(oldPath)) {
          if (i === this.config.maxFiles - 1) {
            fs.unlinkSync(oldPath)
          } else {
            fs.renameSync(oldPath, newPath)
          }
        }
      }

      // Rotate current log to .1
      const backupPath = path.join(this.logDir, 'app.log.1')
      fs.renameSync(this.logPath, backupPath)

      // Reopen stream
      this.initWriteStream()

      this.info('Log rotation completed', undefined, LogComponent.Logger)
    } catch {
      // Silently fail on rotation error to avoid infinite loop
    }
  }

  private cleanup(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval)
      this.flushInterval = null
    }

    this.flush()

    if (this.writeStream) {
      this.writeStream.end()
      this.writeStream = null
    }
  }

  // Trace ID management
  setTraceId(traceId: string | null): void {
    this.currentTraceId = traceId
  }

  withTrace<T>(traceId: string, fn: () => T): T {
    const prevTraceId = this.currentTraceId
    this.currentTraceId = traceId
    try {
      return fn()
    } finally {
      this.currentTraceId = prevTraceId
    }
  }

  async withTraceAsync<T>(traceId: string, fn: () => Promise<T>): Promise<T> {
    const prevTraceId = this.currentTraceId
    this.currentTraceId = traceId
    try {
      return await fn()
    } finally {
      this.currentTraceId = prevTraceId
    }
  }

  // Public logging API
  debug(message: string, context?: LogContext, component?: string): void {
    if (!this.shouldLog('DEBUG') || !this.shouldSample()) return
    this.write(this.createLogEntry('DEBUG', message, { component, context }))
  }

  info(message: string, context?: LogContext, component?: string): void {
    if (!this.shouldLog('INFO') || !this.shouldSample()) return
    this.write(this.createLogEntry('INFO', message, { component, context }))
  }

  warn(message: string, context?: LogContext, component?: string): void {
    if (!this.shouldLog('WARN') || !this.shouldSample()) return
    this.write(this.createLogEntry('WARN', message, { component, context }))
  }

  error(message: string, error?: Error, context?: LogContext, component?: string): void {
    if (!this.shouldLog('ERROR')) return
    this.write(this.createLogEntry('ERROR', message, { component, context, error }))
  }

  fatal(message: string, error?: Error, context?: LogContext, component?: string): void {
    if (!this.shouldLog('FATAL')) return
    this.write(this.createLogEntry('FATAL', message, { component, context, error }))
  }

  // Performance tracking
  time(label: string, component?: string): () => void {
    const start = Date.now()
    return () => {
      const duration = Date.now() - start
      this.debug(`${label} completed`, { duration }, component)
    }
  }

  async timeAsync<T>(label: string, fn: () => Promise<T>, component?: string): Promise<T> {
    const start = Date.now()
    try {
      const result = await fn()
      const duration = Date.now() - start
      this.debug(`${label} completed`, { duration }, component)
      return result
    } catch (error) {
      const duration = Date.now() - start
      this.error(`${label} failed`, error as Error, { duration }, component)
      throw error
    }
  }

  // Configuration
  updateConfig(config: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...config }
    this.info('Logger configuration updated', { config: this.config }, 'Logger')
  }

  getConfig(): LoggerConfig {
    return { ...this.config }
  }

  // Stats
  getStats(): LogStats {
    return { ...this.stats }
  }

  // Export logs
  exportLogs(format: 'text' | 'json' = 'text'): string {
    try {
      this.flush()

      let content = ''
      const logs: LogEntry[] = []

      // Read backup files in reverse order (oldest first)
      for (let i = this.config.maxFiles; i >= 1; i--) {
        const backupPath = path.join(this.logDir, `app.log.${i}`)
        if (fs.existsSync(backupPath)) {
          const data = fs.readFileSync(backupPath, 'utf-8')
          if (format === 'json') {
            // Parse and collect JSON entries
            data.split('\n').forEach(line => {
              if (line.trim()) {
                try {
                  logs.push(JSON.parse(line))
                } catch {
                  // Skip invalid lines
                }
              }
            })
          } else {
            content += data + '\n'
          }
        }
      }

      // Read current log
      if (fs.existsSync(this.logPath)) {
        const data = fs.readFileSync(this.logPath, 'utf-8')
        if (format === 'json') {
          data.split('\n').forEach(line => {
            if (line.trim()) {
              try {
                logs.push(JSON.parse(line))
              } catch {
                // Skip invalid lines
              }
            }
          })
          return JSON.stringify(logs, null, 2)
        } else {
          content += data
        }
      }

      return content || 'No logs available'
    } catch (error) {
      return `Failed to export logs: ${error}`
    }
  }

  exportLogsToFile(targetPath: string, format: 'text' | 'json' = 'text'): boolean {
    try {
      const content = this.exportLogs(format)
      fs.writeFileSync(targetPath, content)
      return true
    } catch (error) {
      this.error('Failed to export logs to file', error instanceof Error ? error : new Error(String(error)), undefined, LogComponent.Logger)
      return false
    }
  }

  // Get log file info
  getLogPath(): string {
    return this.logPath
  }

  getLogDir(): string {
    return this.logDir
  }

  getLogSize(): number {
    try {
      if (!fs.existsSync(this.logPath)) {
        return 0
      }
      return fs.statSync(this.logPath).size
    } catch {
      return 0
    }
  }

  getLogSizeFormatted(): string {
    const size = this.getLogSize()
    if (size < 1024) {
      return `${size} B`
    } else if (size < 1024 * 1024) {
      return `${(size / 1024).toFixed(2)} KB`
    } else {
      return `${(size / (1024 * 1024)).toFixed(2)} MB`
    }
  }

  // Clear logs
  clearLogs(): boolean {
    try {
      this.flush()

      // Close stream before clearing
      if (this.writeStream) {
        this.writeStream.end()
        this.writeStream = null
      }

      // Delete current log
      if (fs.existsSync(this.logPath)) {
        fs.unlinkSync(this.logPath)
      }

      // Delete backup files
      for (let i = 1; i <= this.config.maxFiles; i++) {
        const backupPath = path.join(this.logDir, `app.log.${i}`)
        if (fs.existsSync(backupPath)) {
          fs.unlinkSync(backupPath)
        }
      }

      // Reset stats
      this.stats = {
        totalLogs: 0,
        errorCount: 0,
        warnCount: 0,
        startTime: new Date(),
      }

      // Reopen stream
      this.initWriteStream()

      this.info('Logs cleared', undefined, LogComponent.Logger)
      return true
    } catch {
      return false
    }
  }

  // Search logs
  searchLogs(query: string, level?: LogLevel): LogEntry[] {
    try {
      const logs: LogEntry[] = []
      const content = this.exportLogs('json')
      const allLogs: LogEntry[] = JSON.parse(content)

      return allLogs.filter(entry => {
        const matchesQuery =
          entry.message.toLowerCase().includes(query.toLowerCase()) ||
          entry.component?.toLowerCase().includes(query.toLowerCase()) ||
          entry.traceId?.toLowerCase().includes(query.toLowerCase())

        const matchesLevel = level ? entry.level === level : true

        return matchesQuery && matchesLevel
      })
    } catch {
      return []
    }
  }
}

// Singleton instance
let loggerInstance: Logger | null = null

export function initLogger(config?: Partial<LoggerConfig>): Logger {
  if (!loggerInstance) {
    loggerInstance = new Logger(config)
  }
  return loggerInstance
}

export function getLogger(): Logger {
  if (!loggerInstance) {
    return initLogger()
  }
  return loggerInstance
}

// Utility to generate trace IDs
export function generateTraceId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
}

export default Logger
