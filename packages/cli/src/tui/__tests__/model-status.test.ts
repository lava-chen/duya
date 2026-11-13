import { describe, expect, it } from 'vitest';
import { describeTuiModelStatus } from '../model-status.js';

describe('describeTuiModelStatus', () => {
  it('replaces the storage placeholder with an action', () => {
    const status = describeTuiModelStatus('env', '');

    expect(status).toEqual({
      provider: '未选择模型',
      model: '输入 /provider',
      statusText: '未选择模型 · /provider',
    });
    expect(status.statusText).not.toContain('env');
  });

  it('asks for a model when the provider is known but no model is selected', () => {
    expect(describeTuiModelStatus('minimax-cn', '')).toEqual({
      provider: 'minimax-cn',
      model: '请选择模型',
      statusText: 'minimax-cn · /model 选择',
    });
  });

  it('shows the selected model', () => {
    expect(describeTuiModelStatus('minimax-cn', 'MiniMax-M3')).toEqual({
      provider: 'minimax-cn',
      model: 'MiniMax-M3',
      statusText: 'minimax-cn · MiniMax-M3',
    });
  });
});
