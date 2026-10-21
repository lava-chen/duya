import { describe, expect, it } from 'vitest';

import {
  checkUserAllowed,
  isFreeResponseChat,
  isGroupChat,
  isPrivateChat,
  shouldRespondInGroup,
} from '../group-gating';

describe('isGroupChat', () => {
  it('classifies p2p (DM) as NOT a group', () => {
    // Regression: a44d41b6 added 'p2p' to isGroupChat, which mention-gated
    // every direct message and silently dropped them (DMs rarely carry an
    // @mention). p2p must route through the private-chat branch.
    expect(isGroupChat('p2p')).toBe(false);
  });

  it('classifies group chat types as groups', () => {
    expect(isGroupChat('group')).toBe(true);
    expect(isGroupChat('open_chat')).toBe(true);
    expect(isGroupChat('group_v2')).toBe(true);
  });

  it('isPrivateChat still recognises p2p', () => {
    expect(isPrivateChat('p2p')).toBe(true);
  });
});

describe('shouldRespondInGroup', () => {
  it('lets a plain DM through without any @mention', () => {
    const result = shouldRespondInGroup(
      'oc_chat1',
      'p2p',
      'ou_user1',
      'ou_bot',
      'hello',
      undefined,
      undefined,
      undefined,
    );
    expect(result.canRespond).toBe(true);
  });

  it('still requires a mention in a real group', () => {
    const result = shouldRespondInGroup(
      'oc_group1',
      'group',
      'ou_user1',
      'ou_bot',
      JSON.stringify({ text: 'hello' }),
      undefined,
      undefined,
      undefined,
    );
    expect(result.canRespond).toBe(false);
    expect(result.reason).toBe('Bot not mentioned');
  });
});

describe('checkUserAllowed', () => {
  it('allows everyone when no allowlist is configured', () => {
    expect(checkUserAllowed('ou_anyone', undefined)).toBe(true);
    expect(checkUserAllowed('ou_anyone', [])).toBe(true);
  });
});

describe('isFreeResponseChat', () => {
  it('is false without a free-response list', () => {
    expect(isFreeResponseChat('oc_chat1', undefined)).toBe(false);
  });
});
