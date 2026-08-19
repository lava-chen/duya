import { describe, it, expect } from 'vitest';
import { ThinkTagParser } from '../src/utils/think-tag-parser.js';

describe('ThinkTagParser', () => {
  it('passes through text when no think tags', () => {
    const parser = new ThinkTagParser();
    const result = parser.feed('hello world');
    expect(result).toEqual({ thinking: '', text: 'hello world' });
  });

  it('separates think block from text', () => {
    const parser = new ThinkTagParser();
    const r1 = parser.feed('<think>reasoning here</think>');
    expect(r1).toEqual({ thinking: 'reasoning here', text: '' });
  });

  it('handles think block followed by text', () => {
    const parser = new ThinkTagParser();
    const r1 = parser.feed('<think>reasoning</think>answer');
    expect(r1).toEqual({ thinking: 'reasoning', text: 'answer' });
  });

  it('handles streaming chunks that split the think tag', () => {
    const parser = new ThinkTagParser();
    const r1 = parser.feed('<thi');
    expect(r1).toEqual({ thinking: '', text: '' });
    const r2 = parser.feed('nk>hello');
    expect(r2).toEqual({ thinking: 'hello', text: '' });
    const r3 = parser.feed('</think>world');
    expect(r3).toEqual({ thinking: '', text: 'world' });
  });

  it('handles streaming chunks that split the closing think tag', () => {
    const parser = new ThinkTagParser();
    parser.feed('<think>reasoning');
    const r2 = parser.feed('</thin');
    expect(r2).toEqual({ thinking: 'reasoning', text: '' });
    const r3 = parser.feed('k>done');
    expect(r3).toEqual({ thinking: '', text: 'done' });
  });

  it('handles text before think block', () => {
    const parser = new ThinkTagParser();
    const r = parser.feed('before<think>thinking</think>after');
    expect(r).toEqual({ thinking: 'thinking', text: 'beforeafter' });
  });

  it('handles multiple think blocks', () => {
    const parser = new ThinkTagParser();
    const r = parser.feed('<think>a</think>text1<think>b</think>text2');
    expect(r).toEqual({ thinking: 'ab', text: 'text1text2' });
  });

  it('separates namespaced mm:think block from text', () => {
    const parser = new ThinkTagParser();
    const r = parser.feed('<mm:think>reasoning here</mm:think>');
    expect(r).toEqual({ thinking: 'reasoning here', text: '' });
  });

  it('separates minimax:think and antml:think blocks', () => {
    const parser = new ThinkTagParser();
    const r1 = parser.feed('<minimax:think>a</minimax:think>');
    expect(r1).toEqual({ thinking: 'a', text: '' });
    const r2 = parser.feed('<antml:think>b</antml:think>');
    expect(r2).toEqual({ thinking: 'b', text: '' });
  });

  it('handles mismatched pair: <thinking> open with </mm:think> close', () => {
    // MiniMax-M3 opens with <thinking> but closes with the namespaced tag.
    const parser = new ThinkTagParser();
    const r = parser.feed('<thinking>reasoning</mm:think>answer');
    expect(r).toEqual({ thinking: 'reasoning', text: 'answer' });
  });

  it('drops a stray namespaced closing tag in text mode', () => {
    // MiniMax-M3 leaks a bare </mm:think> into the text stream.
    const parser = new ThinkTagParser();
    const r = parser.feed('before</mm:think>after');
    expect(r).toEqual({ thinking: '', text: 'beforeafter' });
  });

  it('handles streaming chunks that split the namespaced closing tag', () => {
    const parser = new ThinkTagParser();
    parser.feed('<mm:think>reasoning');
    const r2 = parser.feed('</mm:thi');
    expect(r2).toEqual({ thinking: 'reasoning', text: '' });
    const r3 = parser.feed('nk>done');
    expect(r3).toEqual({ thinking: '', text: 'done' });
  });

  it('buffers partial opening tag at end of stream', () => {
    const parser = new ThinkTagParser();
    parser.feed('hello <thi');
    const r = parser.flush();
    // The partial '<thi' should be flushed as text
    expect(r.text).toContain('<thi');
  });

  it('flush returns remaining buffer as text when in text mode', () => {
    const parser = new ThinkTagParser();
    parser.feed('hello world');
    const r = parser.flush();
    expect(r).toEqual({ thinking: '', text: '' });
  });

  it('flush returns remaining buffer as thinking when in think mode', () => {
    const parser = new ThinkTagParser();
    parser.feed('<think>unfinished thinking');
    const r = parser.flush();
    expect(r).toEqual({ thinking: 'unfinished thinking', text: '' });
  });
});
