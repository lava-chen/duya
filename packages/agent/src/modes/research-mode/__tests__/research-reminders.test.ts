/**
 * Research continuation reminders tests (plan 423 Phase 2).
 */

import { describe, it, expect } from 'vitest';
import { ResearchTracker } from '../research-tracker.js';
import {
  renderResearchState,
  renderResearchContinuation,
  RESEARCH_CONTINUATION_SENTINEL,
} from '../research-reminders.js';

describe('renderResearchState', () => {
  it('renders the <research-state> block with query/state/sources', () => {
    const t = new ResearchTracker();
    t.transition({ type: 'start', query: 'RAG benchmarks' });
    t.addSubQuestion('What retrieval methods dominate?');
    t.addSource('https://example.com/rag');
    const html = renderResearchState(t);
    expect(html).toContain('<research-state>');
    expect(html).toContain('Query: RAG benchmarks');
    expect(html).toContain('State: clarifying');
    expect(html).toContain('Sources: 1');
    expect(html).toContain('Sub-questions: What retrieval methods dominate?');
    expect(html).toContain('</research-state>');
  });

  it('omits empty sub-questions / gaps', () => {
    const t = new ResearchTracker();
    t.transition({ type: 'start', query: 'X' });
    const html = renderResearchState(t);
    expect(html).not.toContain('Sub-questions:');
    expect(html).not.toContain('Coverage gaps:');
  });

  it('includes coverage gaps when present', () => {
    const t = new ResearchTracker();
    t.transition({ type: 'start', query: 'X' });
    t.addGap('missing cost comparisons');
    expect(renderResearchState(t)).toContain('Coverage gaps: missing cost comparisons');
  });
});

describe('renderResearchContinuation', () => {
  it('renders the sentinel and state-specific guidance', () => {
    const t = new ResearchTracker();
    t.transition({ type: 'start', query: 'X' });
    t.transition({ type: 'search' });
    const html = renderResearchContinuation(t);
    expect(html).toContain(RESEARCH_CONTINUATION_SENTINEL);
    expect(html.toLowerCase()).toContain('searching');
  });

  it('guides synthesizing to call research_report', () => {
    const t = new ResearchTracker();
    t.transition({ type: 'start', query: 'X' });
    t.transition({ type: 'search' });
    t.transition({ type: 'synthesize' });
    expect(renderResearchContinuation(t).toLowerCase()).toContain('research_report');
  });
});