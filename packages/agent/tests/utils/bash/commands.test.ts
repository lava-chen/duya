import { describe, it, expect } from 'vitest'
import {
  splitCommand,
  splitCommand_DEPRECATED,
  extractOutputRedirections,
  parseCommandChain,
  getCommandSubcommandPrefix,
  analyzeCommandComplexity,
  type RedirectionInfo,
  type CommandChain,
} from '../../../src/utils/bash/commands'

describe('commands utilities', () => {
  describe('splitCommand', () => {
    it('should split simple commands by &&', () => {
      const result = splitCommand('echo hello && ls -la')
      expect(result).toEqual(['echo hello', 'ls -la'])
    })

    it('should split commands by ||', () => {
      const result = splitCommand('cmd1 || cmd2 || cmd3')
      expect(result).toEqual(['cmd1', 'cmd2', 'cmd3'])
    })

    it('should split commands by | (pipe)', () => {
      const result = splitCommand('cat file.txt | grep pattern | wc -l')
      expect(result).toEqual(['cat file.txt', 'grep pattern', 'wc -l'])
    })

    it('should split commands by ;', () => {
      const result = splitCommand('echo a; echo b; echo c')
      expect(result).toEqual(['echo a', 'echo b', 'echo c'])
    })

    it('should respect quoted strings', () => {
      const result = splitCommand('echo "hello && world" && ls')
      expect(result).toEqual(['echo "hello && world"', 'ls'])
    })

    it('should respect single quotes', () => {
      const result = splitCommand("echo 'a | b' | cat")
      expect(result).toEqual(["echo 'a | b'", 'cat'])
    })

    it('should respect parentheses', () => {
      const result = splitCommand('(echo a && echo b) | cat')
      expect(result).toEqual(['(echo a && echo b)', 'cat'])
    })

    it('should handle empty command', () => {
      const result = splitCommand('')
      expect(result).toEqual([])
    })

    it('should handle command with only whitespace', () => {
      const result = splitCommand('   ')
      expect(result).toEqual([])
    })

    it('should handle single command without separators', () => {
      const result = splitCommand('echo hello')
      expect(result).toEqual(['echo hello'])
    })
  })

  describe('splitCommand_DEPRECATED', () => {
    it('should work as an alias for splitCommand', () => {
      const result = splitCommand_DEPRECATED('echo a && echo b')
      expect(result).toEqual(['echo a', 'echo b'])
    })
  })

  describe('extractOutputRedirections', () => {
    it('should extract single > redirection', () => {
      const result = extractOutputRedirections('echo hello > /tmp/output.txt')
      expect(result.redirections).toHaveLength(1)
      expect(result.redirections[0]).toEqual({
        target: '/tmp/output.txt',
        operator: '>',
      })
      expect(result.commandWithoutRedirections).toBe('echo hello')
      expect(result.hasDangerousRedirection).toBe(false)
    })

    it('should extract >> append redirection', () => {
      const result = extractOutputRedirections('echo hello >> /tmp/log.txt')
      expect(result.redirections).toHaveLength(1)
      expect(result.redirections[0]).toEqual({
        target: '/tmp/log.txt',
        operator: '>>',
      })
      expect(result.commandWithoutRedirections).toBe('echo hello')
    })

    it('should detect dangerous redirection with variable', () => {
      const result = extractOutputRedirections('echo hello > $FILE')
      expect(result.redirections[0].target).toBe('$FILE')
      expect(result.hasDangerousRedirection).toBe(true)
    })

    it('should detect dangerous redirection with command substitution', () => {
      const result = extractOutputRedirections('echo hello > $(echo /tmp/file)')
      expect(result.hasDangerousRedirection).toBe(true)
    })

    it('should detect dangerous redirection with path traversal', () => {
      const result = extractOutputRedirections('echo hello > ../../../etc/passwd')
      expect(result.hasDangerousRedirection).toBe(true)
    })

    it('should respect quoted redirection targets', () => {
      const result = extractOutputRedirections('echo hello > "/tmp/my file.txt"')
      expect(result.redirections[0].target).toBe('"/tmp/my file.txt"')
    })

    it('should handle multiple redirections', () => {
      const result = extractOutputRedirections('cmd > /tmp/out 2> /tmp/err')
      expect(result.redirections).toHaveLength(2)
    })

    it('should ignore pipe operators', () => {
      const result = extractOutputRedirections('echo hello | cat')
      expect(result.redirections).toHaveLength(0)
      expect(result.commandWithoutRedirections).toBe('echo hello | cat')
    })

    it('should handle command without redirection', () => {
      const result = extractOutputRedirections('echo hello world')
      expect(result.redirections).toHaveLength(0)
      expect(result.commandWithoutRedirections).toBe('echo hello world')
      expect(result.hasDangerousRedirection).toBe(false)
    })

    it('should handle empty command', () => {
      const result = extractOutputRedirections('')
      expect(result.redirections).toHaveLength(0)
      expect(result.commandWithoutRedirections).toBe('')
    })
  })

  describe('parseCommandChain', () => {
    it('should parse simple command chain', () => {
      const result = parseCommandChain('cmd1 && cmd2')
      expect(result.commands).toEqual(['cmd1', 'cmd2'])
      expect(result.operators).toEqual(['&&'])
    })

    it('should parse mixed operators', () => {
      const result = parseCommandChain('cmd1 && cmd2 || cmd3')
      expect(result.commands).toEqual(['cmd1', 'cmd2', 'cmd3'])
      expect(result.operators).toEqual(['&&', '||'])
    })

    it('should parse pipe chain', () => {
      const result = parseCommandChain('cat file | grep pattern | wc -l')
      expect(result.commands).toEqual(['cat file', 'grep pattern', 'wc -l'])
      expect(result.operators).toEqual(['|', '|'])
    })

    it('should parse semicolon chain', () => {
      const result = parseCommandChain('cmd1; cmd2; cmd3')
      expect(result.commands).toEqual(['cmd1', 'cmd2', 'cmd3'])
      expect(result.operators).toEqual([';', ';'])
    })

    it('should respect quoted strings', () => {
      const result = parseCommandChain('echo "a && b" && ls')
      expect(result.commands).toEqual(['echo "a && b"', 'ls'])
      expect(result.operators).toEqual(['&&'])
    })

    it('should handle empty command', () => {
      const result = parseCommandChain('')
      expect(result.commands).toEqual([])
      expect(result.operators).toEqual([])
    })

    it('should handle single command', () => {
      const result = parseCommandChain('echo hello')
      expect(result.commands).toEqual(['echo hello'])
      expect(result.operators).toEqual([])
    })
  })

  describe('getCommandSubcommandPrefix', () => {
    it('should return prefix for command with subcommand', () => {
      const result = getCommandSubcommandPrefix('git commit -m "msg"')
      expect(result.commandPrefix).toBe('git commit')
    })

    it('should return null for single word command', () => {
      const result = getCommandSubcommandPrefix('ls')
      expect(result.commandPrefix).toBeNull()
    })

    it('should handle npm commands', () => {
      const result = getCommandSubcommandPrefix('npm install --save package')
      expect(result.commandPrefix).toBe('npm install')
    })

    it('should handle docker commands', () => {
      const result = getCommandSubcommandPrefix('docker build -t myimage .')
      expect(result.commandPrefix).toBe('docker build')
    })

    it('should handle empty command', () => {
      const result = getCommandSubcommandPrefix('')
      expect(result.commandPrefix).toBeNull()
    })
  })

  describe('analyzeCommandComplexity', () => {
    it('should analyze simple command', () => {
      const result = analyzeCommandComplexity('echo hello')
      expect(result.pipeCount).toBe(0)
      expect(result.chainCount).toBe(0)
      expect(result.hasRedirection).toBe(false)
      expect(result.hasSubshell).toBe(false)
      expect(result.complexity).toBe('simple')
    })

    it('should analyze command with pipes', () => {
      const result = analyzeCommandComplexity('cat file | grep pattern | wc -l')
      expect(result.pipeCount).toBe(2)
      expect(result.chainCount).toBe(0)
      expect(result.complexity).toBe('moderate')
    })

    it('should analyze command with chains', () => {
      const result = analyzeCommandComplexity('cmd1 && cmd2 || cmd3')
      expect(result.pipeCount).toBe(0)
      expect(result.chainCount).toBe(2)
      expect(result.complexity).toBe('moderate')
    })

    it('should analyze complex command', () => {
      const result = analyzeCommandComplexity('cat file | grep pattern | sort | uniq | wc -l')
      expect(result.pipeCount).toBe(4)
      expect(result.complexity).toBe('complex')
    })

    it('should detect redirection', () => {
      const result = analyzeCommandComplexity('echo hello > /tmp/file')
      expect(result.hasRedirection).toBe(true)
      expect(result.complexity).toBe('moderate')
    })

    it('should detect subshell', () => {
      const result = analyzeCommandComplexity('$(echo hello)')
      expect(result.hasSubshell).toBe(true)
      expect(result.complexity).toBe('complex')
    })

    it('should detect command substitution', () => {
      const result = analyzeCommandComplexity('echo `date`')
      expect(result.hasSubshell).toBe(true)
      expect(result.complexity).toBe('complex')
    })

    it('should handle very complex command', () => {
      const result = analyzeCommandComplexity('cmd1 && cmd2 && cmd3 || cmd4')
      expect(result.chainCount).toBe(3)
      expect(result.complexity).toBe('complex')
    })
  })
})
