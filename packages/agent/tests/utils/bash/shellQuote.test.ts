import { describe, it, expect } from 'vitest'
import {
  tryParseShellCommand,
  hasMalformedTokens,
  hasShellQuoteSingleQuoteBug,
  getCommandFromTokens,
  getCommandArgs,
  hasDangerousShellSyntax,
  type ParseShellResult,
} from '../../../src/utils/bash/shellQuote'

describe('shellQuote utilities', () => {
  describe('tryParseShellCommand', () => {
    it('should parse simple command', () => {
      const result = tryParseShellCommand('ls -la')
      expect(result.success).toBe(true)
      expect(result.tokens).toEqual(['ls', '-la'])
    })

    it('should parse command with multiple spaces', () => {
      const result = tryParseShellCommand('ls   -la   /path')
      expect(result.success).toBe(true)
      expect(result.tokens).toEqual(['ls', '-la', '/path'])
    })

    it('should parse command with tabs', () => {
      const result = tryParseShellCommand('ls\t-la\t/path')
      expect(result.success).toBe(true)
      expect(result.tokens).toEqual(['ls', '-la', '/path'])
    })

    it('should parse command with double quotes', () => {
      const result = tryParseShellCommand('echo "hello world"')
      expect(result.success).toBe(true)
      expect(result.tokens).toEqual(['echo', '"hello world"'])
    })

    it('should parse command with single quotes', () => {
      const result = tryParseShellCommand("echo 'hello world'")
      expect(result.success).toBe(true)
      expect(result.tokens).toEqual(['echo', "'hello world'"])
    })

    it('should parse command with mixed quotes', () => {
      const result = tryParseShellCommand('echo "double" and \'single\'')
      expect(result.success).toBe(true)
      expect(result.tokens).toEqual(['echo', '"double"', 'and', "'single'"])
    })

    it('should handle escaped characters', () => {
      const result = tryParseShellCommand('echo hello\\ world')
      expect(result.success).toBe(true)
      expect(result.tokens).toEqual(['echo', 'hello\\ world'])
    })

    it('should handle escaped quotes', () => {
      const result = tryParseShellCommand('echo \"quoted\"')
      expect(result.success).toBe(true)
      expect(result.tokens).toEqual(['echo', '"quoted"'])
    })

    it('should parse complex command', () => {
      const result = tryParseShellCommand('git commit -m "Initial commit" --no-verify')
      expect(result.success).toBe(true)
      expect(result.tokens).toEqual([
        'git',
        'commit',
        '-m',
        '"Initial commit"',
        '--no-verify',
      ])
    })

    it('should parse command with path arguments', () => {
      const result = tryParseShellCommand('cat /path/to/file.txt')
      expect(result.success).toBe(true)
      expect(result.tokens).toEqual(['cat', '/path/to/file.txt'])
    })

    it('should handle empty string', () => {
      const result = tryParseShellCommand('')
      expect(result.success).toBe(true)
      expect(result.tokens).toEqual([])
    })

    it('should handle command with only spaces', () => {
      const result = tryParseShellCommand('   ')
      expect(result.success).toBe(true)
      expect(result.tokens).toEqual([])
    })

    it('should parse command with flags and values', () => {
      const result = tryParseShellCommand('npm run build -- --production')
      expect(result.success).toBe(true)
      expect(result.tokens).toEqual(['npm', 'run', 'build', '--', '--production'])
    })
  })

  describe('hasMalformedTokens', () => {
    it('should return false for valid tokens', () => {
      expect(hasMalformedTokens(['ls', '-la'])).toBe(false)
      expect(hasMalformedTokens(['echo', '"hello"'])).toBe(false)
      expect(hasMalformedTokens(["echo", "'hello'"])).toBe(false)
    })

    it('should detect unmatched double quote', () => {
      expect(hasMalformedTokens(['echo', '"hello'])).toBe(true)
    })

    it('should detect unmatched single quote', () => {
      expect(hasMalformedTokens(["echo", "'hello"])).toBe(true)
    })

    it('should not detect escaped quotes as unmatched', () => {
      // Note: This is a limitation - escaped quotes inside tokens are not handled
      expect(hasMalformedTokens(['echo', '\\"hello\\"'])).toBe(false)
    })

    it('should handle empty tokens array', () => {
      expect(hasMalformedTokens([])).toBe(false)
    })

    it('should handle empty string tokens', () => {
      expect(hasMalformedTokens([''])).toBe(false)
    })

    it('should detect multiple malformed tokens', () => {
      expect(hasMalformedTokens(['echo', '"hello', "'world"])).toBe(true)
    })

    it('should return false when all quotes matched', () => {
      expect(hasMalformedTokens(['"hello"', "'world'", '"mixed"'])).toBe(false)
    })
  })

  describe('hasShellQuoteSingleQuoteBug', () => {
    it('should always return false (placeholder)', () => {
      expect(hasShellQuoteSingleQuoteBug([])).toBe(false)
      expect(hasShellQuoteSingleQuoteBug(["'test'"])).toBe(false)
      expect(hasShellQuoteSingleQuoteBug(['test'])).toBe(false)
    })
  })

  describe('getCommandFromTokens', () => {
    it('should return command name from tokens', () => {
      expect(getCommandFromTokens(['git', 'commit', '-m', 'msg'])).toBe('git')
    })

    it('should extract command from path', () => {
      expect(getCommandFromTokens(['/usr/bin/git', 'status'])).toBe('git')
      expect(getCommandFromTokens(['C:\\Program Files\\node\\node.exe', 'script.js'])).toBe('node.exe')
    })

    it('should return null for empty tokens', () => {
      expect(getCommandFromTokens([])).toBeNull()
    })

    it('should handle single token', () => {
      expect(getCommandFromTokens(['ls'])).toBe('ls')
    })
  })

  describe('getCommandArgs', () => {
    it('should return arguments from tokens', () => {
      expect(getCommandArgs(['git', 'commit', '-m', 'msg'])).toEqual(['commit', '-m', 'msg'])
    })

    it('should return empty array for single token', () => {
      expect(getCommandArgs(['ls'])).toEqual([])
    })

    it('should return empty array for empty tokens', () => {
      expect(getCommandArgs([])).toEqual([])
    })
  })

  describe('hasDangerousShellSyntax', () => {
    it('should detect command substitution $()', () => {
      expect(hasDangerousShellSyntax('echo $(whoami)')).toBe(true)
      expect(hasDangerousShellSyntax('echo $(cat /etc/passwd)')).toBe(true)
    })

    it('should detect backtick command substitution', () => {
      expect(hasDangerousShellSyntax('echo `date`')).toBe(true)
      expect(hasDangerousShellSyntax('echo `whoami`')).toBe(true)
    })

    it('should detect process substitution', () => {
      expect(hasDangerousShellSyntax('cat <(echo hello)')).toBe(true)
      expect(hasDangerousShellSyntax('echo >(cat)')).toBe(true)
    })

    it('should detect dangerous brace expansion', () => {
      expect(hasDangerousShellSyntax('echo ${VAR!}')).toBe(true)
      expect(hasDangerousShellSyntax('echo ${VAR#}')).toBe(true)
    })

    it('should return false for safe commands', () => {
      expect(hasDangerousShellSyntax('echo hello')).toBe(false)
      expect(hasDangerousShellSyntax('ls -la')).toBe(false)
      expect(hasDangerousShellSyntax('git status')).toBe(false)
    })

    it('should return false for variable expansion only', () => {
      expect(hasDangerousShellSyntax('echo $HOME')).toBe(false)
      expect(hasDangerousShellSyntax('echo ${VAR}')).toBe(false)
    })
  })
})
