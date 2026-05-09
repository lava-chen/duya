/**
 * ANSI Color definitions for CLI output
 */

import * as os from 'os'

export const Colors = {
  RESET: '\x1b[0m',
  BOLD: '\x1b[1m',
  DIM: '\x1b[2m',

  // Standard foreground colors
  BLACK: '\x1b[30m',
  RED: '\x1b[31m',
  GREEN: '\x1b[32m',
  YELLOW: '\x1b[33m',
  BLUE: '\x1b[34m',
  MAGENTA: '\x1b[35m',
  CYAN: '\x1b[36m',
  WHITE: '\x1b[37m',

  // Bright foreground colors
  BRIGHT_BLACK: '\x1b[90m',
  BRIGHT_RED: '\x1b[91m',
  BRIGHT_GREEN: '\x1b[92m',
  BRIGHT_YELLOW: '\x1b[93m',
  BRIGHT_BLUE: '\x1b[94m',
  BRIGHT_MAGENTA: '\x1b[95m',
  BRIGHT_CYAN: '\x1b[96m',
  BRIGHT_WHITE: '\x1b[97m',

  // Background colors
  BG_RED: '\x1b[41m',
  BG_GREEN: '\x1b[42m',
  BG_YELLOW: '\x1b[43m',
  BG_BLUE: '\x1b[44m',

  // ASCII symbols for Windows compatibility
  TOOL: '[TOOL]',
  SUCCESS: '[OK]',
  ERROR: '[ERR]',
  THINKING: '[THINK]',
  ASSISTANT: '[AI]',
  TIMEOUT: '[TIMEOUT]',
}

/**
 * Check if color output should be used
 */
export function shouldUseColor(): boolean {
  // Respect NO_COLOR env variable
  if (process.env.NO_COLOR !== undefined) {
    return false
  }
  // Check if TERM is dumb
  if (process.env.TERM === 'dumb') {
    return false
  }
  // Check if stdout is a TTY
  if (!process.stdout.isTTY) {
    return false
  }
  return true
}

/**
 * Print a message with color
 */
export function color(message: string, c: keyof typeof Colors | string): string {
  if (!shouldUseColor()) {
    return message
  }
  const colorCode = Colors[c as keyof typeof Colors] || c
  return `${colorCode}${message}${Colors.RESET}`
}

/**
 * Print a bold message
 */
export function bold(message: string): string {
  return `${Colors.BOLD}${message}${Colors.RESET}`
}

/**
 * Print a dim message
 */
export function dim(message: string): string {
  return `${Colors.DIM}${message}${Colors.RESET}`
}
