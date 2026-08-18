import { describe, it, expect } from 'vitest';
import { weiboExtractor } from '../weibo/index.js';
import { instagramExtractor } from '../instagram/index.js';
import { tiktokExtractor } from '../tiktok/index.js';
import { rednoteExtractor } from '../rednote/index.js';
import { xianyuExtractor } from '../xianyu/index.js';
import { jdExtractor } from '../jd/index.js';
import { taobaoExtractor } from '../taobao/index.js';
import { ali1688Extractor } from '../ali1688/index.js';

describe('domestic / commerce extractor matches()', () => {
  it('weibo matches weibo.com and m.weibo.cn', () => {
    expect(weiboExtractor.matches('https://weibo.com/hot')).toBe(true);
    expect(weiboExtractor.matches('https://m.weibo.cn/detail/123')).toBe(true);
    expect(weiboExtractor.matches('https://example.com')).toBe(false);
  });

  it('instagram matches instagram.com', () => {
    expect(instagramExtractor.matches('https://www.instagram.com/p/AbC123/')).toBe(true);
    expect(instagramExtractor.matches('https://example.com')).toBe(false);
  });

  it('tiktok matches tiktok.com', () => {
    expect(tiktokExtractor.matches('https://www.tiktok.com/@user/video/123')).toBe(true);
    expect(tiktokExtractor.matches('https://example.com')).toBe(false);
  });

  it('rednote matches xiaohongshu.com', () => {
    expect(rednoteExtractor.matches('https://www.xiaohongshu.com/explore/abc')).toBe(true);
    expect(rednoteExtractor.matches('https://example.com')).toBe(false);
  });

  it('xianyu matches goofish.com', () => {
    expect(xianyuExtractor.matches('https://www.goofish.com/item?id=123')).toBe(true);
    expect(xianyuExtractor.matches('https://example.com')).toBe(false);
  });

  it('jd matches item.jd.com', () => {
    expect(jdExtractor.matches('https://item.jd.com/100012043978.html')).toBe(true);
    expect(jdExtractor.matches('https://example.com')).toBe(false);
  });

  it('taobao matches item.taobao.com', () => {
    expect(taobaoExtractor.matches('https://item.taobao.com/item.htm?id=123')).toBe(true);
    expect(taobaoExtractor.matches('https://example.com')).toBe(false);
  });

  it('ali1688 matches detail.1688.com', () => {
    expect(ali1688Extractor.matches('https://detail.1688.com/offer/123456.html')).toBe(true);
    expect(ali1688Extractor.matches('https://example.com')).toBe(false);
  });
});