import { Page, Locator, ElementHandle } from 'playwright';

export interface DropdownSelectionResult {
  optionSelector?: string;
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
 * Optimized trigger resolution.
 * "trigger" may be:
 * - a selector (best)
 * - visible text for a control (button/combobox)
 * - visible text for a label adjacent to a control
 */
async function resolveTrigger(page: Page, trigger: string): Promise<Locator> {
  const raw = (trigger || '').trim();
  if (!raw) return page.locator('body');

  try {
    const asSelector = page.locator(raw).first();
    if (await asSelector.count() > 0) return asSelector;
  } catch {} // eslint-disable-line no-empty

  const rx = new RegExp(escapeRegexLiteral(raw), 'i');

  // Prefer actual interactive controls if the trigger text matches their accessible name.
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

  // Fallback: any text node (often a <label> or <span> near the dropdown)
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
 * CORE OPTIMIZATION:
 * Uses Playwright's locator composition (.or) to check multiple strategies in parallel
 * rather than waiting for them sequentially.
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

  // --- STRATEGY 2: Scoped Text Search (Medium) ---
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

  throw new Error(`Unable to select option "${text}" using visual strategies`);
}

export async function selectFromDropdown(
  page: Page,
  trigger: string,
  optionText: string,
): Promise<DropdownSelectionResult> {
  const triggerLocator = await resolveTrigger(page, trigger);
  const controlLocator = await resolveDropdownControl(page, triggerLocator);

  // 1) NATIVE <select> (highest priority, most reliable)
  const isNative = await controlLocator
    .evaluate((el) => el.tagName.toLowerCase() === 'select')
    .catch(() => false);

  if (isNative) {
    await controlLocator.selectOption({ label: optionText });
    return { method: 'native-select' };
  }

  // 2) Custom dropdowns
  // Key fix: do NOT hard-require a particular overlay container to appear.
  // Many sites (esp. nav menus) don't use listbox/menu roles or common overlay classes.
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

  let lastErr: unknown;

  for (let attempt = 0; attempt < openAttempts.length; attempt++) {
    try {
      await openAttempts[attempt]();

      // Try selecting right away; if the dropdown didn't open, this will fail and we'll retry.
      const localScope = controlLocator
        .locator('xpath=ancestor::*[self::li or self::nav or self::header or self::form or self::section or self::div][1]')
        .first();

      try {
        return await selectOptionByStrategies(page, optionText, localScope);
      } catch (e) {
        // If scoping was too narrow (or locator not stable), retry unscoped.
        try {
          return await selectOptionByStrategies(page, optionText);
        } catch (e2) {
          lastErr = e2;
        }
      }
    } catch (e) {
      lastErr = e;
    }
  }

  // 3) Keyboard fallback (works for searchable combos / select2-like widgets)
  try {
    await controlLocator.click({ timeout: 1000 }).catch(() => {});
    await page.keyboard.type(optionText);
    await page.waitForTimeout(200);
    await page.keyboard.press('Enter');
    return { method: 'keyboard' };
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

    let optionLabel = '';
    const selectIdx = lower.indexOf('select');
    if (selectIdx >= 0) {
        const afterSelect = raw.slice(selectIdx + 'select'.length);
        const quotedNearSelect = afterSelect.match(/["\'“”]([^"\'“”]{2,})["\'“”]/);
        if (quotedNearSelect) {
            optionLabel = quotedNearSelect[1].trim();
        }
    }

    if (!optionLabel) {
         // Simple fallback regex
        const m = lower.match(/select\s+(.+?)\s+(?:from|option)/);
        if (m && m[1]) optionLabel = m[1].trim();
    }

    if (!optionLabel) return null;

    // Detect dropdown label if present
    let dropdownLabel = '';
    const parts = raw.split(/drop\s*down|dropdown/i);
    if (parts.length > 1 && parts[0].length > 10) {
         // extract label from "Click X dropdown"
         const words = parts[0].split(' ');
         dropdownLabel = words.slice(-3).join(' ').replace(/click|on|the|open/gi, '').trim();
    }

    if (dropdownLabel) {
        return { kind: 'open-and-select', dropdownLabel, optionLabel };
    }
    return { kind: 'select-only', optionLabel };
}