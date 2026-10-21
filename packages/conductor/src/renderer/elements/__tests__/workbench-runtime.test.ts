import { describe, expect, it } from 'vitest';
import {
  buildWorkbenchSrcdoc,
  WORKBENCH_ACTION_MESSAGE,
  WORKBENCH_DATA_MESSAGE,
} from '../workbench-runtime';

describe('buildWorkbenchSrcdoc', () => {
  it('injects the runtime and keeps sanitized markup', () => {
    const srcdoc = buildWorkbenchSrcdoc('<div class="widget-root"><h1>AAPL</h1></div>');
    expect(srcdoc).toContain('window.duya');
    expect(srcdoc).toContain('<h1>AAPL</h1>');
    expect(srcdoc).toContain(WORKBENCH_DATA_MESSAGE);
    expect(srcdoc).toContain(WORKBENCH_ACTION_MESSAGE);
    expect(srcdoc).toContain('connect-src \'none\'');
  });

  it('re-enables agent inline scripts after the runtime', () => {
    const source = [
      '<div id="px">?</div>',
      '<script>',
      "  window.duya.onData(function (data) { document.getElementById('px').textContent = data['src-1']; });",
      '</script>',
    ].join('\n');
    const srcdoc = buildWorkbenchSrcdoc(source);
    const runtimeIndex = srcdoc.indexOf('window.duya');
    const agentIndex = srcdoc.indexOf("data['src-1']");
    expect(runtimeIndex).toBeGreaterThan(-1);
    expect(agentIndex).toBeGreaterThan(runtimeIndex);
  });

  it('drops external script tags entirely', () => {
    const srcdoc = buildWorkbenchSrcdoc('<div>x</div><script src="https://cdn.example.com/x.js"></script>');
    expect(srcdoc).not.toContain('cdn.example.com/x.js"></script>');
    expect(srcdoc).not.toMatch(/<script[^>]*\ssrc=/i);
  });

  it('keeps data-duya-* button attributes intact', () => {
    const srcdoc = buildWorkbenchSrcdoc('<button data-duya-refresh="abc-123">Refresh</button>');
    expect(srcdoc).toContain('data-duya-refresh="abc-123"');
  });

  it('still strips eventing hazards from the static markup', () => {
    const srcdoc = buildWorkbenchSrcdoc(
      '<iframe src="https://evil.example"></iframe><a href="javascript:alert(1)">x</a>',
    );
    expect(srcdoc).not.toContain('<iframe');
    expect(srcdoc).not.toContain('javascript:');
  });

  it('seeds initial data when provided', () => {
    const srcdoc = buildWorkbenchSrcdoc('<div></div>', { snapshots: { s1: { price: 7 } } });
    expect(srcdoc).toContain('"price":7');
  });
});
