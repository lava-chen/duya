import { describe, expect, it } from 'vitest';
import { buildGatewayInboundChatRequest } from './inbound-request';

describe('buildGatewayInboundChatRequest', () => {
  it('passes the isolated gateway workspace at the Agent Server top level', () => {
    const request = buildGatewayInboundChatRequest({
      inbound: {
        prompt: 'find a file',
        platform: 'weixin',
        platformMsgId: 'msg-1',
        platformChatId: 'chat-1',
        options: { agentProfileId: 'main', workingDirectory: 'E:\\Projects\\duya' },
      },
      providerConfig: { provider: 'openai' },
      workingDirectory: 'C:\\Users\\tester\\.duya\\workspace',
    });

    expect(request.workingDirectory).toBe('C:\\Users\\tester\\.duya\\workspace');
    expect(request.defaultWorkspaceDirectory).toBe('C:\\Users\\tester\\.duya\\workspace');
    expect(request.options).toMatchObject({
      agentProfileId: 'gateway',
      platform: 'weixin',
      platformMsgId: 'msg-1',
      platformChatId: 'chat-1',
    });
  });
});
