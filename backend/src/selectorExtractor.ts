import { Page, ElementHandle } from 'playwright';
import { ElementInfo } from './types';

export class SelectorExtractor {
  constructor(private readonly page: Page) {}

  async extractAllInteractive(): Promise<ElementInfo[]> {
    const handles = await this.page.$$(
      [
        'button',
        'a',
        'input',
        'textarea',
        'select',
        '[role=button]',
        '[role=link]',
        '[role="option"]',
        '[role="search"]',
        '[onclick]',
        'li[onclick]',
        'img[onclick]',
        'div[onclick]',
        // Button-like and icon/search affordances commonly used with event delegation.
        '[class*="btn" i]',
        '[class*="button" i]',
        '[class*="icon" i]',
        '[class*="search" i]',
        // SVG icons that explicitly indicate pointer interactions.
        'svg[cursor="pointer"]'
      ].join(', ')
    );

    const results: ElementInfo[] = [];
    const seen = new Set<string>();

    for (const h of handles) {
      const info = await this.extractFromHandle(h);
      if (!info) continue;

      const bbox = info.boundingBox || info.rect || { x: 0, y: 0, width: 0, height: 0 };
      const key = [
        info.tagName,
        info.id ?? '',
        info.className ?? '',
        info.text ?? '',
        info.ariaLabel ?? '',
        info.href ?? '',
        `${bbox.x},${bbox.y}`
      ].join('|');

      if (seen.has(key)) continue;
      seen.add(key);
      results.push(info);
    }

    return results;
  }

  async extractForSelector(selector: string): Promise<ElementInfo> {
    const handle = await this.page.$(selector);
    if (!handle) throw new Error(`Element not found: ${selector}`);
    return this.extractFromHandle(handle);
  }

  async extractFromHandle(handle: ElementHandle): Promise<ElementInfo> {
    const base = await handle.evaluate((el: any) => {
      const win = el.ownerDocument && el.ownerDocument.defaultView;
      const rect = el.getBoundingClientRect();
      const style = win ? win.getComputedStyle(el) : null;
      const visible =
        !!el.offsetParent &&
        rect.width > 0 &&
        rect.height > 0 &&
        (!style || (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'));

      const tagName = (el.tagName || '').toLowerCase();
      let roleHint: 'button' | 'link' | 'input' | 'other' = 'other';
      if (tagName === 'button') roleHint = 'button';
      else if (tagName === 'a') roleHint = 'link';
      else if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') roleHint = 'input';

      const getAttr = (name: string): string =>
        typeof el.getAttribute === 'function' ? el.getAttribute(name) || '' : '';

      const typeAttr = getAttr('type');
      const placeholder = getAttr('placeholder');
      const ariaLabel = getAttr('aria-label');
      const titleAttr = getAttr('title');
      const dataTestId = getAttr('data-testid');
      const href = getAttr('href');
      const isSearchField =
        tagName === 'input' &&
        (/search/i.test(typeAttr) || /search/i.test(placeholder) || /search/i.test(ariaLabel));

      const viewportHeight = win && win.innerHeight ? win.innerHeight : 900;
      let region: 'header' | 'main' | 'footer' = 'main';
      if (rect.top < viewportHeight * 0.25) region = 'header';
      else if (rect.top > viewportHeight * 0.75) region = 'footer';

      // --- Smart Context computation ---
      const getText = (node: any | null): string => {
        if (!node) return '';
        const txt = (node.textContent || '').trim();
        return txt;
      };

      const isSectionHeader = (node: any | null): boolean => {
        if (!node || node.nodeType !== 1) return false;
        const t = (node.tagName || '').toLowerCase();
        if (/^h[1-6]$/.test(t)) return true;

        // Use safe attribute access to avoid SVGAnimatedString / non-string className issues.
        const roleAttr =
          typeof (node as any).getAttribute === 'function'
            ? (node as any).getAttribute('role') || ''
            : '';
        if (roleAttr && roleAttr.toLowerCase() === 'heading') return true;

        const rawId = (node as any).id ?? '';
        const id = (typeof rawId === 'string' ? rawId : String(rawId)).toLowerCase();
        const classStr =
          typeof (node as any).getAttribute === 'function'
            ? (node as any).getAttribute('class') || ''
            : typeof (node as any).className === 'string'
            ? (node as any).className
            : '';
        const className = classStr.toLowerCase();
        const combined = `${id} ${className}`;
        const keywords = ['title', 'header', 'name', 'card-label', 'profile'];
        return keywords.some((k) => combined.includes(k));
      };

      const findSectionHeaderContext = (start: any): string => {
        let current: any = start;
        let depth = 0;
        while (current && depth < 7) {
          let sib = current.previousElementSibling;
          while (sib) {
            if (isSectionHeader(sib)) {
              const txt = getText(sib);
              if (txt) return txt;
            }
            sib = sib.previousElementSibling;
          }
          current = current.parentElement;
          depth++;
        }
        return '';
      };

      let context: string | undefined;

      // Strategy 1: immediate visual context for inputs (labels next to fields).
      if (roleHint === 'input') {
        const directLabel = getText(el.previousElementSibling);
        let gridLabel = '';
        if (!directLabel && el.parentElement) {
          gridLabel = getText(el.parentElement.previousElementSibling);
        }
        const combined = [directLabel, gridLabel].filter(Boolean).join(' | ');
        if (combined) {
          context = combined;
        }
      }

      // Strategy 2: DOM-walk for section headers for all interactive elements.
      if (!context && (roleHint === 'button' || roleHint === 'link' || roleHint === 'other' || roleHint === 'input')) {
        const header = findSectionHeaderContext(el);
        if (header) {
          context = header;
        }
      }

      // Smart text extraction: prefer accessible helper text such as .sr-only or
      // .visually-hidden children when present (often used for icon buttons).
      let srOnlyText = '';
      if (typeof el.querySelectorAll === 'function') {
        const hiddenNodes = el.querySelectorAll('.sr-only, .visually-hidden');
        srOnlyText = Array.from(hiddenNodes)
          .map((n: any) => (n.textContent || '').trim())
          .filter(Boolean)
          .join(' ')
          .trim();
      }

      const rawText = (el.textContent || '').trim();
      const mainText = (srOnlyText || rawText) || undefined;

      return {
        tagName,
        id: el.id || undefined,
        className: el.className || undefined,
        text: mainText,
        ariaLabel,
        placeholder: placeholder || undefined,
        title: titleAttr || undefined,
        dataTestId: dataTestId || undefined,
        href,
        visible,
        roleHint,
        searchField: isSearchField,
        region,
        boundingBox: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        context,
        attrs: Array.from(el.attributes).map((a: any) => [a.name, a.value] as const)
      };
    });

    const cssSelector = await this.generateCss(handle);
    const xpath = await this.generateXpath(handle);

    return {
      tagName: base.tagName,
      id: base.id,
      className: base.className,
      text: base.text,
      ariaLabel: base.ariaLabel,
      placeholder: base.placeholder,
      title: base.title,
      dataTestId: base.dataTestId,
      href: base.href,
      cssSelector,
      xpath,
      selector: cssSelector,
      visible: base.visible,
      isVisible: base.visible,
      roleHint: base.roleHint,
      searchField: base.searchField,
      region: base.region,
      boundingBox: base.boundingBox,
      rect: base.boundingBox,
      context: base.context,
      attributes: Object.fromEntries(base.attrs)
    };
  }

  private async generateCss(handle: ElementHandle): Promise<string> {
    return handle.evaluate((el: any) => {
      const doc = el.ownerDocument || (typeof document !== 'undefined' ? document : null);
      const tag = (el.tagName || '').toLowerCase();
      const getAttr = (name: string): string | null =>
        typeof el.getAttribute === 'function' ? el.getAttribute(name) : null;
      const escapeAttr = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

      // 1) Prefer stable single-attribute selectors that are resilient to
      // layout changes.
      if (el.id) {
        return `#${el.id}`;
      }

      const dataTestId = getAttr('data-testid');
      if (dataTestId) {
        return `[data-testid="${escapeAttr(dataTestId)}"]`;
      }

      const nameAttr = getAttr('name');
      if (nameAttr) {
        return `${tag}[name="${escapeAttr(nameAttr)}"]`;
      }

      const ariaLabel = getAttr('aria-label');
      if (ariaLabel) {
        // Prefer role+aria-label for interactive controls when possible.
        const role = getAttr('role');
        if (role) {
          return `[role="${escapeAttr(role)}"][aria-label="${escapeAttr(ariaLabel)}"]`;
        }
        return `${tag}[aria-label="${escapeAttr(ariaLabel)}"]`;
      }

      // 2) Fallback: structural selector chain with limited class usage and
      // nth-child. This is inherently more brittle, so only use it when we
      // couldn't derive any robust attribute-based selector.
      const parts: string[] = [];
      let curr: any = el;

      while (curr && curr !== (doc ? doc.body : null)) {
        let part = (curr.tagName || '').toLowerCase();
        if (!part) break;

        if (curr.id) {
          part += `#${curr.id}`;
          parts.unshift(part);
          break;
        }

        const className = curr.className || '';
        if (typeof className === 'string') {
          const classes = className
            .split(/\s+/)
            .filter(Boolean)
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
      // nodeType === 1 is ELEMENT_NODE
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

  /**
   * Universal candidate finder with weighted scoring over all interactive
   * elements on the page.
   */
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

  /**
   * Backwards-compatible helper that now delegates to findCandidates().
   */
  async findRelatedElements(query: string): Promise<ElementInfo[]> {
    return this.findCandidates(query);
  }

  /**
   * Weighted scoring according to the spec:
   *  - 100 pts: exact text/aria-label match (full phrase or individual term)
   *  - 50  pts: partial text/aria-label match
   *  - 25  pts: semantic boost when the query mentions "icon" or "search" and
   *             the element id/class names include those terms.
   * Additional small boosts prefer visible elements in the header region and
   * known search fields to keep results intuitive.
   */
  private scoreCandidate(info: ElementInfo, lowerQuery: string): number {
    let score = 0;

    const text = (info.text || '').toLowerCase();
    const label = (info.ariaLabel || '').toLowerCase();
    const id = (info.id || '').toLowerCase();
    const className = (info.className || '').toLowerCase();

    const terms = lowerQuery.split(/\s+/).filter(Boolean);

    // 100 pts: exact match on full query or any individual term.
    const hasExact =
      text === lowerQuery ||
      label === lowerQuery ||
      terms.some((t) => t.length > 1 && (text === t || label === t));
    if (hasExact) {
      score += 100;
    }

    // 50 pts: any partial match on text or aria-label.
    const hasPartial =
      text.includes(lowerQuery) ||
      label.includes(lowerQuery) ||
      terms.some((t) => t.length > 1 && (text.includes(t) || label.includes(t)));
    if (hasPartial) {
      score += 50;
    }

    // 25 pts: semantic boost for icon/search terminology in id/class.
    const queryHasIcon = lowerQuery.includes('icon');
    const queryHasSearch = lowerQuery.includes('search');

    if (queryHasIcon && (id.includes('icon') || className.includes('icon'))) {
      score += 25;
    }
    if (queryHasSearch && (id.includes('search') || className.includes('search'))) {
      score += 25;
    }

    // Small tie-breakers: visible + header region + known search fields.
    if (info.isVisible !== false) {
      score += 5;
    }
    if (info.region === 'header') {
      score += 5;
    }
    if (info.searchField && queryHasSearch) {
      score += 10;
    }

    return score;
  }
}
