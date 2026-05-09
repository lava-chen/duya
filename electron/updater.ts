import { autoUpdater, UpdateInfo } from 'electron-updater'
import { BrowserWindow, dialog, app } from 'electron'
import { getLogger } from './logger'

/**
 * Auto Updater - Automatic update system for DUYA
 *
 * Features:
 * - Check for updates on startup (with delay)
 * - Manual update check via settings
 * - Download progress tracking
 * - User confirmation before install
 * - Only enabled in packaged app
 */

const logger = getLogger()

// Update check interval (24 hours)
const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000

// Delay before first check (3 seconds after startup)
const INITIAL_CHECK_DELAY = 3000

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

// Send state to renderer
function notifyRenderer(event: string, data?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(`update:${event}`, data)
  }
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
    notifyRenderer('checking')
  })

  // Update available
  autoUpdater.on('update-available', (info: UpdateInfo) => {
    logger.info('[Updater] Update available:', info.version)
    state.isChecking = false
    state.updateInfo = info
    notifyRenderer('available', info)

    // Show dialog to user
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog
        .showMessageBox(mainWindow, {
          type: 'info',
          title: '发现新版本',
          message: `发现新版本 ${info.version}`,
          detail: `当前版本: ${app.getVersion()}\n新版本: ${info.version}\n\n是否立即下载更新？`,
          buttons: ['立即下载', '稍后提醒'],
          defaultId: 0,
          cancelId: 1,
        })
        .then((result) => {
          if (result.response === 0) {
            // User chose to download
            logger.info('[Updater] User chose to download update')
            autoUpdater.downloadUpdate().catch((err) => {
              logger.error('[Updater] Failed to download update:', err)
            })
          } else {
            logger.info('[Updater] User postponed update')
          }
        })
    }
  })

  // No update available
  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    logger.info('[Updater] No update available, current version:', info.version)
    state.isChecking = false
    notifyRenderer('not-available', info)
  })

  // Download progress
  autoUpdater.on('download-progress', (progress) => {
    state.downloadProgress = {
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
    }
    notifyRenderer('progress', state.downloadProgress)

    // Log progress every 10%
    if (Math.floor(progress.percent) % 10 === 0) {
      logger.info(`[Updater] Download progress: ${progress.percent.toFixed(1)}%`)
    }
  })

  // Update downloaded
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    logger.info('[Updater] Update downloaded:', info.version)
    state.isDownloading = false
    state.updateInfo = info
    notifyRenderer('downloaded', info)

    // Show dialog to install
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog
        .showMessageBox(mainWindow, {
          type: 'info',
          title: '更新已下载',
          message: `新版本 ${info.version} 已准备就绪`,
          detail: '更新将在重启应用后生效。是否立即安装并重启？',
          buttons: ['立即安装并重启', '稍后手动重启'],
          defaultId: 0,
          cancelId: 1,
        })
        .then((result) => {
          if (result.response === 0) {
            logger.info('[Updater] User chose to install and restart')
            autoUpdater.quitAndInstall()
          } else {
            logger.info('[Updater] User chose to install later')
          }
        })
    }
  })

  // Error handling
  autoUpdater.on('error', (err) => {
    logger.error('[Updater] Error:', err.message)
    state.isChecking = false
    state.isDownloading = false
    state.error = err.message
    notifyRenderer('error', err.message)
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

  // Configure auto updater
  autoUpdater.autoDownload = false // We'll handle download manually
  autoUpdater.autoInstallOnAppQuit = true // Install on quit if downloaded

  // Delayed initial check
  setTimeout(() => {
    logger.info('[Updater] Performing initial update check...')
    checkForUpdates().catch((err) => {
      logger.error('[Updater] Initial check failed:', err)
    })
  }, INITIAL_CHECK_DELAY)

  // Periodic checks
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

// Start downloading update
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
    notifyRenderer('downloading')
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
  autoUpdater.quitAndInstall()
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
