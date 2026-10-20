import { describe, it, expect } from 'vitest'
import { wrapPastedContent } from '../message-content-parser'
import { decodeMessageAttachments } from '../decode-message-attachments'

describe('decode-message-attachments (Plan 220 legacy adapter)', () => {
  describe('passthrough behavior', () => {
    it('returns content unchanged when no markers are present', () => {
      const result = decodeMessageAttachments('Hello world', [])
      expect(result.text).toBe('Hello world')
      expect(result.attachments).toEqual([])
    })

    it('preserves the input attachments array when no markers are present', () => {
      const att = {
        id: 'a1',
        kind: 'file' as const,
        name: 'doc.pdf',
        type: 'application/pdf',
        url: '/abs/doc.pdf',
        size: 1024,
      }
      const result = decodeMessageAttachments('Hello world', [att])
      expect(result.text).toBe('Hello world')
      expect(result.attachments).toHaveLength(1)
      expect(result.attachments[0]).toEqual(att)
    })

    it('handles a null/undefined input attachments array', () => {
      const result = decodeMessageAttachments('Hello', null)
      expect(result.attachments).toEqual([])
    })
  })

  describe('legacy pasted-content marker', () => {
    it('synthesizes a pasted-text attachment and strips the marker', () => {
      const content = 'Before ' + wrapPastedContent('p1', 'preview text', 'full body') + ' After'
      const result = decodeMessageAttachments(content, [])

      expect(result.text).toContain('Before')
      expect(result.text).toContain('After')
      expect(result.text).not.toContain('<pasted-content')
      expect(result.attachments).toHaveLength(1)
      expect(result.attachments[0]).toMatchObject({
        kind: 'pasted-text',
        id: 'p1',
        previewText: 'preview text',
      })
      // text field carries the full body so the model can see it.
      expect(result.attachments[0].text).toBe('full body')
    })

    it('preserves existing attachments and appends the synthesized one', () => {
      const existing = {
        id: 'f1',
        kind: 'image' as const,
        name: 'shot.png',
        type: 'image/png',
        url: 'data:image/png;base64,XXX',
        size: 3,
      }
      const content = wrapPastedContent('p1', 'preview', 'body')
      const result = decodeMessageAttachments(content, [existing])

      expect(result.attachments).toHaveLength(2)
      expect(result.attachments.map((a) => a.id)).toEqual(['f1', 'p1'])
    })
  })

  describe('legacy browser-ref marker', () => {
    it('synthesizes a browser-ref attachment and strips the marker', () => {
      const ref = {
        kind: 'element' as const,
        label: 'Submit',
        title: 'Form Page',
        url: 'https://example.com',
        content: 'Browser element reference:\n- Selector: button',
      }
      const encoded = encodeURIComponent(JSON.stringify(ref))
      const content = `Before [[duya-browser-ref:${encoded}]] After`
      const result = decodeMessageAttachments(content, [])

      expect(result.text).toContain('Before')
      expect(result.text).toContain('After')
      expect(result.text).not.toContain('[[duya-browser-ref:')
      expect(result.attachments).toHaveLength(1)
      expect(result.attachments[0]).toMatchObject({
        kind: 'browser-ref',
        previewText: 'Form Page',
      })
    })
  })
})