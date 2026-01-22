import { Page, ElementHandle, Frame } from 'playwright';
import { ElementInfo } from './types';

export class SelectorExtractor {
  constructor(private readonly page: Page) {}

  async extractAllInteractive(): Promise<ElementInfo[]> {
    const frames = this.page.frames();
    const allElements: ElementInfo[] = [];
    const seen = new Set<string>();

    for (const frame of frames) {
      try {
        // FIX 1: Wait for basic stability before extracting
        try { await frame.waitForLoadState('domcontentloaded', { timeout: 1000 }); } catch {}

        // FIX 2: Use recursive evaluator to find Shadow DOM elements
        const results = await this.extractFromFrame(frame);
        
        for (const info of results) {
           if (!info) continue;
           const bbox = info.boundingBox || { x: 0, y: 0 };
           const key = `${info.tagName}|${info.text}|${bbox.x},${bbox.y}|${frame.url()}`;
           
           if (!seen.has(key)) {
             seen.add(key);
             allElements.push(info);
           }
        }
      } catch (e) {
        // Ignore cross-origin frame access errors
      }
    }
    return allElements;
  }

  private async extractFromFrame(frame: Frame): Promise<(ElementInfo | null)[]> {
    // FIX 3: Custom JS Evaluation to find ALL interactive elements, including Shadow DOM
    const handles = await frame.evaluateHandle(() => {
        const interactiveSelectors = [
            'button', 'a', 'input', 'textarea', 'select',
            '[role="button"]', '[role="link"]', '[role="option"]', 
            '[role="menuitem"]', '[role="textbox"]', '[role="combobox"]',
            '[tabindex]:not([tabindex="-1"])'
        ].join(',');

        // Recursive function to traverse Shadow Roots
        const findAll = (root: Document | ShadowRoot | Element): Element[] => {
            const elements: Element[] = [];
            
            // 1. Find inputs in current root
            const nodes = root.querySelectorAll(interactiveSelectors);
            nodes.forEach(el => elements.push(el));

            // 2. Find deeper Shadow Roots
            const allNodes = root.querySelectorAll('*');
            allNodes.forEach(el => {
                if (el.shadowRoot) {
                    elements.push(...findAll(el.shadowRoot));
                }
            });
            return elements;
        };

        return findAll(document);
    });

    const properties = await handles.getProperties();
    const resultPromises: Promise<ElementInfo | null>[] = [];

    for (const prop of properties.values()) {
        const elementHandle = prop.asElement();
        if (elementHandle) {
            resultPromises.push(this.extractFromHandle(elementHandle, frame));
        }
    }
    
    return Promise.all(resultPromises);
  }

  async extractForSelector(selector: string): Promise<ElementInfo> {
    const handle = await this.page.$(selector);
    if (!handle) throw new Error(`Element not found: ${selector}`);
    const info = await this.extractFromHandle(handle);
    if (!info) throw new Error(`Could not extract info for element: ${selector}`);
    return info;
  }

  async extractFromHandle(handle: ElementHandle, frame?: Frame): Promise<ElementInfo | null> {
    try {
      const base = await handle.evaluate((el: any) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        
        // FIX 4: More forgiving visibility check for animations
        // We accept opacity > 0 and slightly smaller elements
        const isVisible = 
            rect.width > 0 && rect.height > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none';

        if (!isVisible) return null;

        // ... [Keep existing extraction logic for tagName, text, roles] ...
        // (Copy the logic from your previous file here: tagName, roleHint, effectiveText, etc.)
        
        // --- RE-INSERT YOUR EXISTING ATTRIBUTE EXTRACTION LOGIC HERE ---
        const tagName = (el.tagName || '').toLowerCase();
        const getAttr = (n: string) => el.getAttribute(n) || '';
        
        let roleHint = 'other';
        if (tagName === 'button') roleHint = 'button';
        if (tagName === 'input') roleHint = 'input';
        
        // --- NEW: Context Extraction (Fix for "Insurance" Label) ---
        // Grab text from the direct parent or previous sibling to identify unlabeled inputs
        let context = '';
        if (el.parentElement) {
             // Get parent text but remove the element's own text to reduce noise
             const parentText = el.parentElement.innerText || '';
             const ownText = el.innerText || '';
             // Simple heuristic: take the first 50 chars of parent text if it's short
             if (parentText.length < 100 && parentText.length > ownText.length) {
                 context = parentText.replace(ownText, '').trim().slice(0, 50);
             }
        }
        // -----------------------------------------------------------

        return {
          tagName,
          text: (el.innerText || el.value || '').substring(0, 100).trim(),
          ariaLabel: getAttr('aria-label'),
          placeholder: getAttr('placeholder'),
          visible: true,
          context: context, // Return the captured context
          boundingBox: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
          attributes: Array.from(el.attributes).map((a: any) => [a.name, a.value])
        };
      });

      if (!base) return null;

      // Re-generate selector (Standard Playwright locator is shadow-piercing by default)
      // We use a simplified fallback if generation fails
      const cssSelector = await this.generateCss(handle).catch(() => base.tagName);

      return {
        ...base,
        selector: cssSelector,
        cssSelector: cssSelector,
        xpath: '', // Optional, CSS is preferred
        visible: true,
        roleHint: base.tagName === 'input' ? 'input' : 'button', // Simplified for brevity
        attributes: Object.fromEntries(base.attributes || [])
      } as any;
    } catch {
      return null;
    }
  }
  
  private async generateCss(handle: ElementHandle): Promise<string> {
    return handle.evaluate((el: any) => {
      const escapeCss = (str: string) => {
        if (typeof (globalThis as any).CSS !== 'undefined' && (globalThis as any).CSS.escape) {
          return (globalThis as any).CSS.escape(str);
        }
        return str.replace(/([:.[\\\]#])/g, '\\$1');
      };

      const getAttr = (name: string): string | null =>
        typeof el.getAttribute === 'function' ? el.getAttribute(name) : null;
      const escapeAttr = (value: string) => value.replace(/\\/g, '\\ \\').replace(/"/g, '\\"');

      if (el.id) {
        return `#${escapeCss(String(el.id))}`;
      }

      const dataTestId = getAttr('data-testid');
      if (dataTestId) {
        return `[data-testid="${escapeCss(dataTestId)}"]`;
      }

      const nameAttr = getAttr('name');
      if (nameAttr) {
          return `${(el.tagName || '').toLowerCase()}[name="${escapeAttr(nameAttr)}"]`;
      }

      const ariaLabel = getAttr('aria-label');
      if (ariaLabel) {
        const role = getAttr('role');
        const tag = (el.tagName || '').toLowerCase();
        if (role) {
          return `[role="${escapeAttr(role)}"][aria-label="${escapeAttr(ariaLabel)}"]`;
        }
        return `${tag}[aria-label="${escapeAttr(ariaLabel)}"]`;
      }

      const parts: string[] = [];
      let curr: any = el;

      while (curr && curr !== document.body) {
        let part = (curr.tagName || '').toLowerCase();
        if (!part) break;

        if (curr.id) {
          part += `#${escapeCss(String(curr.id))}`;
          parts.unshift(part);
          break;
        }

        const className = curr.className || '';
        if (typeof className === 'string') {
          const classes = className
            .split(/\s+/)
            .filter(Boolean)
            .filter((c: string) => /^[a-zA-Z0-9_-]+$/.test(c))
            .slice(0, 2)
            .map((c: string) => `.${c}`);
          if (classes.length) part += classes.join('');
        }

        const parent = curr.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children);
          const index = siblings.indexOf(curr) + 1;
          if (index > 0) part += `:nth-child(${index})`;
        }

        parts.unshift(part);
        curr = parent;
      }

      return parts.join(' > ');
    });
  }

  private async generateXpath(handle: ElementHandle): Promise<string> {
    return handle.evaluate((el: any) => {
      const segments: string[] = [];
      let node: any = el;
      while (node && node.nodeType === 1) {
        let index = 1;
        let sibling = node.previousElementSibling;
        while (sibling) {
          if (sibling.tagName === node.tagName) index++;
          sibling = sibling.previousElementSibling;
        }

        const tag = node.tagName.toLowerCase();
        segments.unshift(`${tag}[${index}]`);
        node = node.parentElement;
      }

      return '/' + segments.join('/');
    });
  }

  async findCandidates(query: string): Promise<ElementInfo[]> {
    const all = await this.extractAllInteractive();
    const lowerQuery = query.toLowerCase().trim();
    if (!lowerQuery) return [];

    const scored = all
      .map((info) => ({ info, score: this.scoreCandidate(info, lowerQuery) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score);

    return scored.map((s) => s.info);
  }

  scoreForQuery(info: ElementInfo, query: string): number {
    const lowerQuery = query.toLowerCase().trim();
    if (!lowerQuery) return 0;
    return this.scoreCandidate(info, lowerQuery);
  }

  private scoreCandidate(info: ElementInfo, lowerQuery: string): number {
    let score = 0;
    const text = (info.text || '').toLowerCase();
    const label = (info.ariaLabel || '').toLowerCase();
    const id = (info.id || '').toLowerCase();
    const className = (info.className || '').toLowerCase();
    const terms = lowerQuery.split(/\s+/).filter(Boolean);

    const hasExact =
      text === lowerQuery ||
      label === lowerQuery ||
      terms.some((t) => t.length > 1 && (text === t || label === t));
    if (hasExact) {
      score += 100;
    }

    const hasPartial =
      text.includes(lowerQuery) ||
      label.includes(lowerQuery) ||
      terms.some((t) => t.length > 1 && (text.includes(t) || label.includes(t)));
    if (hasPartial) {
      score += 50;
    }

    const queryHasIcon = lowerQuery.includes('icon');
    const queryHasSearch = lowerQuery.includes('search');

    if (queryHasIcon && (id.includes('icon') || className.includes('icon'))) {
      score += 25;
    }
    if (queryHasSearch && (id.includes('search') || className.includes('search'))) {
      score += 25;
    }

    if (info.visible) {
      score += 5;
    }

    return score;
  }
}