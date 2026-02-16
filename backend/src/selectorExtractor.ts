// selectorExtractor.ts

import { Page, ElementHandle, Frame } from 'playwright';
import { ElementInfo } from './types';

export class SelectorExtractor {
  constructor(private readonly page: Page) {}

  // Dynamic element prioritization based on action context to prevent misclicks
  async extractWithActionPrioritization(actionType: 'click' | 'type' | 'select_option'): Promise<ElementInfo[]> {
    const allElements = await this.extractAllInteractive();

    // For 'type' actions, prioritize input/textarea elements over select/dropdown elements
    if (actionType === 'type') {
      const inputs = allElements.filter(el => el.tagName === 'input' || el.tagName === 'textarea');
      const others = allElements.filter(el => el.tagName !== 'input' && el.tagName !== 'textarea');

      // Return inputs first, then other elements to ensure typing goes to input fields
      return [...inputs, ...others];
    }

    // For 'select_option' actions, prioritize select elements and dropdown triggers
    if (actionType === 'select_option') {
      const selects = allElements.filter(el => el.tagName === 'select' || el.roleHint === 'listbox');
      const others = allElements.filter(el => el.tagName !== 'select' && el.roleHint !== 'listbox');

      // Return select elements first for dropdown operations
      return [...selects, ...others];
    }

    // For 'click' actions, use default ordering
    return allElements;
  }

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

    const uniqueElements = Array.from(unique.values());

    // Dynamic prioritization: Sort elements to prioritize inputs over selects/dropdowns for better execution flow
    // This ensures accurate clicks by putting actionable inputs first in the JSON list
    return uniqueElements.sort((a, b) => {
        // Prioritize input/textarea elements over select elements
        const aIsInput = a.tagName === 'input' || a.tagName === 'textarea';
        const bIsInput = b.tagName === 'input' || b.tagName === 'textarea';
        const aIsSelect = a.tagName === 'select' || a.roleHint === 'listbox';
        const bIsSelect = b.tagName === 'select' || b.roleHint === 'listbox';

        if (aIsInput && !bIsInput) return -1; // a (input) comes first
        if (!aIsInput && bIsInput) return 1;  // b (input) comes first
        if (aIsSelect && !bIsSelect) return 1; // a (select) comes after inputs
        if (!aIsSelect && bIsSelect) return -1; // b (select) comes after inputs

        // For same type, maintain original order
        return 0;
    });
  }

  private async extractFromScope(scope: Page | Frame): Promise<ElementInfo[]> {
    // 1. ENHANCED: Expanded Selector list to catch EVERYTHING including dropdown triggers
    // This is critical for finding dropdowns that might be hidden in custom components
    const handles = await scope.$$(
      [
        'button', 'a', 'input:not([type="hidden"])', 'textarea', 'select',
        '[role=button]', '[role=link]', '[role="checkbox"]', '[role="switch"]',
        '[role="menuitem"]', '[role="option"]', '[role="listbox"]', '[role="menu"]',
        '[role="combobox"]', '[role="searchbox"]',
        '[onclick]', '[class*="btn" i]', '[class*="button" i]',
        '[class*="dropdown" i]', '[class*="menu" i]', '[class*="option" i]',
        '[class*="select" i]', '[class*="filter" i]', '[class*="sort" i]',
        '.dropdown-item', '.MuiMenuItem-root', '.ant-select-item-option-content',
        'li', 'div[onclick]', 'span[onclick]',
        '[contenteditable]', '[tabindex]:not([tabindex="-1"])',
        '[data-testid*="dropdown" i]', '[data-testid*="select" i]',
        '[aria-haspopup="listbox"]', '[aria-haspopup="menu"]',
        'div[role="button"]', 'span[role="button"]'
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

        // Enhanced Label Resolution Strategy for better input identification
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

        // Additional heuristic: Check for nearby text elements that might indicate the field purpose
        if (!label && (tagName === 'input' || tagName === 'select')) {
            // Look for text in adjacent elements or parent containers
            const nearbyTexts = [];
            let parent = el.parentElement;
            while (parent && nearbyTexts.length < 3) {
                const siblings = Array.from(parent.children);
                for (const sibling of siblings) {
                    if (sibling !== el && (sibling as Element).textContent && (sibling as Element).textContent!.trim().length > 0 && (sibling as Element).textContent!.trim().length < 30) {
                        nearbyTexts.push((sibling as Element).textContent!.trim());
                    }
                }
                parent = parent.parentElement;
            }
            // Use the most relevant nearby text as label
            if (nearbyTexts.length > 0) {
                label = nearbyTexts.find(text => text.toLowerCase().includes('date') || text.toLowerCase().includes('start') || text.toLowerCase().includes('end')) || nearbyTexts[0];
            }
        }

        // Dynamic role hint assignment for better element classification
        let roleHint: 'button' | 'link' | 'input' | 'option' | 'listbox' | 'other' = 'other';
        if (tagName === 'input' || tagName === 'textarea') roleHint = 'input';
        else if (tagName === 'select' || getAttr('role') === 'listbox') roleHint = 'listbox';
        else if (tagName === 'button' || getAttr('role') === 'button') roleHint = 'button';
        else if (tagName === 'a') roleHint = 'link';
        else if (tagName === 'option') roleHint = 'option';

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
            roleHint,
            checked: (tagName === 'input' && inputType === 'checkbox') ? el.checked : undefined,
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
          let sibling: Element | null = current;
          let nth = 1;
          while (sibling && (sibling = sibling.previousElementSibling)) {
              if ((sibling as Element).tagName.toLowerCase() === selector) nth++;
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
