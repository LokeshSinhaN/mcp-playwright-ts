import { Page, Locator, ElementHandle } from 'playwright';

export interface DropdownSelectionResult {
  optionSelector?: string;
  method: 'click' | 'keyboard' | 'native-select' | 'js-dispatch';
}

/**
 * Generate a robust CSS selector for an element handle.
 */
async function generateCssForHandle(handle: ElementHandle): Promise<string> {
  return handle.evaluate((el: any) => {
    // 1. Prefer ID
    if (el.id) return `#${CSS.escape(el.id)}`;
    
    // 2. Prefer specific data attributes
    if (el.dataset.testid) return `[data-testid="${CSS.escape(el.dataset.testid)}"]`;
    
    // 3. Fallback to simplified path
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    const aria = el.getAttribute('aria-label');
    if (role && aria) return `${tag}[role="${role}"][aria-label="${CSS.escape(aria)}"]`;
    
    return tag; // Return tag as minimal valid selector (caller usually needs specific handle anyway)
  });
}

/**
 * Optimized trigger resolution.
 */
async function resolveTrigger(page: Page, trigger: string): Promise<Locator> {
  try {
    // fast check if it's a valid selector
    const asSelector = page.locator(trigger).first();
    if (await asSelector.count() > 0) return asSelector;
  } catch {} // eslint-disable-line no-empty

  // Use a precise text match locator instead of loose regex if possible
  return page.getByText(trigger, { exact: false }).first();
}

/**
 * CORE OPTIMIZATION:
 * Uses Playwright's locator composition (.or) to check multiple strategies in parallel
 * rather than waiting for them sequentially.
 */
async function selectOptionByStrategies(page: Page, optionText: string): Promise<DropdownSelectionResult> {
  const text = optionText.trim();
  const escapedText = text.replace(/[.*+?^${}()|[\\]/g, '\\$&');
  const regex = new RegExp(escapedText, 'i');

  // --- STRATEGY 1: Smart Locator Composition (Fastest) ---
  // Look for the option using common roles OR specific class/text combinations simultaneously.
  const optionLocator = page.locator([
    // Official roles
    `[role="option"]:has-text("${text}")`,
    `[role="menuitem"]:has-text("${text}")`,
    `[role="button"]:has-text("${text}")`,
    // Common dropdown item classes (Bootstrap, Material, AntD, etc.)
    `.dropdown-item:has-text("${text}")`,
    `.MuiMenuItem-root:has-text("${text}")`,
    `.ant-select-item-option-content:has-text("${text}")`,
    // Generic list items in menus
    `li:has-text("${text}")`
  ].join(', ')).first();

  try {
    if (await optionLocator.count() > 0 && await optionLocator.isVisible()) {
      const handle = await optionLocator.elementHandle();
      const selector = handle ? await generateCssForHandle(handle) : undefined;
      await optionLocator.click({ timeout: 1000 }); 
      return { method: 'click', optionSelector: selector };
    }
  } catch {} // eslint-disable-line no-empty

  // --- STRATEGY 2: Scoped Text Search (Medium) ---
  // Instead of scanning the whole page ('*'), scan only likely overlay containers.
  const overlayContainers = page.locator([
    '[role="listbox"]', '[role="menu"]', '.dropdown-menu', '.popover',
    '.MuiPopover-root', '.ant-select-dropdown', 'dialog'
  ].join(', '));

  if (await overlayContainers.count() > 0) {
    try {
      // Find the specific text match within any visible overlay
      const target = overlayContainers.getByText(regex).first();
      if (await target.isVisible()) {
        const handle = await target.elementHandle();
        const selector = handle ? await generateCssForHandle(handle) : undefined;
        await target.click({ force: true, timeout: 1000 });
        return { method: 'click', optionSelector: selector };
      }
    } catch {} // eslint-disable-line no-empty
  }

  // --- STRATEGY 3: Keyboard (Fallback) ---
  // If we can't find it visually, assume it's a "Filter" type dropdown.
  try {
    await page.keyboard.type(text);
    await page.waitForTimeout(200); // Short wait for UI filter to update
    await page.keyboard.press('Enter');
    return { method: 'keyboard' };
  } catch {} // eslint-disable-line no-empty
  return { method: 'keyboard' };
}

export async function selectFromDropdown(
  page: Page,
  trigger: string,
  optionText: string,
): Promise<DropdownSelectionResult> {
  const triggerLocator = await resolveTrigger(page, trigger);

  // 1. Check for NATIVE <select> (Instant check)
  // We use evaluate to check tag name to avoid round-trip overhead if not needed.
  const isNative = await triggerLocator.evaluate((el) => el.tagName.toLowerCase() === 'select').catch(() => false);

  if (isNative) {
    await triggerLocator.selectOption({ label: optionText });
    return { method: 'native-select' };
  }

  // 2. Open Dropdown
  // Try to click. If it fails, assume it might be a hover menu or already open.
  try {
    await triggerLocator.click({ timeout: 2000 });
  } catch { // eslint-disable-line no-empty
    console.log('Could not click trigger, attempting to select directly...');
  }

  // 3. Select Option (Optimized)
  // We removed the hard wait here. Playwright locators auto-wait.
  return await selectOptionByStrategies(page, optionText);
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