import { describe, it, expect } from 'vitest'
import {
  wrapPastedContent,
  parseMessageContentWithPasted,
  hasPastedContentMarkers,
  stripPastedContentMarkers,
} from '../message-content-parser'

describe('message-content-parser', () => {
  describe('wrapPastedContent', () => {
    it('should wrap content with markers using the data-attribute format', () => {
      const result = wrapPastedContent('123', 'preview text', 'full content')
      expect(result.startsWith('<pasted-content id="123" data="')).toBe(true)
      expect(result.endsWith('"></pasted-content>')).toBe(true)
    })

    it('should preserve quotes in preview unchanged (no escape needed)', () => {
      const result = wrapPastedContent('123', 'preview "quoted" text', 'content')
      // Preview is base64-encoded inside `data=`, so it is no longer visible
      // verbatim in the marker.
      expect(result).not.toContain('preview="preview')
      expect(result).not.toContain('&quot;')
    })

    it('should handle empty content', () => {
      const result = wrapPastedContent('id', 'preview', '')
      expect(result.startsWith('<pasted-content id="id" data="')).toBe(true)
      expect(result.endsWith('"></pasted-content>')).toBe(true)
    })
  })

  describe('parseMessageContentWithPasted', () => {
    it('should return plain text when no markers', () => {
      const content = 'This is plain text'
      const result = parseMessageContentWithPasted(content)
      expect(result.text).toBe('This is plain text')
      expect(result.pastedContents).toHaveLength(0)
    })

    it('should parse single pasted content', () => {
      const content = wrapPastedContent('abc', 'code preview', 'console.log("hello")')
      const result = parseMessageContentWithPasted(content)

      expect(result.pastedContents).toHaveLength(1)
      expect(result.pastedContents[0]).toEqual({
        id: 'abc',
        preview: 'code preview',
        fullContent: 'console.log("hello")',
      })
    })

    it('should parse multiple pasted contents', () => {
      const content =
        'Before text ' +
        wrapPastedContent('1', 'first', 'content1') +
        ' middle ' +
        wrapPastedContent('2', 'second', 'content2') +
        ' after'

      const result = parseMessageContentWithPasted(content)

      expect(result.pastedContents).toHaveLength(2)
      expect(result.pastedContents[0].id).toBe('1')
      expect(result.pastedContents[1].id).toBe('2')
      expect(result.text).toContain('Before text')
      expect(result.text).toContain('middle')
      expect(result.text).toContain('after')
    })

    it('should preserve quotes in preview unchanged', () => {
      const content = wrapPastedContent('id', 'preview "quoted"', 'content')
      const result = parseMessageContentWithPasted(content)

      expect(result.pastedContents[0].preview).toBe('preview "quoted"')
    })

    it('should handle malformed markers gracefully', () => {
      const content = 'Text <pasted-content id="incomplete" data="'
      const result = parseMessageContentWithPasted(content)

      expect(result.text).toContain('Text')
      expect(result.pastedContents).toHaveLength(0)
    })

    it('should handle nested quotes in content', () => {
      const content = wrapPastedContent('id', 'preview', 'He said "Hello" and \'World\'')
      const result = parseMessageContentWithPasted(content)

      expect(result.pastedContents[0].fullContent).toBe('He said "Hello" and \'World\'')
    })

    it('should trim resulting text', () => {
      const content = '  ' + wrapPastedContent('id', 'preview', 'content') + '  '
      const result = parseMessageContentWithPasted(content)

      expect(result.text.charAt(0)).not.toBe(' ')
      expect(result.text.charAt(result.text.length - 1)).not.toBe(' ')
    })

    // Regression: pasted HTML/SVG/XML contains characters (`">`, `preview="`,
    // even literal `</pasted-content>`) that collide with the legacy
    // `preview="..."`+raw body marker format. Those would terminate the marker
    // prematurely and leak the entire payload into the surrounding text.
    it('should round-trip SVG path content that contains `">` and `d="..."`', () => {
      const svg =
        '<svg width="950" height="950" viewBox="136 -164 950 950">' +
        '<path d="M1040.13 259.141C1007.13 259.141 991.401 289.286 991.401 307.712C991.401 316.925 994.485 320.433 998.533 321.937C1004.66 324.365 1006.36 328.027 1006.36 334.773C1006.36 350.077 991.941 374.401 978.1 374.401C967.884 374.401 963.836 368.079 963.836 357.132"/>' +
        '</svg>'
      const content = wrapPastedContent('svg-id', svg.substring(0, 80) + '...', svg)
      const result = parseMessageContentWithPasted(content)

      expect(result.pastedContents).toHaveLength(1)
      expect(result.pastedContents[0].fullContent).toBe(svg)
      // The surrounding user-text area must NOT contain any of the SVG payload.
      expect(result.text).not.toContain('<path')
      expect(result.text).not.toContain('</svg>')
    })

    it('should round-trip content that literally contains </pasted-content>', () => {
      const tricky = 'function foo() { return "</pasted-content> literal string"; }'
      const content = wrapPastedContent('id', 'preview', tricky)
      const result = parseMessageContentWithPasted(content)

      expect(result.pastedContents).toHaveLength(1)
      expect(result.pastedContents[0].fullContent).toBe(tricky)
      expect(result.text).not.toContain('</pasted-content>')
    })

    it('should round-trip multi-line content with various XML delimiters', () => {
      const htmlLike = [
        '<div class="a">hello</div>',
        '<span data-x="1">x</span>',
        '<empty attr="value"/>',
      ].join('\n')
      const content = wrapPastedContent('id', 'preview', htmlLike)
      const result = parseMessageContentWithPasted(content)

      expect(result.pastedContents).toHaveLength(1)
      expect(result.pastedContents[0].fullContent).toBe(htmlLike)
      expect(result.text).not.toContain('<div')
      expect(result.text).not.toContain('<span')
    })

    it('should still parse legacy markers (no data attribute)', () => {
      const legacy =
        '<pasted-content id="legacy-id" preview="hello &quot;world&quot;">console.log(1)</pasted-content>'
      const result = parseMessageContentWithPasted(legacy)

      expect(result.pastedContents).toHaveLength(1)
      expect(result.pastedContents[0]).toEqual({
        id: 'legacy-id',
        preview: 'hello "world"',
        fullContent: 'console.log(1)',
      })
    })

    it('should preserve surrounding text when payload contains XML delimiters', () => {
      const svg = '<svg><path d="M0 0L10 10"/></svg>'
      const message = 'Look at this:\n' + wrapPastedContent('id', 'svg', svg) + '\nWhat do you think?'
      const result = parseMessageContentWithPasted(message)

      expect(result.pastedContents).toHaveLength(1)
      expect(result.pastedContents[0].fullContent).toBe(svg)
      // The two `\n` characters surrounding the marker remain in place.
      expect(result.text).toBe('Look at this:\n\nWhat do you think?')
      expect(result.text).not.toContain('<svg')
      expect(result.text).not.toContain('<path')
    })
  })

  describe('hasPastedContentMarkers', () => {
    it('should return true for content with markers', () => {
      const content = wrapPastedContent('id', 'preview', 'content')
      expect(hasPastedContentMarkers(content)).toBe(true)
    })

    it('should return false for plain text', () => {
      expect(hasPastedContentMarkers('plain text')).toBe(false)
    })

    it('should return false for partial marker', () => {
      expect(hasPastedContentMarkers('<pasted-content')).toBe(false)
    })

    it('should return true for multiple markers', () => {
      const content = wrapPastedContent('1', 'a', 'b') + wrapPastedContent('2', 'c', 'd')
      expect(hasPastedContentMarkers(content)).toBe(true)
    })

    it('should return false for arbitrary XML containing pasted-content-like text', () => {
      // Without `<pasted-content id="` prefix, hasPastedContentMarkers must
      // not be tricked into flagging content that merely mentions the term.
      expect(hasPastedContentMarkers('see </pasted-content> in the spec')).toBe(false)
    })
  })

  describe('stripPastedContentMarkers', () => {
    it('should return plain text unchanged', () => {
      const content = 'plain text'
      expect(stripPastedContentMarkers(content)).toBe('plain text')
    })

    it('should remove pasted content markers', () => {
      const content = 'Before ' + wrapPastedContent('id', 'preview', 'content') + ' After'
      const result = stripPastedContentMarkers(content)
      expect(result).toContain('Before')
      expect(result).toContain('After')
      expect(result).not.toContain('<pasted-content')
    })

    it('should remove markers and include pasted content', () => {
      const content =
        wrapPastedContent('1', 'a', 'b') +
        ' middle ' +
        wrapPastedContent('2', 'c', 'd')
      const result = stripPastedContentMarkers(content)
      expect(result).toContain('middle')
      expect(result).toContain('b')
      expect(result).toContain('d')
      expect(result).not.toContain('<pasted-content')
    })

    it('should round-trip SVG/HTML payload back into the stripped text', () => {
      const svg = '<svg><path d="M0 0L10 10"/></svg>'
      const content = 'Look:\n' + wrapPastedContent('id', 'svg', svg) + '\nEnd.'
      const stripped = stripPastedContentMarkers(content)

      expect(stripped).toContain('Look:')
      expect(stripped).toContain('End.')
      expect(stripped).toContain(svg)
      expect(stripped).not.toContain('<pasted-content')
    })
  })
})
