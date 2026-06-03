import { describe, it, expect } from 'vitest';
import { isUrlBlocked, normalizeDomain, isValidDomain, getEffectiveBlockedDomains, DEFAULT_BLOCKED_DOMAINS } from '../../../src/tool/BrowserTool/DomainBlocker.js';

describe('DomainBlocker', () => {
  describe('isUrlBlocked', () => {
    it('should block exact domain match', () => {
      const blocked = ['example.com'];
      expect(isUrlBlocked('https://example.com', blocked)).toBe(true);
      expect(isUrlBlocked('http://example.com', blocked)).toBe(true);
    });

    it('should block subdomain match', () => {
      const blocked = ['example.com'];
      expect(isUrlBlocked('https://www.example.com', blocked)).toBe(true);
      expect(isUrlBlocked('https://sub.example.com', blocked)).toBe(true);
    });

    it('should block wildcard match', () => {
      const blocked = ['*.example.com'];
      expect(isUrlBlocked('https://sub.example.com', blocked)).toBe(true);
      expect(isUrlBlocked('https://deep.sub.example.com', blocked)).toBe(true);
    });

    it('should not block non-matching domains', () => {
      const blocked = ['example.com'];
      expect(isUrlBlocked('https://other.com', blocked)).toBe(false);
      expect(isUrlBlocked('https://example.com.other.com', blocked)).toBe(false);
    });

    it('should handle empty blocked list', () => {
      expect(isUrlBlocked('https://example.com', [])).toBe(false);
    });

    it('should be case insensitive', () => {
      const blocked = ['EXAMPLE.COM'];
      expect(isUrlBlocked('https://example.com', blocked)).toBe(true);
    });
  });

  describe('normalizeDomain', () => {
    it('should extract domain from URL', () => {
      expect(normalizeDomain('https://example.com')).toBe('example.com');
      expect(normalizeDomain('http://www.example.com/path')).toBe('example.com');
    });

    it('should remove www prefix', () => {
      expect(normalizeDomain('www.example.com')).toBe('example.com');
    });

    it('should preserve wildcard', () => {
      expect(normalizeDomain('*.example.com')).toBe('*.example.com');
    });

    it('should return input for non-URL', () => {
      expect(normalizeDomain('not a url')).toBe('not a url');
    });
  });

  describe('isValidDomain', () => {
    it('should validate simple domains', () => {
      expect(isValidDomain('example.com')).toBe(true);
      expect(isValidDomain('sub.example.com')).toBe(true);
    });

    it('should validate wildcard domains', () => {
      expect(isValidDomain('*.example.com')).toBe(true);
    });

    it('should validate URLs and extract domain', () => {
      expect(isValidDomain('https://example.com')).toBe(true);
    });

    it('should reject invalid domains', () => {
      expect(isValidDomain('not a domain')).toBe(false);
      expect(isValidDomain('')).toBe(false);
    });
  });

  describe('getEffectiveBlockedDomains', () => {
    it('should include default blocked domains', () => {
      const result = getEffectiveBlockedDomains();
      expect(result).toContain('localhost');
      expect(result).toContain('127.0.0.1');
    });

    it('should merge user domains with defaults', () => {
      const result = getEffectiveBlockedDomains({ blockedDomains: ['example.com'] });
      expect(result).toContain('localhost');
      expect(result).toContain('example.com');
    });
  });

  describe('DEFAULT_BLOCKED_DOMAINS', () => {
    it('should include localhost', () => {
      expect(DEFAULT_BLOCKED_DOMAINS).toContain('localhost');
    });

    it('should include 127.0.0.1', () => {
      expect(DEFAULT_BLOCKED_DOMAINS).toContain('127.0.0.1');
    });
  });
});
