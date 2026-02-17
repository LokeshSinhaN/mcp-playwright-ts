import { Page, Locator, ElementHandle } from 'playwright';

export interface DropdownSelectionResult {
  /** CSS selector for the dropdown control (derived from the DOM, not hard-coded). */
  controlSelector?: string;
  /** CSS selector for the clicked option (when we were able to click an explicit option element). */
  optionSelector?: string;
  /** What we typed to select the option (useful for downstream Selenium codegen). */
  typedQuery?: string;
  method: 'click' | 'keyboard' | 'native-select' | 'js-dispatch';
}

function escapeRegexLiteral(raw: string): string {
  // Escape RegExp literal characters without relying on a RegExp (avoids edge-case escaping bugs).
  const specials = new Set(['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']);
  let out = '';
  for (const ch of raw) {
    out += specials.has(ch) ? '\\' + ch : ch;
  }
  return out;
}

function buildTypeaheadQuery(optionText: string): string {
  const raw = String(optionText || '').trim();
  if (!raw) return '';

  // Normalize whitespace so we can type a stable prefix.
  const normalized = raw.replace(/\s+/g, ' ');

  // Numbers / codes: first token is usually the differentiator (e.g., "5 miles" -> "5").
  const firstToken = normalized.split(' ')[0] || normalized;
  if (/^[0-9]+$/.test(firstToken)) return firstToken;

  // Conservative default (used when we cannot inspect <option> text).
  // Keep it short to avoid native select typeahead buffer edge cases.
  const max = 18;
  return normalized.length <= max ? normalized : normalized.slice(0, max);
}

function longestCommonPrefixLen(a: string, b: string): number {
  const al = a.length;
  const bl = b.length;
  const n = Math.min(al, bl);
  let i = 0;
  for (; i < n; i++) {
    if (a[i] !== b[i]) break;
  }
  return i;
}

function computeUniquePrefix(target: string, all: string[], minLen = 2, maxLen = 30): string {
  const t = String(target || '');
  if (!t) return '';

  const tLower = t.toLowerCase();
  let needed = minLen;
  for (const other of all) {
    const o = String(other || '');
    if (!o) continue;
    if (o.toLowerCase() === tLower) continue;
    const lcp = longestCommonPrefixLen(tLower, o.toLowerCase());
    needed = Math.max(needed, lcp + 1);
  }

  const len = Math.max(minLen, Math.min(maxLen, Math.min(needed, t.length)));
  return t.slice(0, len).trimEnd();
}

async function findBestNativeSelectForOption(
  page: Page,
  optionText: string,
  triggerHint?: string,
): Promise<{ locator: Locator; selector: string } | null> {
  const want = String(optionText || '').trim().toLowerCase();
  if (!want) return null;

  const hint = String(triggerHint || '').trim().toLowerCase();

  const handle = await page
    .evaluateHandle(({ want, hint }) => {
      const isVisible = (el: Element): boolean => {
        const h = el as HTMLElement;
        if (!h) return false;
        const style = window.getComputedStyle(h);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = h.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return false;
        return true;
      };

      const selects = Array.from(document.querySelectorAll('select')).filter(isVisible) as HTMLSelectElement[];
      if (selects.length === 0) return null;

      let best: { el: HTMLSelectElement; score: number } | null = null;

      for (const sel of selects) {
        const opts = Array.from(sel.options || []).map(o => (o.textContent || '').trim());
        const optsLower = opts.map(t => t.toLowerCase());

        const contains = optsLower.some(t => t.includes(want));
        if (!contains) continue;

        let score = 100;

        // Prefer selects whose current/first option matches the "click to select..." style hint.
        const firstOpt = optsLower[0] || '';
        const selectedOpt = (sel.selectedOptions && sel.selectedOptions[0] && (sel.selectedOptions[0].textContent || '').trim().toLowerCase()) || '';
        const meta = `${sel.id || ''} ${(sel.getAttribute('name') || '')} ${(sel.getAttribute('aria-label') || '')}`.toLowerCase();

        if (hint) {
          if (firstOpt.includes(hint) || selectedOpt.includes(hint) || meta.includes(hint)) score += 15;
          // weak keyword matching
          const keywords = hint.split(/\s+/).filter(Boolean).slice(0, 4);
          const kwHits = keywords.filter(k => k.length >= 3 && (firstOpt.includes(k) || selectedOpt.includes(k) || meta.includes(k))).length;
          score += kwHits * 5;
        }

        // Prefer selects nearer the top (often filter controls)
        const rect = sel.getBoundingClientRect();
        score += Math.max(0, 20 - Math.min(20, Math.floor(rect.top / 50)));

        if (!best || score > best.score) best = { el: sel, score };
      }

      return best?.el || null;
    }, { want, hint })
    .catch(() => null);

  const el = handle?.asElement();
  if (!el) return null;

  const selector = await generateCssForHandle(el);
  const loc = page.locator(selector).first();
  if ((await loc.count().catch(() => 0)) === 0) return null;

  return { locator: loc, selector };
}

/**
 * Generate a robust, reasonably-specific CSS selector for an element handle.
 * This must be dynamic (derived from the DOM), not hard-coded per-site.
 */
async function generateCssForHandle(handle: ElementHandle): Promise<string> {
  return handle.evaluate((el: any) => {
    const esc = (s: string) => {
      try { return CSS.escape(s); } catch { return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }
    };

    const tag = String(el.tagName || '').toLowerCase();
    if (!tag) return 'body';

    // 1) Best: stable unique-ish attributes
    if (el.id) return `#${esc(el.id)}`;
    if (el.dataset?.testid) return `[data-testid="${esc(el.dataset.testid)}"]`;

    const name = el.getAttribute?.('name');
    if (name) return `${tag}[name="${esc(name)}"]`;

    const aria = el.getAttribute?.('aria-label');
    if (aria) return `${tag}[aria-label="${esc(aria)}"]`;

    const role = el.getAttribute?.('role');
    if (role && aria) return `${tag}[role="${esc(role)}"][aria-label="${esc(aria)}"]`;

    // 2) Fallback: short CSS path with nth-of-type to reduce ambiguity
    const parts: string[] = [];
    let cur: Element | null = el;
    let hops = 0;

    while (cur && cur !== document.body && hops++ < 6) {
      const t = cur.tagName.toLowerCase();
      if ((cur as any).id) {
        parts.unshift(`#${esc((cur as any).id)}`);
        break;
      }

      let seg = t;
      const cls = (cur.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) seg += `.${cls.map(esc).join('.')}`;

      const parent = cur.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => (c as Element).tagName.toLowerCase() === t);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(cur) + 1;
          seg += `:nth-of-type(${idx})`;
        }
      }

      parts.unshift(seg);
      cur = cur.parentElement;
    }

    return parts.join(' > ') || tag;
  });
}

/**
 * Optimized trigger resolution with DYNAMIC fallback strategies.
 * "trigger" may be:
 * - a selector (best)
 * - visible text for a control (button/combobox)
 * - visible text for a label adjacent to a control
 * - partial text match (e.g., "Distance" matches "Distance (miles)")
 */
async function resolveTrigger(page: Page, trigger: string): Promise<Locator> {
  const raw = (trigger || '').trim();
  if (!raw) return page.locator('body');

  // STRATEGY 1: Direct selector
  try {
    const asSelector = page.locator(raw).first();
    if (await asSelector.count() > 0) return asSelector;
  } catch {} // eslint-disable-line no-empty

  const rx = new RegExp(escapeRegexLiteral(raw), 'i');

  // STRATEGY 2: Role-based (most reliable for standard dropdowns)
  const roleCandidates: Locator[] = [
    page.getByRole('combobox', { name: rx }).first(),
    page.getByRole('button', { name: rx }).first(),
    page.getByRole('textbox', { name: rx }).first(),
    page.getByRole('link', { name: rx }).first(),
    page.getByRole('menuitem', { name: rx }).first(),
  ];

  for (const candidate of roleCandidates) {
    try {
      if (await candidate.count() > 0) return candidate;
    } catch {} // eslint-disable-line no-empty
  }

  // STRATEGY 3: Text-based search (handles custom dropdowns)
  try {
    const textMatch = page.getByText(raw, { exact: false }).first();
    if (await textMatch.count() > 0) return textMatch;
  } catch {} // eslint-disable-line no-empty

  // STRATEGY 4: DYNAMIC - Search for ANY button/div containing the trigger text (partial match)
  // This handles cases like "Distance" matching "Distance (miles)" or "Distance Filter"
  try {
    const partialMatch = page.locator(`button:has-text("${raw}"), [role="button"]:has-text("${raw}"), div[class*="select"]:has-text("${raw}"), div[class*="dropdown"]:has-text("${raw}")`).first();
    if (await partialMatch.count() > 0) return partialMatch;
  } catch {} // eslint-disable-line no-empty

  // STRATEGY 5: FALLBACK - Search for ANY interactive element with partial text match
  // This is the most permissive but ensures we find SOMETHING
  try {
    const fallback = page.locator(`button, [role="button"], [role="combobox"], select, input[type="select"], div[class*="dropdown"], div[class*="select"]`).filter({ hasText: rx }).first();
    if (await fallback.count() > 0) return fallback;
  } catch {} // eslint-disable-line no-empty

  // Last resort: any text node
  return page.getByText(raw, { exact: false }).first();
}

async function resolveDropdownControl(page: Page, triggerLocator: Locator): Promise<Locator> {
  // If the trigger IS already a control, use it.
  const isDirectControl = await triggerLocator
    .evaluate((el) => {
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role') || '';
      return tag === 'select' || tag === 'input' || tag === 'button' || role === 'combobox' || role === 'listbox';
    })
    .catch(() => false);

  if (isDirectControl) return triggerLocator;

  // Common case: trigger contains the control (e.g., custom component)
  try {
    const nested = triggerLocator.locator('select, [role="combobox"], input, button').first();
    if (await nested.count() > 0) return nested;
  } catch {} // eslint-disable-line no-empty

  // Common case: label text is separate from the <select>. Try resolving a nearby control in the DOM.
  const handle = await triggerLocator.elementHandle().catch(() => null);
  if (!handle) return triggerLocator;

  const controlHandle = await handle.evaluateHandle((node: any) => {
    const isControl = (el: Element | null): boolean => {
      if (!el) return false;
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role') || '';
      return tag === 'select' || tag === 'input' || tag === 'button' || role === 'combobox' || role === 'listbox';
    };

    // If it's a <label for="...">, resolve the linked control.
    if (node?.tagName?.toLowerCase?.() === 'label') {
      const f = node.getAttribute('for');
      if (f) {
        const byId = document.getElementById(f);
        if (isControl(byId)) return byId;
      }
    }

    // Walk siblings starting from a "block" container (often <p>, <li>, <div>)
    const block = node?.closest?.('p, li, div, label, span') || node;
    let cur: Element | null = block;
    for (let i = 0; i < 6 && cur; i++) {
      const next = cur.nextElementSibling;
      if (!next) break;

      if (isControl(next)) return next;
      const inside = next.querySelector('select, [role="combobox"], input, button');
      if (isControl(inside)) return inside;

      cur = next;
    }

    // Fallback: search within nearest form for the closest control that follows the label in DOM order.
    const form = (node as Element | null)?.closest?.('form');
    if (form) {
      const all = Array.from(form.querySelectorAll('select, [role="combobox"], input, button'));
      const n = node as Element;
      const following = all.find((el) => {
        try {
          return Boolean(n.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
        } catch {
          return false;
        }
      });
      if (following) return following;
      if (all.length) return all[0];
    }

    return node;
  });

  const el = controlHandle.asElement();
  if (!el) return triggerLocator;

  const selector = await generateCssForHandle(el);
  const loc = page.locator(selector).first();
  if (await loc.count().catch(() => 0) > 0) return loc;
  return triggerLocator;
}

/**
 * CORE OPTIMIZATION: Dynamic option selection with multiple strategies
 * Handles ANY dropdown implementation without hard-coded selectors
 */
async function selectOptionByStrategies(
  page: Page,
  optionText: string,
  scope?: Locator,
): Promise<DropdownSelectionResult> {
  const text = optionText.trim();
  const escapedText = escapeRegexLiteral(text);
  const regex = new RegExp(escapedText, 'i');

  // --- STRATEGY 1: Smart Locator Composition (Fastest) ---
  // Look for the option using common roles OR specific class/text combinations simultaneously.
  const optionSelectorList = [
    // Official roles
    `[role="option"]:has-text("${text}")`,
    `[role="menuitem"]:has-text("${text}")`,
    `[role="button"]:has-text("${text}")`,
    // Links are extremely common in menus/nav dropdowns
    `a:has-text("${text}")`,
    // Common dropdown item classes (Bootstrap, Material, AntD, etc.)
    `.dropdown-item:has-text("${text}")`,
    `.MuiMenuItem-root:has-text("${text}")`,
    `.ant-select-item-option-content:has-text("${text}")`,
    // Generic list items in menus
    `li:has-text("${text}")`,
  ].join(', ');

  const optionLocator = (scope ?? page).locator(optionSelectorList).first();

  try {
    if (await optionLocator.count() > 0 && await optionLocator.isVisible()) {
      const handle = await optionLocator.elementHandle();
      const selector = handle ? await generateCssForHandle(handle) : undefined;
      await optionLocator.click({ timeout: 1500 });
      return { method: 'click', optionSelector: selector };
    }
  } catch {} // eslint-disable-line no-empty

  // --- STRATEGY 2: Scoped Text Search in Overlay Containers (Medium) ---
  // Instead of scanning the whole page, scan only likely overlay containers.
  const overlayContainers = page.locator([
    '[role="listbox"]', '[role="menu"]',
    '.dropdown-menu', '.popover', '.tooltip',
    '.MuiPopover-root', '.MuiMenu-root',
    '.ant-select-dropdown',
    'dialog',
  ].join(', '));

  if (await overlayContainers.count().catch(() => 0) > 0) {
    try {
      const target = overlayContainers.getByText(regex).first();
      if (await target.isVisible()) {
        const handle = await target.elementHandle();
        const selector = handle ? await generateCssForHandle(handle) : undefined;
        await target.click({ force: true, timeout: 1500 });
        return { method: 'click', optionSelector: selector };
      }
    } catch {} // eslint-disable-line no-empty
  }

  // --- STRATEGY 3: DYNAMIC - Find ANY visible element containing the option text ---
  // This is more permissive and handles custom dropdown implementations
  try {
    const allVisibleElements = await page.evaluate((searchText: string) => {
      const regex = new RegExp(searchText, 'i');
      const allElements = Array.from(document.querySelectorAll('*'));
      
      // Filter to only visible elements that contain the text
      const matches = allElements.filter(el => {
        const style = window.getComputedStyle(el);
        const htmlElement = el as HTMLElement;
        
        // Check visibility
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (htmlElement.offsetWidth === 0 || htmlElement.offsetHeight === 0) return false;
        
        // Check if text matches
        const text = el.textContent || '';
        if (!regex.test(text)) return false;
        
        // Prefer elements that are direct containers (not too deep in hierarchy)
        // and have reasonable text length (not the whole page)
        const textLength = text.trim().length;
        return textLength > 0 && textLength < 200;
      });

      // Return the first match with its selector info
      if (matches.length > 0) {
        const el = matches[0] as HTMLElement;
        return {
          tag: el.tagName.toLowerCase(),
          text: el.textContent?.trim().substring(0, 50),
          classes: el.className,
          id: el.id,
          found: true
        };
      }
      return { found: false };
    }, text);

    if (allVisibleElements.found) {
      // Now try to click it using getByText which is more reliable
      try {
        const textLocator = page.getByText(regex, { exact: false }).first();
        if (await textLocator.count() > 0 && await textLocator.isVisible()) {
          const handle = await textLocator.elementHandle();
          const selector = handle ? await generateCssForHandle(handle) : undefined;
          await textLocator.click({ timeout: 1500 });
          return { method: 'click', optionSelector: selector };
        }
      } catch {} // eslint-disable-line no-empty
    }
  } catch {} // eslint-disable-line no-empty

  // --- STRATEGY 3B: ENHANCED - Find clickable parent of text element ---
  // Sometimes the text is in a span/div but the clickable element is the parent
  try {
    const clickableParent = await page.evaluate((searchText: string) => {
      const regex = new RegExp(searchText, 'i');
      const allElements = Array.from(document.querySelectorAll('*'));
      
      // Find element with matching text
      const textElement = allElements.find(el => {
        const style = window.getComputedStyle(el);
        const htmlElement = el as HTMLElement;
        
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (htmlElement.offsetWidth === 0 || htmlElement.offsetHeight === 0) return false;
        
        const text = el.textContent || '';
        if (!regex.test(text)) return false;
        
        const textLength = text.trim().length;
        return textLength > 0 && textLength < 200;
      });

      if (!textElement) return null;

      // Walk up the DOM to find a clickable parent (button, div with onclick, etc.)
      let current: Element | null = textElement;
      let depth = 0;
      while (current && depth < 5) {
        const style = window.getComputedStyle(current);
        const htmlElement = current as HTMLElement;
        
        // Check if this element is clickable
        const isClickable = 
          current.tagName.toLowerCase() === 'button' ||
          current.tagName.toLowerCase() === 'a' ||
          current.getAttribute('role') === 'button' ||
          current.getAttribute('role') === 'option' ||
          current.getAttribute('role') === 'menuitem' ||
          (htmlElement).onclick !== null ||
          current.getAttribute('onclick') !== null ||
          style.cursor === 'pointer';

        if (isClickable && style.display !== 'none' && style.visibility !== 'hidden') {
          return {
            tag: current.tagName.toLowerCase(),
            classes: current.className,
            id: current.id,
            found: true
          };
        }

        current = current.parentElement;
        depth++;
      }

      return null;
    }, text);

    if (clickableParent?.found) {
      try {
        const textLocator = page.getByText(regex, { exact: false }).first();
        if (await textLocator.count() > 0) {
          // Find the clickable parent
          const clickableElement = textLocator.locator('xpath=ancestor::button | ancestor::a | ancestor::*[@role="button"] | ancestor::*[@role="option"] | ancestor::*[@role="menuitem"]').first();
          if (await clickableElement.count() > 0 && await clickableElement.isVisible()) {
            const handle = await clickableElement.elementHandle();
            const selector = handle ? await generateCssForHandle(handle) : undefined;
            await clickableElement.click({ timeout: 1500 });
            return { method: 'click', optionSelector: selector };
          }
        }
      } catch {} // eslint-disable-line no-empty
    }
  } catch {} // eslint-disable-line no-empty

  // --- STRATEGY 4: FALLBACK - Keyboard navigation ---
  // If visual selection fails, try keyboard navigation (arrow keys + enter)
  try {
    // Type the option text to filter/search
    await page.keyboard.type(text.substring(0, 3)); // Type first 3 chars
    await page.waitForTimeout(300);
    
    // Press Enter to select
    await page.keyboard.press('Enter');
    return { method: 'keyboard' };
  } catch {} // eslint-disable-line no-empty

  throw new Error(`Unable to select option "${text}" using any strategy`);
}

export async function selectFromDropdown(
  page: Page,
  trigger: string,
  optionText: string,
): Promise<DropdownSelectionResult> {
  // Wait for page to be stable before interacting with dropdown
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 });
  } catch {}
  
  // Additional wait for any dynamic content
  await page.waitForTimeout(500);
  
  const triggerLocator = await resolveTrigger(page, trigger);
  let controlLocator = await resolveDropdownControl(page, triggerLocator);

  // HARDENING: Many pages expose the dropdown as a native <select>, but the LLM may point at a nearby label/div.
  // If we can find a visible <select> whose options contain the desired optionText, prefer it.
  const bestNative = await findBestNativeSelectForOption(page, optionText, trigger).catch(() => null);
  if (bestNative) {
    controlLocator = bestNative.locator;
  }

  // Capture a dynamic selector for the control for downstream codegen.
  const controlHandle = await controlLocator.elementHandle().catch(() => null);
  const controlSelector = controlHandle ? await generateCssForHandle(controlHandle) : (bestNative?.selector || undefined);

  // 1) NATIVE <select> (highest priority, most reliable)
  const isNative = await controlLocator
    .evaluate((el) => el.tagName.toLowerCase() === 'select')
    .catch(() => false);

  if (isNative) {
    // IMPORTANT: CyberMed-like pages often use a native <select> where options are in a single container.
    // The most human-like, reliable approach is: click -> typeahead -> Enter.

    // Try to compute a UNIQUE prefix from real <option> text to disambiguate similar labels.
    const nativeInfo = await controlLocator
      .evaluate((select: any, want: string) => {
        const wantLower = String(want || '').trim().toLowerCase();
        const options = Array.from(select?.options || []) as HTMLOptionElement[];
        const texts = options.map(o => (o.textContent || '').trim());
        const textsLower = texts.map(t => t.toLowerCase());
        const idx = textsLower.findIndex(t => t.includes(wantLower));
        return {
          found: idx >= 0,
          optionText: idx >= 0 ? texts[idx] : null,
          optionValue: idx >= 0 ? options[idx].value : null,
          allTexts: texts,
          selectedText: (() => {
            const opt = (select?.selectedOptions && select.selectedOptions[0]) || null;
            return String(opt?.textContent || opt?.label || select?.value || '').trim();
          })(),
        };
      }, optionText)
      .catch(() => ({ found: false, optionText: null, optionValue: null, allTexts: [], selectedText: '' }));

    const query = nativeInfo.found && nativeInfo.optionText
      ? computeUniquePrefix(nativeInfo.optionText, nativeInfo.allTexts, 3, 32) || buildTypeaheadQuery(optionText)
      : buildTypeaheadQuery(optionText);

    await controlLocator.click({ timeout: 1500 }).catch(() => {});
    await page.waitForTimeout(150);
    await controlLocator.focus({ timeout: 1500 }).catch(() => {});
    // Allow native select typeahead buffer to reset between retries
    await page.waitForTimeout(450);

    if (query) {
      await page.keyboard.type(query, { delay: 40 });
      await page.waitForTimeout(200);
    }

    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);

    // Verify selection and, if needed, apply a dynamic JS fallback to trigger onchange/postback.
    const verify = async (): Promise<boolean> => {
      const selectedText = await controlLocator.evaluate((select: any) => {
        const opt = (select?.selectedOptions && select.selectedOptions[0]) || null;
        return String(opt?.textContent || opt?.label || select?.value || '').trim();
      });
      const selLower = String(selectedText || '').toLowerCase();
      const wantLower = String(optionText || '').trim().toLowerCase();
      return !!selLower && !!wantLower && selLower.includes(wantLower);
    };

    let ok = await verify().catch(() => false);

    if (!ok) {
      await controlLocator.evaluate((select: any, want: string) => {
        const wantLower = String(want || '').trim().toLowerCase();
        const options = Array.from(select?.options || []) as HTMLOptionElement[];
        const match = options.find(opt => (opt.textContent || '').trim().toLowerCase().includes(wantLower));
        if (match) {
          select.value = match.value;
          select.dispatchEvent(new Event('input', { bubbles: true }));
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, optionText);

      await page.waitForTimeout(300);
      ok = await verify().catch(() => false);
    }

    if (!ok) {
      throw new Error(`Dropdown selection did not take effect for option: ${optionText}`);
    }

    // Many server-rendered apps (ASP.NET style) update the page after a select changes.
    // Give the postback/XHR a moment so downstream fields (e.g., date inputs) become visible.
    try {
      await page.waitForLoadState('networkidle', { timeout: 3000 });
    } catch {}

    return { method: 'keyboard', controlSelector, typedQuery: query };
  }

  // 2) Custom dropdowns - Try keyboard input FIRST as it's most reliable
  // Keyboard input works for: native selects, searchable dropdowns, autocomplete, etc.
  
  // STRATEGY A: Keyboard input (FASTEST & MOST RELIABLE for native selects)
  // CRITICAL: Must open dropdown FIRST, then use keyboard
  try {
    // Step 1: Click to open the dropdown
    await controlLocator.click({ timeout: 1000 }).catch(() => {});
    await page.waitForTimeout(200);
    
    // Step 2: Focus the dropdown
    await controlLocator.focus({ timeout: 1000 }).catch(() => {});
    await page.waitForTimeout(100);
    
    // Step 3: Type the option text (first 3 chars usually enough to filter)
    const searchText = buildTypeaheadQuery(optionText) || optionText.substring(0, 3);
    await page.keyboard.type(searchText, { delay: 50 });
    await page.waitForTimeout(300);
    
    // Step 4: Press Enter to select
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    
    return { method: 'keyboard', controlSelector, typedQuery: searchText };
  } catch (e1) {
    // Continue to visual strategies if keyboard fails
  }

  // STRATEGY B: Click-based opening with visual selection
  const openAttempts: Array<() => Promise<void>> = [
    async () => { await controlLocator.click({ timeout: 2000 }); },
    async () => { await controlLocator.click({ timeout: 2000, force: true }); },
    async () => { await controlLocator.dispatchEvent('click'); },
    async () => {
      await controlLocator.focus().catch(() => {});
      await page.keyboard.press('Enter').catch(() => {});
    },
    async () => {
      await controlLocator.focus().catch(() => {});
      await page.keyboard.press('Space').catch(() => {});
    },
    async () => {
      await controlLocator.focus().catch(() => {});
      await page.keyboard.press('ArrowDown').catch(() => {});
    },
  ];

  // Wait for dropdown options to appear after opening
  const waitForDropdownOptions = async (): Promise<boolean> => {
    try {
      // Wait up to 2 seconds for any dropdown options to appear
      await page.waitForFunction(() => {
        const options = Array.from(document.querySelectorAll('[role="option"], [role="menuitem"], .dropdown-item, .MuiMenuItem-root, .ant-select-item-option-content, li:has(a), a, button, span, div'));
        for (const option of options) {
          const style = window.getComputedStyle(option);
          const htmlElement = option as HTMLElement;
          if (style.display !== 'none' && style.visibility !== 'hidden' && htmlElement.offsetWidth > 0 && htmlElement.offsetHeight > 0) {
            const text = (option.textContent || '').trim();
            if (text.length > 0 && text.length < 100) {
              return true;
            }
          }
        }
        return false;
      }, { timeout: 2000 });
      return true;
    } catch {
      return false;
    }
  };

  let lastErr: unknown;

  for (let attempt = 0; attempt < openAttempts.length; attempt++) {
    try {
      await openAttempts[attempt]();

      // Wait for dropdown options to appear
      const optionsVisible = await waitForDropdownOptions();
      if (!optionsVisible) continue; // Try next opening method

      // Try selecting right away
      const localScope = controlLocator
        .locator('xpath=ancestor::*[self::li or self::nav or self::header or self::form or self::section or self::div][1]')
        .first();

      try {
        const res = await selectOptionByStrategies(page, optionText, localScope);
        return { ...res, controlSelector };
      } catch (e) {
        // If scoping was too narrow, retry unscoped
        try {
          const res2 = await selectOptionByStrategies(page, optionText);
          return { ...res2, controlSelector };
        } catch (e2) {
          lastErr = e2;
        }
      }
    } catch (e) {
      lastErr = e;
    }
  }

  // STRATEGY C: Final keyboard fallback with arrow keys
  try {
    await controlLocator.focus({ timeout: 1000 }).catch(() => {});
    await page.waitForTimeout(100);
    
    // Try arrow down to navigate options
    const searchText = optionText.substring(0, 1).toUpperCase();
    await page.keyboard.type(searchText, { delay: 50 });
    await page.waitForTimeout(200);
    
    // Press Enter to select
    await page.keyboard.press('Enter');
    return { method: 'keyboard', controlSelector, typedQuery: searchText };
  } catch (e) {
    lastErr = e;
  }

  throw new Error(
    `Unable to select option "${optionText}" from dropdown "${trigger}". Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
  );
}

export async function selectOptionInOpenDropdown(
  page: Page,
  optionText: string,
): Promise<DropdownSelectionResult> {
  return selectOptionByStrategies(page, optionText);
}

// (Keep your existing parseDropdownInstruction function here)
export type DropdownIntent =
  | { kind: 'open-and-select'; dropdownLabel: string; optionLabel: string }
  | { kind: 'select-only'; optionLabel: string };

export function parseDropdownInstruction(prompt: string): DropdownIntent | null {
    const raw = (prompt || '').trim();
    if (!raw) return null;
    const lower = raw.toLowerCase();
    if (!/\bselect\b/i.test(lower)) return null;

    const norm = (s: string) => String(s || '').replace(/\s+/g, ' ').trim();

    let optionLabel = '';
    const selectIdx = lower.indexOf('select');
    if (selectIdx >= 0) {
        const afterSelect = raw.slice(selectIdx + 'select'.length);
        const quotedNearSelect = afterSelect.match(/["\'“”]([^"\'“”]{2,})["\'“”]/);
        if (quotedNearSelect) {
            optionLabel = norm(quotedNearSelect[1]);
        }
    }

    if (!optionLabel) {
         // Simple fallback regex
        const m = lower.match(/select\s+(.+?)\s+(?:from|option)/);
        if (m && m[1]) optionLabel = norm(m[1]);
    }

    if (!optionLabel) return null;

    // Detect dropdown label if present
    let dropdownLabel = '';
    const parts = raw.split(/drop\s*down|dropdown/i);
    if (parts.length > 1 && parts[0].length > 10) {
         // extract label from "Click X dropdown"
         const words = parts[0].split(' ');
         dropdownLabel = norm(words.slice(-3).join(' ').replace(/click|on|the|open/gi, ''));
    }

    if (dropdownLabel) {
        return { kind: 'open-and-select', dropdownLabel, optionLabel };
    }
    return { kind: 'select-only', optionLabel };
}