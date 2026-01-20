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
        'span[onclick]',
        'td[onclick]',
        'tr[onclick]',
        // Button-like and icon/search affordances commonly used with event delegation.
        '[class*="btn" i]',
        '[class*="button" i]',
        '[class*="icon" i]',
        '[class*="search" i]',
        '[class*="link" i]',
        '[class*="click" i]',
        // ASP.NET LinkButton and similar server controls
        'a[href*="javascript:__doPostBack"]',
        'a[href*="javascript:WebForm_DoPostBackWithOptions"]',
        '[id*="LinkButton"]',
        '[id*="lnk"]',
        // Elements with pointer cursor (commonly clickable)
        '[style*="cursor: pointer"]',
        '[style*="cursor:pointer"]',
        // SVG icons that explicitly indicate pointer interactions.
        'svg[cursor="pointer"]',
        'svg[style*="cursor: pointer"]',
        'svg[style*="cursor:pointer"]',
        // Any element with tabindex (keyboard-accessible, often clickable)
        '[tabindex]:not([tabindex="-1"])'
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
    // Before extracting metadata, ensure we are pointing at the most
    // appropriate interactive ancestor for this element. This prevents us
    // from trying to click on passive children such as <span> or text nodes
    // when the actual event listener is attached on an enclosing <button>,
    // <a>, or other semantic control.
    const interactiveHandle = await this.resolveInteractiveHandle(handle);

    const base = await interactiveHandle.evaluate((el: any) => {
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
      const valueAttr = getAttr('value'); // <--- ADD THIS
      const titleAttr = getAttr('title');
      const dataTestId = getAttr('data-testid');
      const href = getAttr('href');
      const isSearchField =
        tagName === 'input' &&
        (/search/i.test(typeAttr) || /search/i.test(placeholder) || /search/i.test(ariaLabel));

      // --- Structural region detection ---
      // Prefer semantic landmarks when available and fall back to viewport
      // position only when necessary. This enables better disambiguation of
      // duplicate controls (e.g., header vs footer buttons).
      const viewportHeight = win && win.innerHeight ? win.innerHeight : 900;
      let region: 'header' | 'main' | 'footer' = 'main';

      const closestSafe = (selector: string): Element | null => {
        try {
          return typeof el.closest === 'function' ? el.closest(selector) : null;
        } catch {
          return null;
        }
      };

      if (closestSafe('header') || closestSafe('nav')) {
        region = 'header';
      } else if (closestSafe('footer')) {
        region = 'footer';
      } else if (closestSafe('main')) {
        region = 'main';
      } else {
        // Fallback: approximate using vertical position when landmarks are not
        // present.
        if (rect.top < viewportHeight * 0.25) region = 'header';
        else if (rect.top > viewportHeight * 0.75) region = 'footer';
        else region = 'main';
      }

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

      // INTELLIGENT FALLBACK: If text content is empty, check the 'value' attribute.
      // This is critical for <input type="submit" value="Go">
      const effectiveText = rawText || (tagName === 'input' ? valueAttr : '') || '';

      const mainText = (srOnlyText || effectiveText) || undefined;

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

    const cssSelector = await this.generateCss(interactiveHandle);
    const xpath = await this.generateXpath(interactiveHandle);

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

  /**
   * Given a handle that may point at a passive node (e.g., <span>, <div>,
   * <p>, or a text node), walk up the DOM to find a semantic interactive
   * ancestor such as <button>, <a>, <input>, <select>, or an element with an
   * appropriate ARIA role. If none is found, fall back to the original
   * element so we never lose the concrete target.
   */
  private async resolveInteractiveHandle(handle: ElementHandle): Promise<ElementHandle> {
    const candidateHandle = await handle.evaluateHandle((node: any) => {
      const isElementNode = (n: any): n is Element => !!n && n.nodeType === 1;

      const isInteractive = (el: any | null): boolean => {
        if (!isElementNode(el)) return false;
        const tag = (el.tagName || '').toLowerCase();
        const role =
          typeof (el as any).getAttribute === 'function'
            ? ((el as any).getAttribute('role') || '').toLowerCase()
            : '';
        const hasOnClick = typeof (el as any).onclick === 'function';
        const interactiveTags = ['button', 'a', 'input', 'select', 'textarea'];
        const interactiveRoles = ['button', 'combobox', 'listbox', 'menuitem', 'checkbox', 'link'];
        return interactiveTags.includes(tag) || interactiveRoles.includes(role) || hasOnClick;
      };

      const isPassive = (el: any | null): boolean => {
        if (!isElementNode(el)) return false;
        const tag = (el.tagName || '').toLowerCase();
        return tag === 'span' || tag === 'div' || tag === 'p' || tag === 'i';
      };

      // Normalize starting point: if we were given a text node or other
      // non-element, start from its parent element.
      let current: any = node;
      if (!isElementNode(current)) {
        current = (node && (node as any).parentElement) || node;
      }

      if (!isElementNode(current)) {
        return node;
      }

      // If already interactive, keep as-is.
      if (isInteractive(current)) {
        return current;
      }

      // If this is a passive node (e.g., span/div/text/i), try closest() to
      // jump directly to the nearest interactive ancestor (universal bubbling).
      if (isPassive(current) && typeof (current as any).closest === 'function') {
        const viaClosest = (current as any).closest(
          'button, a, input, textarea, select, [role="button"], [role="link"], [onclick]'
        );
        if (viaClosest) {
          return viaClosest;
        }
      }

      // Fallback: manual parent walk with semantic checks for robustness.
      let ancestor: any | null = (current as any).parentElement;
      while (ancestor) {
        if (isInteractive(ancestor)) {
          return ancestor;
        }
        ancestor = (ancestor as any).parentElement;
      }

      // No interactive ancestor; stay on the original element.
      return current;
    });

    const asElement = candidateHandle.asElement();
    return asElement ?? handle;
  }

  private async generateCss(handle: ElementHandle): Promise<string> {
    return handle.evaluate((el: any) => {
      const doc = el.ownerDocument || (typeof document !== 'undefined' ? document : null);
      const tag = (el.tagName || '').toLowerCase();
      
      // FIX: Robust CSS escaping helper
      const escapeCss = (str: string) => {
        if (typeof (globalThis as any).CSS !== 'undefined' && (globalThis as any).CSS.escape) {
          return (globalThis as any).CSS.escape(str);
        }
        // Polyfill for environments without CSS.escape
        return str.replace(/([:.[\]#])/g, '\\$1');
      };

      const getAttr = (name: string): string | null =>
        typeof el.getAttribute === 'function' ? el.getAttribute(name) : null;
      const escapeAttr = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

      // 1) Prefer stable single-attribute selectors that are resilient to
      // layout changes.
      if (el.id) {
        const rawId = String(el.id);
        // FIX: Always escape ID to handle Radix/MUI colons (e.g. #radix-:r1:)
        return `#${escapeCss(rawId)}`;
      }

      const dataTestId = getAttr('data-testid');
      if (dataTestId) {
        return `[data-testid="${escapeCss(dataTestId)}"]`;
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
          // Use the same robust escaping as for the primary id case so that
          // ancestor ids like "radix-:r1:" do not produce invalid selectors.
          part += `#${escapeCss(String(curr.id))}`;
          parts.unshift(part);
          break;
        }

        const className = curr.className || '';
        if (typeof className === 'string') {
          // Only keep "simple" class names that do not require CSS escaping.
          // This avoids generating selectors that Playwright cannot parse,
          // such as classes containing "/" or other special characters.
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
   * Public wrapper so external callers (e.g., McpTools) can consistently score
   * candidates using the same weighting rules that findCandidates() relies on.
   */
  scoreForQuery(info: ElementInfo, query: string): number {
    const lowerQuery = query.toLowerCase().trim();
    if (!lowerQuery) return 0;
    return this.scoreCandidate(info, lowerQuery);
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
