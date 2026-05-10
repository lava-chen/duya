import { autoUpdater, UpdateInfo } from 'electron-updater'
import { BrowserWindow, app } from 'electron'
import { getLogger } from './logger'

/**
 * Auto Updater - Silent background updates (Obsidian-style)
 *
 * Features:
 * - Silent background download when update is available
 * - Notify renderer of download progress (subtle UI)
 * - Prompt user to restart only when update is ready to install
 * - Only enabled in packaged app
 */

const logger = getLogger()

// Update check interval (6 hours)
const UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000

// Delay before first check (30 seconds after startup)
const INITIAL_CHECK_DELAY = 30_000

interface UpdaterState {
  isChecking: boolean
  isDownloading: boolean
  updateInfo: UpdateInfo | null
  downloadProgress: {
    percent: number
    transferred: number
    total: number
  } | null
  error: string | null
}

const state: UpdaterState = {
  isChecking: false,
  isDownloading: false,
  updateInfo: null,
  downloadProgress: null,
  error: null,
}

let mainWindow: BrowserWindow | null = null
let checkInterval: NodeJS.Timeout | null = null

// Notify all renderer windows
function notifyRenderer(channel: string, payload?: unknown): void {
  const { BrowserWindow } = require('electron')
  BrowserWindow.getAllWindows().forEach((win: BrowserWindow) => {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  })
}

// Reset state
function resetState(): void {
  state.isChecking = false
  state.isDownloading = false
  state.updateInfo = null
  state.downloadProgress = null
  state.error = null
}

// Setup auto updater event handlers
function setupEventHandlers(): void {
  // Checking for update
  autoUpdater.on('checking-for-update', () => {
    logger.info('[Updater] Checking for update...')
    state.isChecking = true
    state.error = null
    notifyRenderer('update:checking')
  })

  // Update available - start silent download
  autoUpdater.on('update-available', (info: UpdateInfo) => {
    logger.info(`[Updater] Update available: ${info.version}`)
    state.isChecking = false
    state.isDownloading = true
    state.updateInfo = info
    // Notify renderer that download is starting
    notifyRenderer('update:downloading', { version: info.version })
  })

  // No update available
  autoUpdater.on('update-not-available', () => {
    logger.info('[Updater] Already up to date')
    state.isChecking = false
    notifyRenderer('update:not-available')
  })

  // Download progress
  autoUpdater.on('download-progress', (progress) => {
    state.downloadProgress = {
      percent: Math.round(progress.percent),
      transferred: progress.transferred,
      total: progress.total,
    }
    notifyRenderer('update:progress', state.downloadProgress)

    // Log progress every 10%
    if (Math.floor(progress.percent) % 10 === 0) {
      logger.info(`[Updater] Download progress: ${progress.percent.toFixed(1)}%`)
    }
  })

  // Update downloaded - notify renderer it's ready
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    logger.info(`[Updater] Download complete: ${info.version}`)
    state.isDownloading = false
    state.updateInfo = info
    notifyRenderer('update:ready', {
      version: info.version,
      releaseNotes: info.releaseNotes,
    })
  })

  // Error handling - silent failure, don't disturb user
  autoUpdater.on('error', (err) => {
    logger.warn(`[Updater] Error: ${err.message}`)
    state.isChecking = false
    state.isDownloading = false
    state.error = err.message
    // Silent failure - no user notification
  })
}

// Initialize auto updater
export function initUpdater(window: BrowserWindow): void {
  mainWindow = window

  // Only enable in packaged app
  if (!app.isPackaged) {
    logger.info('[Updater] Skipping auto-updater in development mode')
    return
  }

  logger.info('[Updater] Initializing auto-updater...')
  setupEventHandlers()

  // Configure auto updater for silent background updates
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  // Delayed initial check (avoid competing with startup resources)
  setTimeout(() => {
    logger.info('[Updater] Performing initial update check...')
    checkForUpdates().catch((err) => {
      logger.error('[Updater] Initial check failed:', err)
    })
  }, INITIAL_CHECK_DELAY)

  // Periodic checks every 6 hours
  checkInterval = setInterval(() => {
    logger.info('[Updater] Performing periodic update check...')
    checkForUpdates().catch((err) => {
      logger.error('[Updater] Periodic check failed:', err)
    })
  }, UPDATE_CHECK_INTERVAL)

  logger.info('[Updater] Auto-updater initialized')
}

// Manual check for updates
export async function checkForUpdates(): Promise<{
  success: boolean
  updateAvailable?: boolean
  error?: string
}> {
  // Only check in packaged app
  if (!app.isPackaged) {
    return { success: false, error: 'Update check is disabled in development mode' }
  }

  if (state.isChecking) {
    return { success: false, error: 'Already checking for updates' }
  }

  try {
    const result = await autoUpdater.checkForUpdates()
    return {
      success: true,
      updateAvailable: result?.updateInfo?.version !== app.getVersion(),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error('[Updater] Check failed:', message)
    return { success: false, error: message }
  }
}

// Start downloading update (manual trigger)
export async function downloadUpdate(): Promise<{
  success: boolean
  error?: string
}> {
  if (!app.isPackaged) {
    return { success: false, error: 'Update download is disabled in development mode' }
  }

  if (state.isDownloading) {
    return { success: false, error: 'Already downloading update' }
  }

  try {
    state.isDownloading = true
    notifyRenderer('update:downloading')
    await autoUpdater.downloadUpdate()
    return { success: true }
  } catch (error) {
    state.isDownloading = false
    const message = error instanceof Error ? error.message : String(error)
    logger.error('[Updater] Download failed:', message)
    return { success: false, error: message }
  }
}

// Install update and restart
export function installUpdate(): void {
  if (!app.isPackaged) {
    return
  }
  autoUpdater.quitAndInstall(false, true)
}

// Get current updater state
export function getUpdaterState(): UpdaterState {
  return { ...state }
}

// Cleanup
export function cleanupUpdater(): void {
  if (checkInterval) {
    clearInterval(checkInterval)
    checkInterval = null
  }
}

export default {
  initUpdater,
  checkForUpdates,
  downloadUpdate,
  installUpdate,
  getUpdaterState,
  cleanupUpdater,
}
