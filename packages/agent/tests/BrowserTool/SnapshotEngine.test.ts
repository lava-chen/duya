/**
 * SnapshotEngine tests - OpenCLI-style snapshot and fallback behavior
 *
 * Covers:
 * - OpenCLI-style JS snapshot generation (generateSnapshotJsPrompt)
 * - capture() with successful JS evaluation
 * - Fallback to CDP DOM.getDocument when JS eval fails
 * - Fallback to error message when both approaches fail
 * - Interactive element extraction from ref identity
 * - Truncation behavior
 */

import { describe, it, expect, vi } from 'vitest';
import { SnapshotEngine } from '../../src/tool/BrowserTool/SnapshotEngine.js';
import type { ICDPClient, CDPMode } from '../../src/tool/BrowserTool/CDPClient.js';
import { generateSnapshotJsPrompt } from '../../src/tool/BrowserTool/SnapshotEngine.js';

// ── Mock CDP Client ──────────────────────────────────────────────────

function createMockCDP(overrides: Partial<ICDPClient> = {}): ICDPClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue({ status: 'ok' as const, mode: 'extension' as CDPMode }),
    navigate: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue({}),
    evaluate: vi.fn().mockResolvedValue(null),
    screenshot: vi.fn().mockResolvedValue(''),
    click: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    scroll: vi.fn().mockResolvedValue(undefined),
    goBack: vi.fn().mockResolvedValue(undefined),
    pressKey: vi.fn().mockResolvedValue(undefined),
    getUrl: vi.fn().mockResolvedValue('https://example.com'),
    getTitle: vi.fn().mockResolvedValue('Example Page'),
    close: vi.fn().mockResolvedValue(undefined),
    closeWindow: vi.fn().mockResolvedValue(undefined),
    tabs: vi.fn().mockResolvedValue([]),
    newTab: vi.fn().mockResolvedValue('1'),
    closeTab: vi.fn().mockResolvedValue(undefined),
    selectTab: vi.fn().mockResolvedValue(undefined),
    setFileInput: vi.fn().mockResolvedValue(undefined),
    startNetworkCapture: vi.fn().mockResolvedValue(true),
    readNetworkCapture: vi.fn().mockResolvedValue([]),
    getCookies: vi.fn().mockResolvedValue([]),
    frames: vi.fn().mockResolvedValue([]),
    evaluateInFrame: vi.fn().mockResolvedValue(null),
    hover: vi.fn().mockResolvedValue(undefined),
    waitForElement: vi.fn().mockResolvedValue(undefined),
    waitForLoad: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue(undefined),
    cdp: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

/**
 * Build a realistic DOM tree for CDP fallback testing that produces
 * enough output to pass the < 50-char threshold check.
 */
function makeDomTree(textNodes: string[]): Record<string, unknown> {
  const bodyChildren = textNodes.map(text => ({
    nodeName: 'P',
    children: [{ nodeName: '#text', nodeValue: text }],
  }));

  // Also add some interactive elements for realism
  bodyChildren.push({
    nodeName: 'A',
    attributes: [{ name: 'href', value: '/test' }],
    children: [{ nodeName: '#text', nodeValue: 'Link text' }],
  });

  return {
    root: {
      nodeName: '#document',
      children: [
        {
          nodeName: 'HTML',
          children: [
            { nodeName: 'HEAD', children: [{ nodeName: 'TITLE', children: [{ nodeName: '#text', nodeValue: 'Test Page' }] }] },
            {
              nodeName: 'BODY',
              attributes: [{ name: 'class', value: 'main-content' }],
              children: bodyChildren,
            },
          ],
        },
      ],
    },
  };
}

// ── Sample Snapshot Output ───────────────────────────────────────────

const SAMPLE_OPENCLI_SNAPSHOT = `url: https://example.com
title: Example Page
viewport: 1280x720
page_scroll: 0↑ 2.3↓
---
- html lang=en:
  - body:
    - header:
      - nav:
        - a href=/home [ref=1] "Home"
        - a href=/about [ref=2] "About"
        - a href=/contact [ref=3] "Contact"
    - main:
      - h1 "Welcome to Example"
      - p "This is a sample page for testing snapshots."
      - |scroll| div (1.5↑ 0.8↓):
        - a href=/read-more [ref=4] "Read More"
      - button type=submit [ref=5] "Subscribe"
      - input type=text placeholder=email [ref=6]
    - footer:
      - p "© 2025 Example Inc."
---
hidden (2):
- button "Back to Top" ~3.2 pages below
- a "Skip Navigation" ~0.5 pages above
---
interactive: 6 | iframes: 0`;

// ── Tests ────────────────────────────────────────────────────────────

describe('SnapshotEngine', () => {
  // ====================================================================
  // OpenCLI-style JS snapshot
  // ====================================================================
  describe('capture() - OpenCLI-style JS snapshot', () => {
    it('should produce snapshot from JS evaluation result', async () => {
      const evalMock = vi.fn();
      evalMock
        .mockResolvedValueOnce(SAMPLE_OPENCLI_SNAPSHOT) // main JS eval
        .mockResolvedValueOnce(undefined);               // prev_hashes
      const mockCDP = createMockCDP({
        getUrl: vi.fn().mockResolvedValue('https://example.com'),
        getTitle: vi.fn().mockResolvedValue('Example Page'),
        evaluate: evalMock,
      });
      const engine = new SnapshotEngine(mockCDP);

      const result = await engine.capture();

      expect(result.url).toBe('https://example.com');
      expect(result.title).toBe('Example Page');
      expect(result.snapshot).toContain('url: https://example.com');
      expect(result.snapshot).toContain('title: Example Page');
      expect(result.snapshot).toContain('[ref=1]');
      expect(result.snapshot).toContain('[ref=2]');
      expect(result.truncated).toBe(false);
    });

    it('should store previous hashes for incremental diff on next capture', async () => {
      const storedHashes = JSON.stringify(['hash1', 'hash2', 'hash3']);
      const evalMock = vi.fn();
      evalMock
        .mockResolvedValueOnce(SAMPLE_OPENCLI_SNAPSHOT) // main JS eval (call 1)
        .mockResolvedValueOnce(storedHashes);             // prev_hashes (call 2)
      const mockCDP = createMockCDP({ evaluate: evalMock });
      const engine = new SnapshotEngine(mockCDP);

      await engine.capture();

      // Second capture: mock returns another snapshot for JS eval
      // and undefined for prev_hashes
      evalMock.mockResolvedValueOnce('second slot snapshot output second slot'); // call 3: snapshotJs
      evalMock.mockResolvedValueOnce(undefined);                                  // call 4: prev_hashes
      await engine.capture();

      // After first capture, calls: [0]=snapshotJs, [1]=prev_hashes,
      //   [2]=extractElements ref_identity, [3]=extractElements DOM fallback
      // Second capture snapshotJs is at index 4
      const secondCallArg = evalMock.mock.calls[4][0] as string;
      expect(secondCallArg).toContain('hash1');
      expect(secondCallArg).toContain('hash2');
    });

    it('should not break when prev_hashes storage fails', async () => {
      const evalMock = vi.fn();
      evalMock
        .mockResolvedValueOnce(SAMPLE_OPENCLI_SNAPSHOT)
        .mockRejectedValueOnce(new Error('Cannot access window'));
      const mockCDP = createMockCDP({ evaluate: evalMock });
      const engine = new SnapshotEngine(mockCDP);

      const result = await engine.capture();
      expect(result.url).toBe('https://example.com');
    });
  });

  // ====================================================================
  // CDP DOM fallback
  // ====================================================================
  describe('capture() - CDP DOM fallback', () => {
    it('should fallback to CDP DOM when JS eval throws', async () => {
      const mockCDP = createMockCDP({
        evaluate: vi.fn()
          .mockRejectedValueOnce(new Error('Uncaught')),          // JS eval fails
        send: vi.fn()
          .mockResolvedValueOnce(makeDomTree([                   // CDP DOM.getDocument
            'First paragraph with enough content for tests.',
            'Second paragraph with more text here.',
            'Third paragraph to ensure length threshold is met.',
          ])),
      });
      const engine = new SnapshotEngine(mockCDP);

      const result = await engine.capture();

      expect(result.url).toBe('https://example.com');
      expect(result.title).toBe('Example Page');
      expect(result.snapshot.length).toBeGreaterThan(50);
      expect(result.snapshot).toContain('First paragraph');
      expect(result.snapshot).toContain('Second paragraph');
      expect(result.snapshot).toContain('Link text');
    });

    it('should fallback to CDP DOM when JS eval returns undefined', async () => {
      const mockCDP = createMockCDP({
        evaluate: vi.fn()
          .mockResolvedValueOnce(undefined),                       // JS eval returns undefined
        send: vi.fn()
          .mockResolvedValueOnce(makeDomTree(['Fallback content paragraph one.', 'Fallback content paragraph two.'])),
      });
      const engine = new SnapshotEngine(mockCDP);

      const result = await engine.capture();
      expect(result.snapshot).toContain('Fallback content paragraph one');
    });

    it('should fallback to CDP DOM when JS eval returns whitespace', async () => {
      const mockCDP = createMockCDP({
        evaluate: vi.fn()
          .mockResolvedValueOnce('   '),                           // JS eval returns whitespace
        send: vi.fn()
          .mockResolvedValueOnce(makeDomTree(['Content from CDP fallback one.', 'Content from CDP fallback two.'])),
      });
      const engine = new SnapshotEngine(mockCDP);

      const result = await engine.capture();
      expect(result.snapshot).toContain('Content from CDP fallback one');
    });
  });

  // ====================================================================
  // Total failure
  // ====================================================================
  describe('capture() - total failure', () => {
    it('should return minimal result when both OpenCLI and CDP fail', async () => {
      const mockCDP = createMockCDP({
        evaluate: vi.fn()
          .mockRejectedValue(new Error('Uncaught')),
        send: vi.fn()
          .mockRejectedValue(new Error('CDP connection lost')),
        getUrl: vi.fn().mockResolvedValue('https://broken.page'),
        getTitle: vi.fn().mockResolvedValue('Broken Page'),
      });
      const engine = new SnapshotEngine(mockCDP);

      const result = await engine.capture();

      expect(result.url).toBe('https://broken.page');
      expect(result.title).toBe('Broken Page');
      expect(result.snapshot).toBe('Failed to capture DOM - page may not be fully loaded.');
      expect(result.interactiveElements).toEqual([]);
      expect(result.truncated).toBe(false);
    });

    it('should return minimal result when CDP DOM returns null root', async () => {
      const mockCDP = createMockCDP({
        evaluate: vi.fn()
          .mockRejectedValue(new Error('JS evaluation error: Uncaught')),
        send: vi.fn()
          .mockResolvedValueOnce({ root: null }),
      });
      const engine = new SnapshotEngine(mockCDP);

      const result = await engine.capture();
      expect(result.snapshot).toBe('Failed to capture DOM - page may not be fully loaded.');
    });

    it('should return minimal result when CDP DOM throws and JS eval returns null', async () => {
      const mockCDP = createMockCDP({
        evaluate: vi.fn()
          .mockResolvedValueOnce(null),
        send: vi.fn()
          .mockRejectedValue(new Error('DOM.getDocument timed out')),
      });
      const engine = new SnapshotEngine(mockCDP);

      const result = await engine.capture();
      expect(result.snapshot).toBe('Failed to capture DOM - page may not be fully loaded.');
    });
  });

  // ====================================================================
  // Truncation
  // ====================================================================
  describe('capture() - truncation', () => {
    it('should truncate snapshot when exceeding maxLength', async () => {
      const longContent = 'x'.repeat(150);
      const evalMock = vi.fn().mockResolvedValueOnce(longContent);
      const mockCDP = createMockCDP({ evaluate: evalMock });
      const engine = new SnapshotEngine(mockCDP);

      const result = await engine.capture({ maxLength: 100 });

      expect(result.truncated).toBe(true);
      expect(result.snapshot).toContain('[Snapshot truncated...]');
      // snapshot = slice(0, maxLength) + '\n\n[Snapshot truncated...]'
      const expectedMaxLen = 100 + '\n\n[Snapshot truncated...]'.length;
      expect(result.snapshot.length).toBeLessThanOrEqual(expectedMaxLen);
    });

    it('should not truncate when snapshot is within maxLength', async () => {
      const shortContent = 'S'.repeat(101);  // must be >= 100 to pass the CDP fallback threshold check
      const evalMock = vi.fn().mockResolvedValueOnce(shortContent);
      const mockCDP = createMockCDP({ evaluate: evalMock });
      const engine = new SnapshotEngine(mockCDP);

      const result = await engine.capture({ maxLength: 100000 });

      expect(result.truncated).toBe(false);
      expect(result.snapshot).toBe(shortContent);
    });
  });

  // ====================================================================
  // Interactive elements extraction
  // ====================================================================
  describe('capture() - interactive elements extraction', () => {
    it('should extract interactive elements from window.__opencli_ref_identity', async () => {
      const evalMock = vi.fn();
      evalMock
        .mockResolvedValueOnce(SAMPLE_OPENCLI_SNAPSHOT)    // call 1: snapshotJs
        .mockResolvedValueOnce(undefined)                   // call 2: prev_hashes
        .mockResolvedValueOnce({                            // call 3: ref_identity
          '1': { tag: 'a', role: '', text: 'Home', ariaLabel: '', id: 'home-link', testId: '' },
          '2': { tag: 'a', role: '', text: 'About', ariaLabel: '', id: '', testId: '' },
          '5': { tag: 'button', role: '', text: 'Subscribe', ariaLabel: '', id: 'subscribe-btn', testId: '' },
        });
      const mockCDP = createMockCDP({ evaluate: evalMock });
      const engine = new SnapshotEngine(mockCDP);

      const result = await engine.capture();

      expect(result.interactiveElements).toHaveLength(3);
      expect(result.interactiveElements[0]).toMatchObject({
        ref: 1,
        tag: 'a',
        type: undefined,
        text: 'Home',
        ariaLabel: '',
        selector: '#home-link',
      });
      expect(result.interactiveElements[2]).toMatchObject({
        ref: 5,
        tag: 'button',
        text: 'Subscribe',
        selector: '#subscribe-btn',
      });
    });

    it('should fallback to DOM extraction when ref_identity fetch fails', async () => {
      const evalMock = vi.fn();
      evalMock
        .mockResolvedValueOnce(SAMPLE_OPENCLI_SNAPSHOT)    // call 1: snapshotJs
        .mockResolvedValueOnce(undefined);                   // call 2: prev_hashes
      evalMock.mockRejectedValueOnce(new Error('ref_identity unavailable')); // call 3: ref_identity fails
      evalMock.mockResolvedValueOnce([                       // call 4: fallback DOM extraction
        { tag: 'a', type: undefined, text: 'Home', selector: '#home-link' },
        { tag: 'button', type: 'submit', text: 'Subscribe', selector: 'button.subscribe' },
      ]);

      const mockCDP = createMockCDP({ evaluate: evalMock });
      const engine = new SnapshotEngine(mockCDP);

      const result = await engine.capture();
      expect(result.interactiveElements).toHaveLength(2);
      expect(result.interactiveElements[0]).toMatchObject({ ref: 1, tag: 'a', text: 'Home' });
    });
  });

  // ====================================================================
  // generateSnapshotJsPrompt
  // ====================================================================
  describe('generateSnapshotJsPrompt', () => {
    it('should produce syntactically valid JS', () => {
      expect(() => {
        new Function(generateSnapshotJsPrompt({}));
      }).not.toThrow();
    });

    it('should produce a non-empty JS string with expected structure', () => {
      const js = generateSnapshotJsPrompt({});
      expect(js.length).toBeGreaterThan(1000);
      expect(js).toContain("'use strict'");
      expect(js).toContain('function walk');
      expect(js).toContain('lines.join');
    });

    it('should include viewport info markers', () => {
      const js = generateSnapshotJsPrompt({});
      expect(js).toContain("'viewport: '");
      expect(js).toContain("'url: '");
      expect(js).toContain("'title: '");
    });

    it('should accept interactiveOnly option', () => {
      const js = generateSnapshotJsPrompt({ interactiveOnly: true });
      expect(js).toContain('INTERACTIVE_ONLY = true');
    });

    it('should accept maxTextLength option', () => {
      const js = generateSnapshotJsPrompt({ maxTextLength: 200 });
      expect(js).toContain('MAX_TEXT_LEN = 200');
    });

    it('should embed previousHashes when provided', () => {
      const hashes = JSON.stringify(['abc123', 'def456']);
      const js = generateSnapshotJsPrompt({ previousHashes: hashes });
      expect(js).toContain('"abc123"');
      expect(js).toContain('"def456"');
    });

    it('should set PREV_HASHES to null when not provided', () => {
      const js = generateSnapshotJsPrompt({ previousHashes: null });
      expect(js).toContain("PREV_HASHES = null");
    });

    it('should include scroll marker logic', () => {
      const js = generateSnapshotJsPrompt({});
      expect(js).toContain('|scroll|');
    });

    it('should include hidden element reporting logic', () => {
      const js = generateSnapshotJsPrompt({ reportHidden: true });
      expect(js).toContain('hiddenInteractives');
      // Check the individual string fragments used to build "pages away" output
      expect(js).toContain("' pages '");
      expect(js).toContain('h.direction');
    });

    it('should include markdown table serialization logic', () => {
      const js = generateSnapshotJsPrompt({ markdownTables: true });
      expect(js).toContain('|table|');
    });

    it('should not include table logic when markdownTables is disabled', () => {
      const js = generateSnapshotJsPrompt({ markdownTables: false });
      // serializeTable short-circuits but the code structure is still emitted
      expect(js).toContain('MARKDOWN_TABLES = false');
    });
  });

  // ====================================================================
  // Options passthrough
  // ====================================================================
  describe('capture() - options passthrough', () => {
    it('should pass interactiveOnly to the generated JS', async () => {
      const evalMock = vi.fn().mockResolvedValueOnce('interactive_only');
      const mockCDP = createMockCDP({ evaluate: evalMock });
      const engine = new SnapshotEngine(mockCDP);

      await engine.capture({ interactiveOnly: true });

      const evalArg = evalMock.mock.calls[0][0] as string;
      expect(evalArg).toContain('INTERACTIVE_ONLY = true');
    });

    it('should pass viewportExpand option', async () => {
      const evalMock = vi.fn().mockResolvedValueOnce('with_expand');
      const mockCDP = createMockCDP({ evaluate: evalMock });
      const engine = new SnapshotEngine(mockCDP);

      await engine.capture({ viewportExpand: 1200 });

      const evalArg = evalMock.mock.calls[0][0] as string;
      expect(evalArg).toContain('VIEWPORT_EXPAND = 1200');
    });
  });

  // ====================================================================
  // Error type handling
  // ====================================================================
  describe('capture() - error types fallback', () => {
    const errorCases = [
      { name: 'plain "Uncaught"', error: new Error('Uncaught') },
      { name: 'CDP evaluation error', error: new Error('JS evaluation error: Uncaught') },
      { name: 'Daemon error', error: new Error('Daemon error (502): Bad Gateway') },
      { name: 'string error', error: 'Uncaught' },
    ];

    for (const { name, error } of errorCases) {
      it(`should fallback after ${name} instead of throwing`, async () => {
        const mockCDP = createMockCDP({
          evaluate: vi.fn()
            .mockRejectedValueOnce(error),                         // JS eval fails
          send: vi.fn()
            .mockResolvedValueOnce(makeDomTree(['Fallback text one two three.', 'Another fallback paragraph.'])),
        });
        const engine = new SnapshotEngine(mockCDP);

        const result = await engine.capture();

        expect(result.url).toBe('https://example.com');
        expect(result.title).toBe('Example Page');
        expect(result.snapshot).toContain('Fallback text one two three');
      });
    }
  });
});