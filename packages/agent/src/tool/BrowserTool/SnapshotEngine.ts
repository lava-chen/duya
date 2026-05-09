/**
 * SnapshotEngine - DOM snapshot generation for LLM consumption
 * Inspired by OpenCLI's 13-layer pruning pipeline
 * Generates token-efficient, LLM-friendly page representation
 */

import type { ICDPClient } from './CDPClient.js';

export interface SnapshotOptions {
  maxLength?: number;
  includeImages?: boolean;
  includeHidden?: boolean;
  interactiveOnly?: boolean;
}

export interface SnapshotResult {
  url: string;
  title: string;
  snapshot: string;
  interactiveElements: InteractiveElement[];
  truncated: boolean;
}

export interface InteractiveElement {
  ref: number;
  tag: string;
  type?: string;
  text: string;
  selector: string;
  bounds?: { x: number; y: number; width: number; height: number };
}

/**
 * Generate DOM snapshot optimized for LLM consumption
 */
export class SnapshotEngine {
  private cdp: ICDPClient;
  private refCounter = 0;
  private refMap = new Map<number, string>();

  constructor(cdp: ICDPClient) {
    this.cdp = cdp;
  }

  /**
   * Capture full page snapshot
   */
  async capture(options: SnapshotOptions = {}): Promise<SnapshotResult> {
    const {
      maxLength = 100000,
      includeImages = false,
      includeHidden = false,
      interactiveOnly = false,
    } = options;

    const url = await this.cdp.getUrl();
    const title = await this.cdp.getTitle();

    // Try multiple approaches to get page content
    let snapshot: string | null = null;
    let interactiveElements: InteractiveElement[] = [];

    // Approach 1: Try CDP DOM.getDocument with retries
    try {
      const domResult = await this.getDOMWithRetry();
      if (domResult?.root) {
        this.refCounter = 0;
        this.refMap.clear();
        interactiveElements = [];
        snapshot = this.buildSnapshot(domResult.root, {
          includeImages,
          includeHidden,
          interactiveOnly,
          interactiveElements,
          depth: 0,
        });
      }
    } catch (error) {
      console.warn('[SnapshotEngine] DOM.getDocument failed:', error instanceof Error ? error.message : error);
    }

    // Approach 2: Fallback to JavaScript evaluation for dynamic/SPA pages
    if (!snapshot || snapshot.trim().length < 100) {
      try {
        const jsSnapshot = await this.captureViaJavaScript();
        if (jsSnapshot && jsSnapshot.length > 100) {
          snapshot = jsSnapshot;
          // Build interactive elements from JS evaluation
          interactiveElements = await this.extractInteractiveElements();
        }
      } catch (error) {
        console.warn('[SnapshotEngine] JavaScript fallback failed:', error instanceof Error ? error.message : error);
      }
    }

    // If all approaches failed, return error message
    if (!snapshot || snapshot.trim().length < 50) {
      return {
        url,
        title,
        snapshot: 'Failed to capture DOM - page may not be fully loaded or is using complex JavaScript rendering. Try waiting a moment and retrying.',
        interactiveElements: [],
        truncated: false,
      };
    }

    // Truncate if needed
    let finalSnapshot = snapshot;
    let truncated = false;
    if (snapshot.length > maxLength) {
      finalSnapshot = snapshot.slice(0, maxLength) + '\n\n[Snapshot truncated...]';
      truncated = true;
    }

    return {
      url,
      title,
      snapshot: finalSnapshot,
      interactiveElements,
      truncated,
    };
  }

  /**
   * Get DOM with retry logic for reliability
   */
  private async getDOMWithRetry(maxRetries = 3): Promise<{ root?: DOMNode } | null> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Try with depth parameter first
        try {
          const result = await this.cdp.send('DOM.getDocument', {
            depth: -1,
            pierce: true,
          }) as { root?: DOMNode };
          if (result?.root) return result;
        } catch {
          // Fallback: try without depth parameter
          const result = await this.cdp.send('DOM.getDocument', {}) as { root?: DOMNode };
          if (result?.root) return result;
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < maxRetries) {
          // Wait before retry with exponential backoff
          await new Promise(resolve => setTimeout(resolve, 500 * attempt));
        }
      }
    }

    if (lastError) throw lastError;
    return null;
  }

  /**
   * Capture snapshot via JavaScript evaluation (fallback for dynamic pages)
   */
  private async captureViaJavaScript(): Promise<string> {
    const script = `
      (function() {
        function getVisibleText(element, depth = 0) {
          if (depth > 50) return ''; // Prevent infinite recursion
          
          const tag = element.tagName?.toLowerCase() || '';
          
          // Skip script, style, and hidden elements
          if (['script', 'style', 'noscript', 'template'].includes(tag)) return '';
          
          const style = window.getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden') return '';
          
          let result = '';
          
          // Handle interactive elements
          const interactiveTags = ['a', 'button', 'input', 'select', 'textarea'];
          const isInteractive = interactiveTags.includes(tag) || 
                               element.getAttribute('role') === 'button' ||
                               element.getAttribute('role') === 'link' ||
                               element.onclick ||
                               (element.tabIndex && element.tabIndex >= 0);
          
          if (isInteractive) {
            const text = element.textContent?.trim().slice(0, 100) || '';
            const href = element.href ? ' href="' + element.href.slice(0, 100) + '"' : '';
            const inputType = element.type ? ' type="' + element.type + '"' : '';
            const placeholder = element.placeholder ? ' placeholder="' + element.placeholder.slice(0, 50) + '"' : '';
            result += '<' + tag + href + inputType + placeholder + '>[' + text + ']</' + tag + '>\\n';
          } else if (tag === 'img') {
            const alt = element.alt ? ' alt="' + element.alt.slice(0, 50) + '"' : '';
            result += '<img' + alt + ' />\\n';
          } else {
            // Process children
            const children = element.children;
            let childContent = '';
            for (let i = 0; i < children.length; i++) {
              childContent += getVisibleText(children[i], depth + 1);
            }
            
            // Get direct text content
            let directText = '';
            for (let i = 0; i < element.childNodes.length; i++) {
              const node = element.childNodes[i];
              if (node.nodeType === Node.TEXT_NODE) {
                directText += node.textContent;
              }
            }
            directText = directText.trim();
            
            // Only include container if it has content
            if (childContent || directText) {
              if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'td', 'th'].includes(tag)) {
                const text = directText || childContent.trim();
                result += '<' + tag + '>' + text.slice(0, 200) + '</' + tag + '>\\n';
              } else if (childContent) {
                result += childContent;
              } else if (directText) {
                result += directText.slice(0, 200) + '\\n';
              }
            }
          }
          
          return result;
        }
        
        // Get title
        const title = document.title || 'Untitled';
        let output = 'Title: ' + title + '\\n\\n';
        
        // Get body content
        if (document.body) {
          output += getVisibleText(document.body);
        }
        
        return output;
      })()
    `;

    const result = await this.cdp.evaluate(script);
    return String(result || '');
  }

  /**
   * Extract interactive elements via JavaScript
   */
  private async extractInteractiveElements(): Promise<InteractiveElement[]> {
    const script = `
      (function() {
        const elements = [];
        const interactiveTags = ['a', 'button', 'input', 'select', 'textarea'];
        const allElements = document.querySelectorAll('*');
        
        for (let i = 0; i < allElements.length; i++) {
          const el = allElements[i];
          const tag = el.tagName.toLowerCase();
          
          const isInteractive = interactiveTags.includes(tag) || 
                               el.getAttribute('role') === 'button' ||
                               el.getAttribute('role') === 'link' ||
                               el.onclick ||
                               (el.tabIndex && el.tabIndex >= 0);
          
          if (isInteractive) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              elements.push({
                tag: tag,
                type: el.type || undefined,
                text: (el.textContent?.trim() || el.value?.trim() || el.placeholder || '').slice(0, 100),
                selector: el.id ? '#' + el.id : 
                         (el.className ? tag + '.' + el.className.split(' ')[0] : tag)
              });
            }
          }
        }
        
        return elements.slice(0, 50); // Limit to first 50 interactive elements
      })()
    `;

    try {
      const result = await this.cdp.evaluate(script);
      if (Array.isArray(result)) {
        return result.map((el, index) => ({
          ref: index + 1,
          tag: el.tag || 'unknown',
          type: el.type,
          text: el.text || '',
          selector: el.selector || '',
        }));
      }
    } catch {
      // Ignore errors, return empty array
    }
    return [];
  }

  /**
   * Build snapshot string from DOM node
   */
  private buildSnapshot(
    node: DOMNode,
    options: {
      includeImages: boolean;
      includeHidden: boolean;
      interactiveOnly: boolean;
      interactiveElements: InteractiveElement[];
      depth: number;
    }
  ): string {
    const { includeImages, includeHidden, interactiveOnly, interactiveElements, depth } = options;

    // Skip invisible elements unless includeHidden
    if (!includeHidden && this.isHidden(node)) {
      return '';
    }

    // Skip script/style/comment nodes
    if (['SCRIPT', 'STYLE', 'COMMENT', '#comment'].includes(node.nodeName)) {
      return '';
    }

    const indent = '  '.repeat(depth);
    let result = '';

    // Text node
    if (node.nodeName === '#text') {
      const text = node.nodeValue?.trim() || '';
      if (text) {
        return text.length > 200 ? text.slice(0, 200) + '...' : text;
      }
      return '';
    }

    // Check if interactive
    const isInteractive = this.isInteractiveElement(node);
    const ref = isInteractive ? ++this.refCounter : null;

    if (isInteractive && ref !== null) {
      this.refMap.set(ref, this.buildSelector(node));
      interactiveElements.push({
        ref,
        tag: node.nodeName.toLowerCase(),
        type: this.getAttribute(node, 'type') || undefined,
        text: this.getTextContent(node).slice(0, 100),
        selector: this.buildSelector(node),
      });
    }

    // Skip non-interactive elements in interactiveOnly mode
    if (interactiveOnly && !isInteractive && !this.isContainerElement(node)) {
      return '';
    }

    // Build element representation
    const tag = node.nodeName.toLowerCase();
    const attrs = this.buildAttributes(node, { includeImages });
    const refStr = ref !== null ? `[${ref}]` : '';

    if (this.isVoidElement(node.nodeName)) {
      return `${indent}<${tag}${attrs}${refStr} />\n`;
    }

    // Container element with children
    const children = node.children || [];
    const textContent = this.getTextContent(node);

    if (children.length === 0) {
      if (textContent.trim()) {
        return `${indent}<${tag}${attrs}${refStr}>${textContent.trim()}</${tag}>\n`;
      }
      return `${indent}<${tag}${attrs}${refStr}></${tag}>\n`;
    }

    // Element with children
    result += `${indent}<${tag}${attrs}${refStr}>\n`;

    for (const child of children) {
      const childSnapshot = this.buildSnapshot(child, { ...options, depth: depth + 1 });
      if (childSnapshot) {
        result += childSnapshot;
      }
    }

    result += `${indent}</${tag}>\n`;

    return result;
  }

  /**
   * Check if element is hidden
   */
  private isHidden(node: DOMNode): boolean {
    const style = this.getAttribute(node, 'style') || '';
    if (style.includes('display:none') || style.includes('visibility:hidden')) {
      return true;
    }

    const hidden = this.getAttribute(node, 'hidden');
    if (hidden !== null && hidden !== 'false') {
      return true;
    }

    const ariaHidden = this.getAttribute(node, 'aria-hidden');
    if (ariaHidden === 'true') {
      return true;
    }

    return false;
  }

  /**
   * Check if element is interactive
   */
  private isInteractiveElement(node: DOMNode): boolean {
    const interactiveTags = [
      'A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'DETAILS', 'SUMMARY',
    ];

    if (interactiveTags.includes(node.nodeName)) {
      return true;
    }

    const role = this.getAttribute(node, 'role');
    if (role && ['button', 'link', 'textbox', 'checkbox', 'radio', 'tab'].includes(role)) {
      return true;
    }

    const onclick = this.getAttribute(node, 'onclick');
    if (onclick) {
      return true;
    }

    const tabindex = this.getAttribute(node, 'tabindex');
    if (tabindex && tabindex !== '-1') {
      return true;
    }

    return false;
  }

  /**
   * Check if element is a container (should not be skipped in interactiveOnly mode)
   */
  private isContainerElement(node: DOMNode): boolean {
    const containers = ['DIV', 'SECTION', 'ARTICLE', 'MAIN', 'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'FORM'];
    return containers.includes(node.nodeName);
  }

  /**
   * Check if element is void (self-closing)
   */
  private isVoidElement(tagName: string): boolean {
    const voidElements = [
      'AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT',
      'LINK', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR',
    ];
    return voidElements.includes(tagName.toUpperCase());
  }

  /**
   * Build attribute string
   */
  private buildAttributes(node: DOMNode, options: { includeImages: boolean }): string {
    const attrs: string[] = [];
    const importantAttrs = [
      'id', 'class', 'href', 'src', 'alt', 'title', 'placeholder',
      'type', 'name', 'value', 'checked', 'selected', 'disabled',
      'role', 'aria-label', 'data-testid',
    ];

    if (node.attributes) {
      for (const attr of node.attributes) {
        if (importantAttrs.includes(attr.name)) {
          if (attr.name === 'src' && !options.includeImages) {
            continue;
          }
          attrs.push(`${attr.name}="${attr.value.slice(0, 100)}"`);
        }
      }
    }

    return attrs.length > 0 ? ' ' + attrs.join(' ') : '';
  }

  /**
   * Get text content from node
   */
  private getTextContent(node: DOMNode): string {
    if (node.nodeName === '#text') {
      return node.nodeValue || '';
    }

    let text = '';
    if (node.children) {
      for (const child of node.children) {
        text += this.getTextContent(child);
      }
    }

    return text;
  }

  /**
   * Get attribute value
   */
  private getAttribute(node: DOMNode, name: string): string | null {
    if (!node.attributes) return null;
    const attr = node.attributes.find(a => a.name === name);
    return attr ? attr.value : null;
  }

  /**
   * Build CSS selector for element
   */
  private buildSelector(node: DOMNode): string {
    const id = this.getAttribute(node, 'id');
    if (id) return `#${id}`;

    const dataTestId = this.getAttribute(node, 'data-testid');
    if (dataTestId) return `[data-testid="${dataTestId}"]`;

    const tag = node.nodeName.toLowerCase();
    const className = this.getAttribute(node, 'class');
    if (className) {
      const classes = className.split(' ').filter(c => c && !c.startsWith('_'));
      if (classes.length > 0) {
        return `${tag}.${classes.slice(0, 2).join('.')}`;
      }
    }

    return tag;
  }

  /**
   * Get selector for ref
   */
  getSelectorForRef(ref: number): string | undefined {
    return this.refMap.get(ref);
  }
}

// DOM Node interface
interface DOMNode {
  nodeId?: number;
  nodeName: string;
  nodeValue?: string;
  nodeType?: number;
  attributes?: Array<{ name: string; value: string }>;
  children?: DOMNode[];
  backendNodeId?: number;
}

export default SnapshotEngine;
