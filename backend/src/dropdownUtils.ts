import { Page, Locator } from 'playwright';

/**
 * Resolve a dropdown trigger either by treating the input as a selector or,
 * if that fails, as visible text. This mirrors BrowserManager.smartLocate but
 * is intentionally lightweight and synchronous so it can be reused in both
 * tools and ad-hoc scripts.
 */
async function resolveTrigger(page: Page, trigger: string): Promise<Locator> {
  const raw = trigger.trim();

  // 1) Try as-is as a CSS/xpath/text engine selector. If it resolves to at
  // least one element, use it directly.
  try {
    const asSelector = page.locator(raw).first();
    if (await asSelector.count()) {
      return asSelector;
    }
  } catch {
    // fall through and treat as plain text
  }

  // 2) Treat as visible label text.
  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const re = new RegExp(escaped, 'i');

  const candidates: Locator[] = [
    page.getByRole('button', { name: re }),
    page.getByRole('link', { name: re }),
    page.getByRole('combobox', { name: re }),
    page.getByText(re),
  ];

  for (const loc of candidates) {
    const first = loc.first();
    try {
      if (await first.count()) {
        return first;
      }
    } catch {
      // ignore and try next strategy
    }
  }

  // Fallback: last resort, let Playwright deal with it. This may still throw,
  // and callers should surface that error to the user.
  return page.locator(raw).first();
}

/**
 * Core option-selection logic shared by selectFromDropdown() and
 * selectOptionInOpenDropdown(). It assumes that any required dropdown/combobox
 * has already been opened if necessary.
 */
async function selectOptionByStrategies(page: Page, optionText: string): Promise<void> {
  // Normalise option text for regex/text locators.
  const optionEscaped = optionText.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const optionRe = new RegExp(optionEscaped, 'i');

  // Strategy 0 (primary): if the current focused element behaves like a
  // combobox or text input, prefer "type + Enter". This matches how modern
  // searchable dropdowns are designed to be used.
  const isComboboxFocused = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    return tag === 'input' || role === 'combobox' || role === 'textbox';
  });

  if (isComboboxFocused) {
    await page.keyboard.type(optionText, { delay: 100 });
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    return;
  }

  // Strategy A: semantic roles commonly used for menu options. Prefer direct
  // clicking on an explicit option/menu item when type+Enter is not available.
  const roleLocators: Locator[] = [
    page.getByRole('option',   { name: optionRe }),
    page.getByRole('menuitem', { name: optionRe }),
    page.getByRole('link',     { name: optionRe }),
    page.getByRole('button',   { name: optionRe }),
  ];

  for (const loc of roleLocators) {
    const first = loc.first();
    try {
      if (await first.count()) {
        await first.click({ timeout: 1500 });
        return;
      }
    } catch {
      // try the next strategy
    }
  }

  // Strategy B: visible text search limited to likely menu containers.
  const menuContainers = page.locator(
    [
      '[role="listbox"]',
      '[role="menu"]',
      '.dropdown-menu',
      '.menu',
      '.menu-items',
      '.select-menu',
      '.ant-select-dropdown',
      '.MuiList-root',
    ].join(', '),
  );

  try {
    const containerCount = await menuContainers.count();
    for (let i = 0; i < containerCount; i++) {
      const container = menuContainers.nth(i);
      const option = container.locator('*').filter({ hasText: optionRe }).first();
      if (await option.count()) {
        try {
          await option.click({ timeout: 1500 });
          return;
        } catch {
          // if this specific option fails, continue to keyboard fallback
          break;
        }
      }
    }
  } catch {
    // If menu containers are not found, continue to keyboard fallback.
  }

  // Strategy C (universal fallback): as a last resort for highly
  // custom/virtualized dropdowns, type the option text and press Enter even
  // when we could not positively identify a focused combobox. This still
  // leverages the common "type to filter then Enter" behaviour while avoiding
  // brittle, site-specific selectors.
  await page.keyboard.type(optionText, { delay: 50 });
  await page.keyboard.press('Enter');
}

/**
 * Attempt to select an option from a dropdown in a way that is resilient across
 * a wide variety of modern implementations:
 *   - Native <select> elements (uses selectOption by label)
 *   - ARIA combobox / listbox / menu patterns
 *   - Custom React/Vue/etc. dropdowns that respond to keyboard typing
 *
 * It deliberately avoids hard-coding site-specific selectors and instead uses:
 *   - semantic roles (option, menuitem)
 *   - visible text matching for the option label
 *   - a universal keyboard fallback (type option text + Enter)
 */
export async function selectFromDropdown(
  page: Page,
  trigger: string,
  optionText: string,
): Promise<void> {
  const triggerLocator = await resolveTrigger(page, trigger);

  // 1. Ensure the trigger is visible and clickable.
  try {
    await triggerLocator.waitFor({ state: 'visible', timeout: 5000 });
  } catch {
    // If the wait fails, we still attempt to click/press; some UIs mount late.
  }

  // 2. SPECIAL CASE: native <select> controls. Prefer selectOption() over
  // clicking menus rendered by the OS, which Playwright cannot see.
  try {
    const handle = await triggerLocator.elementHandle();
    if (handle) {
      const tagName = await handle.evaluate((el: any) => (el.tagName || '').toLowerCase());
      if (tagName === 'select') {
        // Prefer an exact visible-label match, but gracefully fall back to a
        // case-insensitive/partial option match when the label text in the DOM
        // differs slightly from the natural-language prompt (extra spaces,
        // punctuation, etc.). This avoids brittle hard-coding while still
        // strongly preferring precise matches.
        try {
          await triggerLocator.selectOption({ label: optionText });
          return;
        } catch {
          const escaped = optionText
            .trim()
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            .replace(/\s+/g, '\\s+');
          const re = new RegExp(escaped, 'i');
          const fallbackOption = triggerLocator.locator('option').filter({ hasText: re }).first();
          if (await fallbackOption.count()) {
            await fallbackOption.click({ timeout: 1500 });
            return;
          }
        }
      }

      // Some component libraries wrap <select> inside a styled container; check
      // for a descendant <select> when the trigger itself is not one.
      const innerSelect = triggerLocator.locator('select');
      if (await innerSelect.count()) {
        const firstSelect = innerSelect.first();
        try {
          await firstSelect.selectOption({ label: optionText });
          return;
        } catch {
          const escaped = optionText
            .trim()
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            .replace(/\s+/g, '\\s+');
          const re = new RegExp(escaped, 'i');
          const fallbackOption = firstSelect.locator('option').filter({ hasText: re }).first();
          if (await fallbackOption.count()) {
            await fallbackOption.click({ timeout: 1500 });
            return;
          }
        }
      }
    }
  } catch {
    // If selectOption fails, fall back to generic menu logic.
  }

  // 3. Click the trigger to open the dropdown/combobox.
  await triggerLocator.click({ timeout: 5000 });

  // Give the menu time to animate/mount.
  await page.waitForTimeout(250);

  // Ensure focus so subsequent keyboard operations go to the right widget.
  try {
    await triggerLocator.focus();
  } catch {
    // Some wrappers are not focusable; this is best-effort.
  }

  await selectOptionByStrategies(page, optionText);

  // We intentionally do not attempt to assert success here, because many UIs do
  // not update visible text in a consistent way. Callers who need verification
  // should assert on the resulting DOM state separately.
}

/**
 * Option-only helper used when the dropdown is already open (e.g. the user
 * previously clicked the dropdown button in a separate step like "Click on the
 * 'Search Specialists' dropdown button" and then asks "select the 'Payment
 * Posting' from the drop down menu"). It does not attempt to click any
 * trigger; it just selects the desired option via roles/text/keyboard.
 */
export async function selectOptionInOpenDropdown(
  page: Page,
  optionText: string,
): Promise<void> {
  await selectOptionByStrategies(page, optionText);
}

/**
 * Parse natural-language instructions of the form:
 *   "Click on the Contact us drop down button and select Facebook option"
 * into a dropdown label ("Contact us") and an option label ("Facebook").
 *
 * This is deliberately conservative: if it cannot confidently extract both
 * parts, it returns null so the caller can fall back to generic click logic.
 */
export type DropdownIntent =
  | { kind: 'open-and-select'; dropdownLabel: string; optionLabel: string }
  | { kind: 'select-only'; optionLabel: string };

export function parseDropdownInstruction(prompt: string): DropdownIntent | null {
  const raw = (prompt || '').trim();
  if (!raw) return null;

  const lower = raw.toLowerCase();

  // We only care about prompts that clearly involve selection.
  if (!/\bselect\b/i.test(lower)) return null;

  // 1) Try to extract the option label from quoted text near "select".
  let optionLabel = '';
  const selectIdx = lower.indexOf('select');
  if (selectIdx >= 0) {
    const afterSelect = raw.slice(selectIdx + 'select'.length);
    const quotedNearSelect = afterSelect.match(/["'“”]([^"'“”]{2,})["'“”]/);
    if (quotedNearSelect) {
      optionLabel = quotedNearSelect[1].trim();
    }
  }

  // 2) Fallback: patterns like "select X option".
  if (!optionLabel) {
    const m = lower.match(/select\s+([^\n]+?)\s+option\b/);
    if (m && m[1]) {
      optionLabel = raw.substring(m.index! + 'select'.length, m.index! + 'select'.length + m[0].length - ' option'.length - 'select '.length).trim();
    }
  }

  // 3) Fallback: patterns like "select X from the drop down menu".
  if (!optionLabel) {
    const m = lower.match(/select\s+([^\n]+?)\s+(?:from\s+the\s+)?(?:drop\s*down|dropdown)(?:\s+menu)?\b/);
    if (m && m[1]) {
      optionLabel = raw.substring(m.index! + 'select'.length, m.index! + 'select'.length + m[0].length - (m[0].match(/\s+(?:from\s+the\s+)?(?:drop\s*down|dropdown)(?:\s+menu)?\b/)?.[0].length || 0) - 'select '.length).trim();
    }
  }

  if (!optionLabel) {
    return null;
  }

  // 4) Heuristic for dropdown label: quoted text (excluding the option), or
  // words before "drop down"/"dropdown".
  let dropdownLabel = '';
  const quotedAll = raw.match(/["'“”]([^"'“”]{2,})["'“”]/g);
  if (quotedAll && quotedAll.length >= 1) {
    const candidates = quotedAll.map((s) => s.replace(/["'“”]/g, '').trim());
    const optLower = optionLabel.toLowerCase();
    const other = candidates.find((c) => c.toLowerCase() !== optLower);
    if (other) {
      dropdownLabel = other;
    }
  }

  if (!dropdownLabel) {
    const parts = raw.split(/drop\s*down|dropdown/i);
    if (parts.length > 1) {
      const beforeDrop = parts[0];
      const cleaned = beforeDrop
        .replace(/click on|click|press|tap|open|select/gi, '')
        .trim();
      if (cleaned && cleaned.toLowerCase() !== optionLabel.toLowerCase()) {
        dropdownLabel = cleaned;
      }
    }
  }

  const mentionsDropdown = /(drop\s*down|dropdown)/i.test(lower);

  if (dropdownLabel) {
    return { kind: 'open-and-select', dropdownLabel, optionLabel };
  }

  if (mentionsDropdown) {
    // We have an option label and the user clearly referenced a dropdown,
    // but did not name the specific control. Assume the dropdown is already
    // open (from a previous step) and only perform option selection.
    return { kind: 'select-only', optionLabel };
  }

  return null;
}
