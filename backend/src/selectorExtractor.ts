import { Page, ElementHandle } from 'playwright';
import { ElementInfo } from './types';

export class SelectorExtractor {
  constructor(private readonly page: Page) {}

  async extractAllInteractive(): Promise<ElementInfo[]> {
    const handles = await this.page.$$(
      'button, a, input, textarea, select, [role=button], [role=link], [onclick]'
    );

    const results: ElementInfo[] = [];
    for (const h of handles) {
      const info = await this.fromHandle(h);
      results.push(info);
    }

    return results;
  }

  async extractForSelector(selector: string): Promise<ElementInfo> {
    const handle = await this.page.$(selector);
    if (!handle) throw new Error(`Element not found: ${selector}`);
    return this.fromHandle(handle);
  }

  private async fromHandle(handle: ElementHandle): Promise<ElementInfo> {
    const base = await handle.evaluate((el: any) => {
      return {
        tagName: el.tagName.toLowerCase(),
        id: el.id || undefined,
        className: el.className || undefined,
        text: el.textContent?.trim() || undefined,
        ariaLabel: el.getAttribute('aria-label') || undefined,
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
      cssSelector,
      xpath,
      attributes: Object.fromEntries(base.attrs)
    };
  }

  private async generateCss(handle: ElementHandle): Promise<string> {
    return handle.evaluate((el: any) => {
      if (el.id) return `#${el.id}`;
      if (el.getAttribute('data-testid')) {
        return `[data-testid="${el.getAttribute('data-testid')}"]`;
      }

      const parts: string[] = [];
      let curr: any = el;
      const doc = el.ownerDocument || (typeof document !== 'undefined' ? document : null);
      
      while (curr && curr !== (doc ? doc.body : null)) {
        let part = curr.tagName.toLowerCase();
        if (curr.id) {
          part += `#${curr.id}`;
          parts.unshift(part);
          break;
        }

        const classes = (curr.className || '')
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .map((c: string) => `.${c}`);
        if (classes.length) part += classes.join('');

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
}
