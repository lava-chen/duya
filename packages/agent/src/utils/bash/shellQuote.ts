/**
 * Shell command parsing utilities
 * Provides tokenization and syntax validation for shell commands
 */

export interface ParseShellResult {
  success: boolean
  tokens: string[]
  error?: string
}

/**
 * Parse a shell command string into tokens
 * Handles quoted strings, escape sequences, and whitespace
 *
 * @example
 * tryParseShellCommand('git commit -m "hello world"')
 * // { success: true, tokens: ['git', 'commit', '-m', '"hello world"'] }
 */
export function tryParseShellCommand(
  command: string,
  _envSubstitution?: (env: string) => string,
): ParseShellResult {
  try {
    const tokens: string[] = []
    let current = ''
    let inQuote = false
    let quoteChar = ''
    let escapeNext = false

    for (let i = 0; i < command.length; i++) {
      const char = command[i]

      if (escapeNext) {
        current += char
        escapeNext = false
        continue
      }

      if (char === '\\') {
        escapeNext = true
        current += char
        continue
      }

      if (!inQuote) {
        if (char === '"' || char === "'") {
          inQuote = true
          quoteChar = char
          current += char
        } else if (char === ' ' || char === '\t') {
          if (current) {
            tokens.push(current)
            current = ''
          }
        } else {
          current += char
        }
      } else {
        if (char === quoteChar) {
          inQuote = false
          quoteChar = ''
        }
        current += char
      }
    }

    if (current) {
      tokens.push(current)
    }

    return { success: true, tokens }
  } catch (error) {
    return {
      success: false,
      tokens: [],
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/**
 * Check if tokens have malformed shell syntax (unmatched quotes)
 *
 * @example
 * hasMalformedTokens(['echo', '"hello']) // true (unclosed quote)
 * hasMalformedTokens(['echo', '"hello"']) // false
 */
export function hasMalformedTokens(tokens: string[]): boolean {
  return tokens.some(token => {
    let inQuote = false
    let quoteChar = ''
    for (const char of token) {
      if ((char === '"' || char === "'") && (inQuote === false || quoteChar === char)) {
        inQuote = !inQuote
        quoteChar = char
      }
    }
    return inQuote
  })
}

/**
 * Get the main command from a token array
 * Returns the first token (the command name)
 *
 * @example
 * getCommandFromTokens(['git', 'commit', '-m', 'msg']) // 'git'
 */
export function getCommandFromTokens(tokens: string[]): string | null {
  if (tokens.length === 0) return null
  const cmd = tokens[0]
  // Remove any path prefix to get the base command name
  return cmd.replace(/^.*[/\\]/, '')
}

/**
 * Get command arguments (excluding the command itself)
 *
 * @example
 * getCommandArgs(['git', 'commit', '-m', 'msg']) // ['commit', '-m', 'msg']
 */
export function getCommandArgs(tokens: string[]): string[] {
  return tokens.slice(1)
}

/**
 * Check if command contains shell operators that might be dangerous
 * Detects command substitution, process substitution, etc.
 */
export function hasDangerousShellSyntax(command: string): boolean {
  // Command substitution: $(...) or `...`
  if (/\$\(|`/.test(command)) {
    return true
  }
  // Process substitution: <(...) or >(...)
  if (/[<>]\(/.test(command)) {
    return true
  }
  // Brace expansion with potential risks
  if (/\$\{[^}]*[!#]/.test(command)) {
    return true
  }
  return false
}

/**
 * Check for shell-quote single-quote backslash bug (legacy placeholder)
 * @deprecated This was a placeholder for a specific bug, always returns false
 */
export function hasShellQuoteSingleQuoteBug(_tokens: string[]): boolean {
  return false
}
