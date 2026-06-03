import { describe, it, expect } from 'vitest'
import {
  getDirectoryForPath,
  expandTilde,
  containsPathTraversal,
} from '../../src/utils/path'
import { homedir } from 'os'

describe('path utilities', () => {
  describe('getDirectoryForPath', () => {
    it('should return directory for file path', () => {
      expect(getDirectoryForPath('/home/user/file.txt')).toBe('/home/user')
      expect(getDirectoryForPath('C:\\Users\\file.txt')).toBe('C:/Users')
    })

    it('should handle paths with forward slashes', () => {
      expect(getDirectoryForPath('/a/b/c/d.txt')).toBe('/a/b/c')
    })

    it('should handle paths with backslashes', () => {
      expect(getDirectoryForPath('\\a\\b\\c.txt')).toBe('/a/b')
    })

    it('should return root for root-level files', () => {
      expect(getDirectoryForPath('/file.txt')).toBe('/')
    })

    it('should return dot for files without directory', () => {
      expect(getDirectoryForPath('file.txt')).toBe('.')
    })

    it('should handle empty string', () => {
      expect(getDirectoryForPath('')).toBe('.')
    })

    it('should handle paths ending with separator', () => {
      expect(getDirectoryForPath('/a/b/c/')).toBe('/a/b/c')
    })
  })

  describe('expandTilde', () => {
    it('should expand ~ to home directory', () => {
      const home = homedir()
      expect(expandTilde('~')).toBe(home)
    })

    it('should expand ~/path to home directory', () => {
      const home = homedir()
      expect(expandTilde('~/documents')).toBe(`${home}/documents`)
    })

    it('should expand ~\\path on Windows', () => {
      const home = homedir()
      expect(expandTilde('~\\documents')).toBe(`${home}\\documents`)
    })

    it('should not expand paths without tilde', () => {
      expect(expandTilde('/absolute/path')).toBe('/absolute/path')
      expect(expandTilde('relative/path')).toBe('relative/path')
    })

    it('should not expand tilde in middle of path', () => {
      expect(expandTilde('/path/~user/file')).toBe('/path/~user/file')
    })

    it('should handle empty string', () => {
      expect(expandTilde('')).toBe('')
    })
  })

  describe('containsPathTraversal', () => {
    it('should detect /../ pattern', () => {
      expect(containsPathTraversal('/path/../other')).toBe(true)
    })

    it('should detect path ending with /..', () => {
      expect(containsPathTraversal('/path/..')).toBe(true)
    })

    it('should detect standalone ..', () => {
      expect(containsPathTraversal('..')).toBe(true)
    })

    it('should detect backslash traversal', () => {
      expect(containsPathTraversal('\\path\\..\\other')).toBe(true)
    })

    it('should not detect safe paths', () => {
      expect(containsPathTraversal('/safe/path')).toBe(false)
      expect(containsPathTraversal('relative/path')).toBe(false)
    })

    it('should not detect single dot', () => {
      expect(containsPathTraversal('.')).toBe(false)
      expect(containsPathTraversal('/path/./file')).toBe(false)
    })

    it('should not detect .. as part of filename', () => {
      expect(containsPathTraversal('/path/file..txt')).toBe(false)
    })

    it('should handle empty string', () => {
      expect(containsPathTraversal('')).toBe(false)
    })
  })
})
