//
import { Page, ElementHandle } from 'playwright';
import { ElementInfo } from './types';

export class SelectorExtractor {
  constructor(private readonly page: Page) {}

  async extractAllInteractive(): Promise<ElementInfo[]> {
    const handles = await this.page.$$(
      [
        'button', 'a', 'input', 'textarea', 'select',
        '[role=button]', '[role=link]', '[role="option"]', '[role="search"]',
        '[onclick]', 'li[onclick]', 'div[onclick]', 'span[onclick]',
        '[class*="btn" i]', '[class*="button" i]', '[class*="icon" i]',
        '[style*="cursor: pointer"]', '[style*="cursor:pointer"]',
        '[tabindex]:not([tabindex="-1"])',
        // Universal Scroll Containers
        'ul', 'ol', 'div[style*="overflow"]', 'div[class*="scroll"]',
        '[role="listbox"]', '[role="menu"]', '.dropdown-menu',
        '[style*="z-index"]' // Floating elements
      ].join(', ')
    );

    const results: ElementInfo[] = [];
    const seen = new Set<string>();

    for (const h of handles) {
      const info = await this.extractFromHandle(h);
      if (!info) continue;

      const bbox = info.boundingBox || info.rect || { x: 0, y: 0, width: 0, height: 0 };
      const key = [info.tagName, info.text, `${bbox.x},${bbox.y}`].join('|');

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
    const interactiveHandle = await this.resolveInteractiveHandle(handle);

    const base = await interactiveHandle.evaluate((el: any) => {
      const win = el.ownerDocument && el.ownerDocument.defaultView;
      const rect = el.getBoundingClientRect();
      const style = win ? win.getComputedStyle(el) : null;
      
      const zIndex = style ? parseInt(style.zIndex || '0', 10) : 0;
      const isFloating = zIndex > 100 || (style && (style.position === 'absolute' || style.position === 'fixed'));

      // UNIVERSAL SCROLL DETECTION
      let isScrollable = style && (
        (style.overflowY === 'auto' || style.overflowY === 'scroll') ||
        (style.overflowX === 'auto' || style.overflowX === 'scroll')
      );
      
      const getAttr = (name: string): string =>
        typeof el.getAttribute === 'function' ? el.getAttribute(name) || '' : '';

      const role = getAttr('role');
      if (role === 'listbox' || role === 'menu' || role === 'tree') isScrollable = true;

      // UNIVERSAL STATE DETECTION
      // Standard way websites signal an open dropdown
      const ariaExpanded = getAttr('aria-expanded');
      const isExpanded = ariaExpanded === 'true';

      const visible =
        !!el.offsetParent &&
        rect.width > 0 &&
        rect.height > 0 &&
        (!style || (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'));

      const tagName = (el.tagName || '').toLowerCase();
      
      let roleHint: 'button' | 'link' | 'input' | 'option' | 'listbox' | 'other' = 'other';
      if (tagName === 'button') roleHint = 'button';
      else if (tagName === 'a') roleHint = 'link';
      else if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') roleHint = 'input';
      if (role === 'option' || role === 'menuitem') roleHint = 'option';
      if (role === 'listbox' || role === 'combobox') roleHint = 'listbox';

      const typeAttr = getAttr('type');
      const placeholder = getAttr('placeholder');
      const ariaLabel = getAttr('aria-label');
      const valueAttr = (el as any).value !== undefined ? String((el as any).value) : getAttr('value');
      const titleAttr = getAttr('title');
      const dataTestId = getAttr('data-testid');
      const href = getAttr('href');
      const isSearchField =
        tagName === 'input' &&
        (/search/i.test(typeAttr) || /search/i.test(placeholder) || /search/i.test(ariaLabel));

      // --- UNIVERSAL LABEL DETECTION ("The Eyes") ---
      // Dynamically find text next to the element to solve ambiguity.
      const getText = (node: any | null): string => {
        if (!node || node.nodeType !== 1) return '';
        return (node.innerText || node.textContent || '').trim();
      };

      let nearbyLabel = '';
      
      // 1. Look Left (Previous Sibling)
      let sibling = el.previousElementSibling;
      if (sibling && getText(sibling).length > 1 && getText(sibling).length < 40) {
          nearbyLabel = getText(sibling);
      }

      // 2. Look Up (Parent's Previous Sibling - Common in Forms)
      if (!nearbyLabel && el.parentElement) {
          const parentSibling = el.parentElement.previousElementSibling;
          if (parentSibling && getText(parentSibling).length > 1 && getText(parentSibling).length < 40) {
              nearbyLabel = getText(parentSibling);
          }
      }

      // 3. Look at Table Headers (If inside a grid)
      if (!nearbyLabel) {
          const td = el.closest('td');
          if (td && td.previousElementSibling) {
              nearbyLabel = getText(td.previousElementSibling);
          }
      }
      // ----------------------------------------------

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
        if (rect.top < viewportHeight * 0.25) region = 'header';
        else if (rect.top > viewportHeight * 0.75) region = 'footer';
        else region = 'main';
      }

      const rawText = (el.textContent || '').trim();
      let effectiveText = rawText || (tagName === 'input' ? valueAttr : '') || '';
      
      // Inject the discovered label into the text for the LLM
      if (nearbyLabel && !effectiveText.includes(nearbyLabel)) {
          effectiveText = `${nearbyLabel} ${effectiveText}`;
      }

      return {
        tagName,
        id: el.id || undefined,
        className: el.className || undefined,
        text: effectiveText, // Now includes "Insurance: " automatically
        ariaLabel,
        placeholder: placeholder || undefined,
        title: titleAttr || undefined,
        dataTestId: dataTestId || undefined,
        href,
        visible,
        roleHint,
        scrollable: isScrollable,
        isFloating,
        expanded: isExpanded, // Export state
        searchField: isSearchField,
        region,
        boundingBox: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        context: nearbyLabel || undefined,
        attrs: Array.from(el.attributes).map((a: any) => [a.name, a.value] as const)
      };
    });

    const cssSelector = await this.generateCss(interactiveHandle);
    const xpath = await this.generateXpath(interactiveHandle);
    const rawAttrs = Object.fromEntries(base.attrs);
    if (base.tagName === 'input' || base.tagName === 'textarea') rawAttrs['value'] = base.text || '';

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
      roleHint: base.roleHint as any,
      scrollable: base.scrollable,
      isFloating: base.isFloating,
      // @ts-ignore - 'expanded' was added to types.ts in previous step
      expanded: base.expanded,
      searchField: base.searchField,
      region: base.region,
      boundingBox: base.boundingBox,
      rect: base.boundingBox,
      context: base.context,
      attributes: rawAttrs
    };
  }

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

      let current: any = node;
      if (!isElementNode(current)) {
        current = (node && (node as any).parentElement) || node;
      }

      if (!isElementNode(current)) {
        return node;
      }

      if (isInteractive(current)) {
        return current;
      }

      if (isPassive(current) && typeof (current as any).closest === 'function') {
        const viaClosest = (current as any).closest(
          'button, a, input, textarea, select, [role="button"], [role="link"], [onclick]'
        );
        if (viaClosest) {
          return viaClosest;
        }
      }

      let ancestor: any | null = (current as any).parentElement;
      while (ancestor) {
        if (isInteractive(ancestor)) {
          return ancestor;
        }
        ancestor = (ancestor as any).parentElement;
      }

      return current;
    });

    const asElement = candidateHandle.asElement();
    return asElement ?? handle;
  }

  private async generateCss(handle: ElementHandle): Promise<string> {
    return handle.evaluate((el: any) => {
      const escapeCss = (str: string) => {
        if (typeof (globalThis as any).CSS !== 'undefined' && (globalThis as any).CSS.escape) {
          return (globalThis as any).CSS.escape(str);
        }
        return str.replace(/([:.[\]#])/g, '\\$1');
      };

      const getAttr = (name: string): string | null =>
        typeof el.getAttribute === 'function' ? el.getAttribute(name) : null;
      const escapeAttr = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

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

    if (info.isVisible !== false) score += 5;
    if (info.region === 'header') score += 5;
    if (info.searchField && queryHasSearch) score += 10;

    return score;
  }
}