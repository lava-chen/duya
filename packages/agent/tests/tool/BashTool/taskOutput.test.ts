import { describe, expect, it, beforeEach } from 'vitest';
import { getTaskOutputPath, getTaskOutputDir, _resetTaskOutputDirForTest } from '../../../src/tool/BashTool/taskOutput.js';

describe('taskOutput path', () => {
  beforeEach(() => _resetTaskOutputDirForTest());

  it('builds path under project temp + sessionId + tasks/', () => {
    const dir = getTaskOutputDir('sess-abc');
    expect(dir.replace(/\\/g, '/')).toMatch(/tasks$/);
    expect(dir).toContain('sess-abc');
  });

  it('returns the same path for the same taskId', () => {
    const a = getTaskOutputPath('sess-abc', 'task-1');
    const b = getTaskOutputPath('sess-abc', 'task-1');
    expect(a).toBe(b);
    expect(a).toMatch(/task-1\.output$/);
  });

  it('uses different paths for different taskIds', () => {
    const a = getTaskOutputPath('sess-abc', 'task-1');
    const b = getTaskOutputPath('sess-abc', 'task-2');
    expect(a).not.toBe(b);
  });

  it('memorizes the directory for the lifetime of the session id', () => {
    const a = getTaskOutputDir('sess-abc');
    const b = getTaskOutputDir('sess-abc');
    expect(a).toBe(b);
  });
});
