import { describe, expect, it } from 'vitest';

import { ipv4InCidr } from './index.js';

describe('ipv4InCidr', () => {
  it('matches addresses inside a subnet', () => {
    expect(ipv4InCidr('52.96.1.1', '52.96.0.0/12')).toBe(true);
    expect(ipv4InCidr('52.96.1.1', '52.96.0.0/16')).toBe(true);
    expect(ipv4InCidr('52.97.1.1', '52.96.0.0/16')).toBe(false);
  });

  it('handles /32 and /0 boundaries', () => {
    expect(ipv4InCidr('10.0.0.1', '10.0.0.1/32')).toBe(true);
    expect(ipv4InCidr('10.0.0.2', '10.0.0.1/32')).toBe(false);
    expect(ipv4InCidr('203.0.113.9', '0.0.0.0/0')).toBe(true);
  });

  it('rejects malformed networks and addresses', () => {
    expect(ipv4InCidr('10.0.0.1', '10.0.0.0')).toBe(false);
    expect(ipv4InCidr('10.0.0.1', '10.0.0.0/33')).toBe(false);
    expect(ipv4InCidr('10.0.0.1', 'not-a-network/8')).toBe(false);
    expect(ipv4InCidr('10.0.0.300', '10.0.0.0/8')).toBe(false);
    expect(ipv4InCidr('::1', '10.0.0.0/8')).toBe(false);
  });
});
