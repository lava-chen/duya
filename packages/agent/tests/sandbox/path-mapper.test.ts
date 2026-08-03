/**
 * PathMapper tests — bidirectional host ↔ container path translation.
 *
 * Covers the three path formats the LLM emits on Windows and the
 * reverse translation for command output.
 */

import { describe, it, expect } from 'vitest';
import { PathMapper } from '../../src/sandbox/path-mapper.js';

describe('PathMapper', () => {
  describe('rewriteCommandToContainer', () => {
    it('translates Windows backslash paths', () => {
      const mapper = new PathMapper({ hostCwd: 'E:\\Projects\\duya' });
      expect(mapper.rewriteCommandToContainer('ls E:\\Projects\\duya\\src'))
        .toBe('ls /workspace/src');
    });

    it('translates Windows forward-slash paths', () => {
      const mapper = new PathMapper({ hostCwd: 'E:\\Projects\\duya' });
      expect(mapper.rewriteCommandToContainer('ls E:/Projects/duya/src'))
        .toBe('ls /workspace/src');
    });

    it('translates Git Bash POSIX paths', () => {
      const mapper = new PathMapper({ hostCwd: 'E:\\Projects\\duya' });
      expect(mapper.rewriteCommandToContainer('ls /e/Projects/duya/src'))
        .toBe('ls /workspace/src');
    });

    it('translates the cwd root itself', () => {
      const mapper = new PathMapper({ hostCwd: 'E:\\Projects\\duya' });
      expect(mapper.rewriteCommandToContainer('cd E:/Projects/duya && ls'))
        .toBe('cd /workspace && ls');
    });

    it('is case-insensitive for drive letters', () => {
      const mapper = new PathMapper({ hostCwd: 'E:\\Projects\\duya' });
      expect(mapper.rewriteCommandToContainer('ls e:\\Projects\\duya\\src'))
        .toBe('ls /workspace/src');
    });

    it('does not partially match a sibling directory', () => {
      const mapper = new PathMapper({ hostCwd: 'E:\\Projects\\duya' });
      // "duya-backup" should NOT be translated
      expect(mapper.rewriteCommandToContainer('ls E:/Projects/duya-backup'))
        .toBe('ls E:/Projects/duya-backup');
    });

    it('leaves relative paths untouched', () => {
      const mapper = new PathMapper({ hostCwd: 'E:\\Projects\\duya' });
      expect(mapper.rewriteCommandToContainer('ls src/foo.ts'))
        .toBe('ls src/foo.ts');
    });

    it('handles multiple host paths in one command', () => {
      const mapper = new PathMapper({ hostCwd: 'E:\\Projects\\duya' });
      const cmd = 'cp E:/Projects/duya/a.txt E:\\Projects\\duya\\b.txt';
      expect(mapper.rewriteCommandToContainer(cmd))
        .toBe('cp /workspace/a.txt /workspace/b.txt');
    });

    it('handles Unix host paths', () => {
      const mapper = new PathMapper({ hostCwd: '/home/user/project' });
      expect(mapper.rewriteCommandToContainer('ls /home/user/project/src'))
        .toBe('ls /workspace/src');
    });

    it('handles custom container root', () => {
      const mapper = new PathMapper({
        hostCwd: 'E:\\Projects\\duya',
        containerRoot: '/sandbox',
      });
      expect(mapper.rewriteCommandToContainer('ls E:/Projects/duya/src'))
        .toBe('ls /sandbox/src');
    });

    it('returns input unchanged when hostCwd is empty', () => {
      const mapper = new PathMapper({ hostCwd: '' });
      expect(mapper.rewriteCommandToContainer('ls /any/path'))
        .toBe('ls /any/path');
    });
  });

  describe('rewriteOutputToHost', () => {
    it('translates container paths back to host paths', () => {
      const mapper = new PathMapper({ hostCwd: 'E:\\Projects\\duya' });
      expect(mapper.rewriteOutputToHost('/workspace/src/foo.ts:10: error'))
        .toBe('E:/Projects/duya/src/foo.ts:10: error');
    });

    it('translates bare /workspace', () => {
      const mapper = new PathMapper({ hostCwd: 'E:\\Projects\\duya' });
      expect(mapper.rewriteOutputToHost('cd /workspace'))
        .toBe('cd E:/Projects/duya');
    });

    it('does not partially match /workspace-foo', () => {
      const mapper = new PathMapper({ hostCwd: 'E:\\Projects\\duya' });
      expect(mapper.rewriteOutputToHost('path: /workspace-foo'))
        .toBe('path: /workspace-foo');
    });

    it('handles multiple container paths in output', () => {
      const mapper = new PathMapper({ hostCwd: 'E:\\Projects\\duya' });
      const output = 'diff /workspace/a.ts /workspace/b.ts';
      expect(mapper.rewriteOutputToHost(output))
        .toBe('diff E:/Projects/duya/a.ts E:/Projects/duya/b.ts');
    });

    it('returns input unchanged when hostCwd is empty', () => {
      const mapper = new PathMapper({ hostCwd: '' });
      expect(mapper.rewriteOutputToHost('/workspace/src/foo.ts'))
        .toBe('/workspace/src/foo.ts');
    });

    it('handles Unix host paths in output', () => {
      const mapper = new PathMapper({ hostCwd: '/home/user/project' });
      expect(mapper.rewriteOutputToHost('/workspace/src/foo.ts'))
        .toBe('/home/user/project/src/foo.ts');
    });
  });

  describe('round-trip', () => {
    it('command → container → output → host is consistent', () => {
      const mapper = new PathMapper({ hostCwd: 'E:\\Projects\\duya' });
      // LLM emits a host path
      const llmCommand = 'grep "foo" E:/Projects/duya/src/bar.ts';
      const containerCmd = mapper.rewriteCommandToContainer(llmCommand);
      // Container produces output referencing /workspace
      const containerOutput = '/workspace/src/bar.ts:5:foo';
      const hostOutput = mapper.rewriteOutputToHost(containerOutput);
      // The LLM sees its familiar host path
      expect(hostOutput).toBe('E:/Projects/duya/src/bar.ts:5:foo');
      // And the container command uses the mount point
      expect(containerCmd).toBe('grep "foo" /workspace/src/bar.ts');
    });
  });
});
