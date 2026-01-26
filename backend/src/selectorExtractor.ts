// selectorExtractor.ts

import { Page, ElementHandle, Frame } from 'playwright';
import { ElementInfo } from './types';

export class SelectorExtractor {
  constructor(private readonly page: Page) {}

  async extractAllInteractive(): Promise<ElementInfo[]> {
    const frames = [this.page, ...this.page.frames().filter(f => f !== this.page.mainFrame())];
    let allResults: ElementInfo[] = [];

    for (const frame of frames) {
        try {
            const results = await this.extractFromScope(frame);
            allResults.push(...results);
        } catch (e) { /* Frame detached */ }
    }
    
    // De-duplicate based on exact location (x,y)
    const unique = new Map<string, ElementInfo>();
    for (const el of allResults) {
        // Round coordinates to avoid sub-pixel dupes
        const k = `${Math.round(el.boundingBox?.x || 0)},${Math.round(el.boundingBox?.y || 0)}`;
        if (!unique.has(k) || (el.text && el.text.length > (unique.get(k)?.text?.length || 0))) {
            unique.set(k, el);
        }
    }

    return Array.from(unique.values());
  }

  private async extractFromScope(scope: Page | Frame): Promise<ElementInfo[]> {
    // 1. Expanded Selector list to catch everything
    const handles = await scope.$$(
      [
        'button', 'a', 'input:not([type="hidden"])', 'textarea', 'select',
        '[role=button]', '[role=link]', '[role="checkbox"]', '[role="switch"]', 
        '[role="menuitem"]', '[role="option"]',
        '[onclick]', '[class*="btn" i]', '[class*="button" i]', 
        '[contenteditable]', '[tabindex]:not([tabindex="-1"])'
      ].join(', ')
    );

    const results: ElementInfo[] = [];
    
    for (const h of handles) {
      // Filter non-visible early to save time
      const isVisible = await h.isVisible();
      if (!isVisible) continue;

      const info = await this.extractFromHandle(h);
      if (info) results.push(info);
    }
    return results;
  }

  async extractFromHandle(handle: ElementHandle): Promise<ElementInfo | null> {
    // 2. Strict Input Handling: Do not bubble up if it's already an input
    const interactiveHandle = await this.resolveInteractiveHandle(handle);
    
    const base = await interactiveHandle.evaluate((el: any) => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;

        const getAttr = (name: string) => el.getAttribute(name) || '';
        const tagName = el.tagName.toLowerCase();
        const inputType = (tagName === 'input' ? getAttr('type') : '').toLowerCase();

        // Label Resolution Strategy
        let label = getAttr('aria-label') || getAttr('placeholder') || getAttr('name') || '';
        
        // If no internal label, look for <label> tag
        if (!label && el.id) {
            const labelEl = document.querySelector(`label[for="${el.id}"]`);
            if (labelEl) label = labelEl.textContent?.trim() || '';
        }
        
        // If still no label, check previous sibling for text (common in simple forms)
        if (!label && (tagName === 'input' || tagName === 'select')) {
             let sib = el.previousElementSibling;
             while(sib && sib.tagName === 'BR') sib = sib.previousElementSibling; // skip breaks
             if (sib && sib.textContent && sib.textContent.length < 50) {
                 label = sib.textContent.trim();
             }
             // Check parent text if concise
             if (!label && el.parentElement && el.parentElement.innerText.length < 50) {
                 label = el.parentElement.innerText.replace(el.value || '', '').trim();
             }
        }

        return {
            tagName,
            id: el.id,
            className: el.className,
            text: el.innerText || el.value || '', // Prefer value for inputs
            ariaLabel: label,
            placeholder: getAttr('placeholder'),
            type: inputType,
            name: getAttr('name'),
            role: getAttr('role'),
            boundingBox: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
            visible: true
        };
    });

    if (!base) return null;

    // 3. Generate ROBUST Selector (The fix for "UserPass" bug)
    const cssSelector = await this.generateCss(interactiveHandle);
    const xpath = await this.generateXpath(interactiveHandle);

    return {
        ...base,
        cssSelector,
        selector: cssSelector,
        xpath,
        attributes: { type: base.type, name: base.name, role: base.role },
        isVisible: true
    } as any;
  }

  // Prevent generic divs from stealing focus
  private async resolveInteractiveHandle(handle: ElementHandle): Promise<ElementHandle> {
    return handle.evaluateHandle((el: any) => {
        const t = el.tagName.toLowerCase();
        // If it's a form field, IT IS the target. Never bubble up.
        if (['input', 'select', 'textarea', 'label'].includes(t)) return el;
        
        // Otherwise, bubble up to finding clickable parent
        return el.closest('button, a, [role="button"], [onclick]') || el;
    }).then(h => h.asElement() || handle);
  }

  // 4. Unique Selector Generation
  private async generateCss(handle: ElementHandle): Promise<string> {
    return handle.evaluate((el: any) => {
      const escapeCss = (str: string) => CSS.escape(str);
      
      // A. ID is king
      if (el.id) return `#${escapeCss(el.id)}`;

      // B. Unique Name/Placeholder (common in logins)
      if (el.name) {
          const nameSel = `${el.tagName.toLowerCase()}[name="${escapeCss(el.name)}"]`;
          if (document.querySelectorAll(nameSel).length === 1) return nameSel;
      }
      if (el.placeholder) {
          const phSel = `${el.tagName.toLowerCase()}[placeholder="${escapeCss(el.placeholder)}"]`;
          if (document.querySelectorAll(phSel).length === 1) return phSel;
      }

      // C. Structural Fallback (Strict nth-of-type)
      const path: string[] = [];
      let current = el;
      while (current && current.nodeType === 1) {
          let selector = current.tagName.toLowerCase();
          
          if (current.id) {
              selector = `#${escapeCss(current.id)}`;
              path.unshift(selector);
              break; 
          }

          // Use nth-of-type to differentiate "Username input" from "Password input"
          let sibling = current;
          let nth = 1;
          while (sibling = sibling.previousElementSibling) {
              if (sibling.tagName.toLowerCase() === selector) nth++;
          }
          if (nth > 1) selector += `:nth-of-type(${nth})`;
          
          path.unshift(selector);
          current = current.parentElement;
      }
      return path.join(' > ');
    });
  }

  private async generateXpath(handle: ElementHandle): Promise<string> {
      // Standard robust xpath generation
      return handle.evaluate((el: any) => {
          if (el.id) return `//*[@id="${el.id}"]`;
          const parts = [];
          while (el && el.nodeType === 1) {
              let idx = 1;
              for (let sib = el.previousSibling; sib; sib = sib.previousSibling) {
                  if (sib.nodeType === 1 && sib.tagName === el.tagName) idx++;
              }
              parts.unshift(`${el.tagName.toLowerCase()}[${idx}]`);
              el = el.parentNode;
          }
          return '/' + parts.join('/');
      });
  }
}
