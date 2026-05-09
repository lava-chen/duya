/**
 * Shell command analysis utilities
 * Provides command parsing, redirection detection, and chain analysis
 */

export interface RedirectionInfo {
  target: string
  operator: '>' | '>>'
}

export interface CommandChain {
  commands: string[]
  operators: string[]
}

/**
 * Split a command string by shell separators (&&, ||, |, ;)
 * Respects quoted strings and parentheses
 *
 * @example
 * splitCommand('echo hello && ls -la | grep foo')
 * // ['echo hello', 'ls -la', 'grep foo']
 */
export function splitCommand(command: string): string[] {
  const commands: string[] = []
  let current = ''
  let inQuote = false
  let quoteChar = ''
  let parenDepth = 0

  for (let i = 0; i < command.length; i++) {
    const char = command[i]

    if (!inQuote) {
      if (char === '"' || char === "'") {
        inQuote = true
        quoteChar = char
        current += char
      } else if (char === '(' || char === '{') {
        parenDepth++
        current += char
      } else if (char === ')' || char === '}') {
        parenDepth--
        current += char
      } else if (
        (char === '&' || char === '|' || char === ';') &&
        parenDepth === 0
      ) {
        if (current.trim()) {
          commands.push(current.trim())
        }
        current = ''
        // Handle && and ||
        if (i + 1 < command.length && command[i + 1] === char) {
          i++
        }
      } else {
        current += char
      }
    } else {
      if (char === quoteChar && (i === 0 || command[i - 1] !== '\\')) {
        inQuote = false
        quoteChar = ''
      }
      current += char
    }
  }

  if (current.trim()) {
    commands.push(current.trim())
  }

  return commands
}

/**
 * @deprecated Use splitCommand instead
 */
export function splitCommand_DEPRECATED(command: string): string[] {
  return splitCommand(command)
}

/**
 * Extract output redirections from a command
 * Detects > and >> operators and identifies dangerous targets
 *
 * @example
 * extractOutputRedirections('echo hello > /tmp/output.txt')
 * // {
 * //   redirections: [{ target: '/tmp/output.txt', operator: '>' }],
 * //   hasDangerousRedirection: false,
 * //   commandWithoutRedirections: 'echo hello'
 * // }
 */
export function extractOutputRedirections(command: string): {
  redirections: RedirectionInfo[]
  hasDangerousRedirection: boolean
  commandWithoutRedirections: string
} {
  const redirections: RedirectionInfo[] = []
  let hasDangerousRedirection = false
  let commandWithoutRedirections = ''
  let inQuote = false
  let quoteChar = ''

  for (let i = 0; i < command.length; i++) {
    const char = command[i]

    if (!inQuote) {
      if (char === '"' || char === "'") {
        inQuote = true
        quoteChar = char
        commandWithoutRedirections += char
      } else if (char === '>' || char === '|') {
        // Check for redirection
        if (char === '>' && i + 1 < command.length && command[i + 1] === '>') {
          // >>
          const target = extractRedirectionTarget(command, i + 2)
          redirections.push({ target, operator: '>>' })
          if (isDangerousRedirectionTarget(target)) {
            hasDangerousRedirection = true
          }
          i = skipToEnd(target, i + 2)
        } else if (char === '>') {
          // >
          const target = extractRedirectionTarget(command, i + 1)
          redirections.push({ target, operator: '>' })
          if (isDangerousRedirectionTarget(target)) {
            hasDangerousRedirection = true
          }
          i = skipToEnd(target, i + 1)
        } else {
          commandWithoutRedirections += char
        }
      } else {
        commandWithoutRedirections += char
      }
    } else {
      if (char === quoteChar) {
        inQuote = false
        quoteChar = ''
      }
      commandWithoutRedirections += char
    }
  }

  return {
    redirections,
    hasDangerousRedirection,
    commandWithoutRedirections: commandWithoutRedirections.trim(),
  }
}

/**
 * Check if a redirection target is potentially dangerous
 * Detects variable expansion and command substitution in target paths
 */
function isDangerousRedirectionTarget(target: string): boolean {
  // Variable expansion: $VAR or ${VAR}
  if (/\$\{?\w+\}?/.test(target)) {
    return true
  }
  // Command substitution
  if (/\$\(|`/.test(target)) {
    return true
  }
  // Glob patterns that could expand unexpectedly
  if (/[*?[]/.test(target)) {
    return true
  }
  // Path traversal attempts
  if (/\.\.[\/\\]/.test(target)) {
    return true
  }
  return false
}

function extractRedirectionTarget(command: string, startIdx: number): string {
  let target = ''
  let i = startIdx
  // Skip whitespace
  while (i < command.length && (command[i] === ' ' || command[i] === '\t')) {
    i++
  }
  // Get target - handle quoted paths
  let inQuote = false
  let quoteChar = ''
  while (i < command.length) {
    const char = command[i]
    if (!inQuote && (char === ' ' || char === '\t' || char === '>' || char === '|')) {
      break
    }
    if (!inQuote && (char === '"' || char === "'")) {
      inQuote = true
      quoteChar = char
      target += char
    } else if (inQuote && char === quoteChar) {
      inQuote = false
      target += char
    } else {
      target += char
    }
    i++
  }
  return target
}

function skipToEnd(target: string, startIdx: number): number {
  return startIdx + target.length
}

/**
 * Parse a command chain into individual commands with their connecting operators
 *
 * @example
 * parseCommandChain('cmd1 && cmd2 || cmd3')
 * // {
 * //   commands: ['cmd1', 'cmd2', 'cmd3'],
 * //   operators: ['&&', '||']
 * // }
 */
export function parseCommandChain(command: string): CommandChain {
  const commands: string[] = []
  const operators: string[] = []
  let current = ''
  let inQuote = false
  let quoteChar = ''
  let parenDepth = 0

  for (let i = 0; i < command.length; i++) {
    const char = command[i]

    if (!inQuote) {
      if (char === '"' || char === "'") {
        inQuote = true
        quoteChar = char
        current += char
      } else if (char === '(' || char === '{') {
        parenDepth++
        current += char
      } else if (char === ')' || char === '}') {
        parenDepth--
        current += char
      } else if (
        (char === '&' || char === '|' || char === ';') &&
        parenDepth === 0
      ) {
        if (current.trim()) {
          commands.push(current.trim())
        }
        current = ''
        // Capture the operator
        if (i + 1 < command.length && command[i + 1] === char) {
          operators.push(char + char)
          i++
        } else {
          operators.push(char)
        }
      } else {
        current += char
      }
    } else {
      if (char === quoteChar && (i === 0 || command[i - 1] !== '\\')) {
        inQuote = false
        quoteChar = ''
      }
      current += char
    }
  }

  if (current.trim()) {
    commands.push(current.trim())
  }

  return { commands, operators }
}

/**
 * Get command subcommand prefix (first two words)
 * Useful for identifying git/npm/docker subcommands
 *
 * @example
 * getCommandSubcommandPrefix('git commit -m "msg"')
 * // { commandPrefix: 'git commit', subcommandPrefixes: Map {} }
 */
export function getCommandSubcommandPrefix(command: string): {
  commandPrefix: string | null
  subcommandPrefixes: Map<string, string>
} {
  const parts = command.trim().split(/\s+/)
  if (parts.length < 2) {
    return { commandPrefix: null, subcommandPrefixes: new Map() }
  }
  return {
    commandPrefix: `${parts[0]} ${parts[1]}`,
    subcommandPrefixes: new Map(),
  }
}

/**
 * Analyze command complexity
 * Returns metrics about the command structure
 */
export function analyzeCommandComplexity(command: string): {
  pipeCount: number
  chainCount: number
  hasRedirection: boolean
  hasSubshell: boolean
  complexity: 'simple' | 'moderate' | 'complex'
} {
  const normalized = command.replace(/\\"/g, '').replace(/\\'/g, '')

  // Count chains first (&& and ||), then count remaining single | as pipes
  const chainCount = (normalized.match(/&&|\|\|/g) || []).length
  // Replace chains temporarily to avoid counting || as two pipes
  const withoutChains = normalized.replace(/\|\|/g, '').replace(/&&/g, '')
  const pipeCount = (withoutChains.match(/\|/g) || []).length
  const hasRedirection = /[0-9]*>/.test(normalized)
  const hasSubshell = /\$\(|`/.test(normalized) || /\([^)]*\)/.test(normalized)

  let complexity: 'simple' | 'moderate' | 'complex' = 'simple'
  if (pipeCount > 3 || chainCount > 2 || hasSubshell) {
    complexity = 'complex'
  } else if (pipeCount > 0 || chainCount > 0 || hasRedirection) {
    complexity = 'moderate'
  }

  return {
    pipeCount,
    chainCount,
    hasRedirection,
    hasSubshell,
    complexity,
  }
}
