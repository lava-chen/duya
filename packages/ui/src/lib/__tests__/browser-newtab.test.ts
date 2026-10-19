// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearHistory,
  isRecordableUrl,
  listFavorites,
  listHistory,
  recordVisit,
  removeFavorite,
  toggleFavorite,
} from '../browser-newtab';

const VISIT = { url: 'https://example.com/page', title: 'Example', favicon: 'https://example.com/f.png' };

beforeEach(() => {
  localStorage.clear();
});

describe('isRecordableUrl', () => {
  it('accepts real page URLs and rejects internal ones', () => {
    expect(isRecordableUrl('https://example.com')).toBe(true);
    expect(isRecordableUrl('http://localhost:3000')).toBe(true);
    expect(isRecordableUrl('file:///E:/page.html')).toBe(true);
    expect(isRecordableUrl('about:blank')).toBe(false);
    expect(isRecordableUrl('')).toBe(false);
  });
});

describe('recordVisit', () => {
  it('keeps the newest visit per URL and orders most-recent-first', () => {
    recordVisit(VISIT);
    recordVisit({ ...VISIT, title: 'Updated' });
    const history = listHistory();
    expect(history).toHaveLength(1);
    expect(history[0].title).toBe('Updated');
    expect(history[0].ts).toBeGreaterThan(0);
  });

  it('drops blank pages and caps the list', () => {
    recordVisit({ url: 'about:blank', title: 'blank' });
    for (let i = 0; i < 70; i++) {
      recordVisit({ url: `https://example.com/${i}`, title: `p${i}` });
    }
    const history = listHistory();
    expect(history).toHaveLength(60);
    expect(history[0].url).toBe('https://example.com/69');
  });
});

describe('favorites', () => {
  it('toggles a favorite on and off', () => {
    expect(toggleFavorite(VISIT).favorited).toBe(true);
    expect(listFavorites()[0].title).toBe('Example');
    expect(toggleFavorite(VISIT).favorited).toBe(false);
    expect(listFavorites()).toHaveLength(0);
  });

  it('removes a favorite by url', () => {
    toggleFavorite(VISIT);
    removeFavorite(VISIT.url);
    expect(listFavorites()).toHaveLength(0);
  });
});

describe('clearHistory', () => {
  it('empties history without touching favorites', () => {
    recordVisit(VISIT);
    toggleFavorite(VISIT);
    clearHistory();
    expect(listHistory()).toHaveLength(0);
    expect(listFavorites()).toHaveLength(1);
  });
});
