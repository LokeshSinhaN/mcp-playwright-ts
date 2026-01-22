import { chromium, Browser, BrowserContext, Page, Locator, Frame } from 'playwright';
import { BrowserConfig, ElementInfo, SessionState, ExecutionResult } from './types';
import { SelectorExtractor } from './selectorExtractor';

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private screenshotStreamer: NodeJS.Timeout | null = null;
  private readonly config: BrowserConfig;
  private readonly state: SessionState = {
    isOpen: false,
    selectors: new Map()
  };

  constructor(config: Partial<BrowserConfig> = {}) {
    this.config = {
      headless: config.headless ?? true,
      timeoutMs: config.timeoutMs ?? 30000,
      // Use a larger default viewport so screenshots look less "zoomed out"
      // in the preview UI, and more like a maximized browser window.
      viewport: config.viewport ?? { width: 1600, height: 900 },
      chromePath: config.chromePath
    };
  }

  startScreenshotStream(broadcast: (message: string) => void) {
    if (this.screenshotStreamer) {
      console.log('Screenshot streamer is already running.');
      return;
    }

    console.log('Starting screenshot streamer.');
    this.screenshotStreamer = setInterval(async () => {
      try {
        const screenshot = await this.screenshot();
        broadcast(
          JSON.stringify({
            type: 'screenshot',
            data: { screenshot, timestamp: Date.now() }
          })
        );
      } catch (err) {
        // This is a "best-effort" stream, so we log errors but do not stop
        // the timer. It may recover on the next tick.
        console.warn('Screenshot stream failed on one tick:', err);
      }
    }, 250); // Send a screenshot every 250ms for a 4 FPS stream
  }

  stopScreenshotStream() {
    if (!this.screenshotStreamer) return;
    console.log('Stopping screenshot streamer.');
    clearInterval(this.screenshotStreamer);
    this.screenshotStreamer = null;
  }


  private get defaultTimeout(): number {
    return this.config.timeoutMs;
  }

  // Default per-click timeout (in ms). Navigation and other operations can
  // still use the broader session timeout, but individual clicks should fail
  // fast so the manager can escalate to force/JS clicks instead of hanging.
  private get clickTimeout(): number {
    return 2000; // 2 seconds
  }

  async init(): Promise<void> {
    if (this.browser) return; // idempotent

    const launchOptions: Parameters<typeof chromium.launch>[0] = {
      headless: this.config.headless
    };

    if (this.config.chromePath) {
      // Note: Playwright uses its own Chromium, this path is for parity/logging.
      console.log('Using custom chrome path hint:', this.config.chromePath);
    }

    this.browser = await chromium.launch(launchOptions);
    this.context = await this.browser.newContext({
      viewport: this.config.viewport
    });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(this.config.timeoutMs);
    this.page.setDefaultNavigationTimeout(this.config.timeoutMs);
    this.state.isOpen = true;
  }

  getPage(): Page {
    if (!this.page) throw new Error('Browser not initialized');
    return this.page;
  }

  getState(): SessionState {
    return this.state;
  }

  async goto(url: string): Promise<void> {
    const page = this.getPage();

    try {
      // Use a more forgiving load state and explicit timeout. Some sites
      // (including large, analytics-heavy ones) never truly reach
      // "networkidle" but are still fully interactive much earlier.
      await page.goto(url, { waitUntil: 'load', timeout: this.defaultTimeout });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/Timeout/i.test(msg)) {
        // Treat navigation timeouts as soft failures: keep whatever URL
        // the page reached so the rest of the flow can continue.
        console.warn('goto timeout, proceeding with current page:', msg);
      } else {
        throw err;
      }
    }

    // Wait for any dynamic content to stabilize
    await this.waitForPageStable();
    this.state.currentUrl = page.url();
  }

  /**
   * Wait for the page to become stable (no pending network requests, DOM settled).
   * This helps with SPAs and dynamically loaded content.
   */
  async waitForPageStable(timeoutMs: number = 3000): Promise<void> {
    const page = this.getPage();
    try {
      // Wait for network to be idle (no requests for 500ms)
      await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs });
      // Additional small delay for JS frameworks to initialize
      await page.waitForTimeout(500);
    } catch {
      // Non-fatal - continue even if timeout
    }
  }


  async screenshot(): Promise<string> {
    const page = this.getPage();
    try {
        if (page.isClosed()) return ''; // Handle closed page gracefully

        // Reduced timeout to fail fast without hanging the agent
        const buf = await page.screenshot({ 
            fullPage: false, 
            timeout: 1500,
            animations: 'disabled' 
        });
        const dataUrl = `data:image/png;base64,${buf.toString('base64')}`;
        this.state.lastScreenshot = dataUrl;
        return dataUrl;
    } catch (err) {
        // Return the last known good screenshot instead of crashing
        // or a blank placeholder if none exists
        return this.state.lastScreenshot || 'data:image/png;base64,';
    }
}

  /**
   * Smart locator resolution that:
   * 1. Parses "engine-like" selectors (text=, label=, etc.)
   * 2. Handles AI-generated CSS (input[placeholder=...]) with fuzzy matching
   * 3. Handles plain semantic text like "Login" or "Search diseases and conditions"
   * 4. Searches across ALL frames (iframes), not just the main page
   * 5. Returns the first Locator that is visible, or the "best guess" to wait on.
   */
  private async smartLocate(selector: string, timeoutMs: number): Promise<Locator> {
    const page = this.getPage();
    const frames = [page, ...page.frames().filter(f => f !== page.mainFrame())];

    // --- CRASH FIX ---
    // Guard against undefined/null selectors which cause the "reading 'trim'" error.
    if (!selector || typeof selector !== 'string') {
        console.warn('smartLocate received invalid selector:', selector);
        // Return a dummy locator that will simply fail to count/click gracefully
        // instead of crashing the entire Node process.
        return page.locator('body').filter({ hasText: '_____NON_EXISTENT_____' });
    }

    // Normalize selector
    const raw = selector.trim(); 
    if (!raw) {
         return page.locator('body').filter({ hasText: '_____NON_EXISTENT_____' });
    }
    // -----------------

    // Helper to generate candidate locators for a given frame/page
    const getCandidates = (scope: Page | typeof frames[0]) => {
      const candidates: Locator[] = [];

      // Normalize selector for regex use
      const raw = selector.trim();

      // 1. Smart Inputs (placeholder/aria-label) with fuzzy matching
      const placeholderCss = raw.match(/input\[placeholder=(['\"])(.*?)\1\]/i);
      if (placeholderCss) {
        const value = placeholderCss[2].trim();
        const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Fuzzy match: contains text, case insensitive
        candidates.push(scope.getByPlaceholder(new RegExp(escaped, 'i')));
      }

      const ariaLabelCss = raw.match(/input\[aria-label=(['\"])(.*?)\1\]/i);
      if (ariaLabelCss) {
        const value = ariaLabelCss[2].trim();
        const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        candidates.push(scope.getByLabel(new RegExp(escaped, 'i')));
      }

      // 2. Engine-style prefixes (text=, label=, etc.)
      const engineLike = /^[a-zA-Z]+=/i.test(raw) && !raw.includes('>>');
      if (engineLike) {
        const parts = raw.split('=');
        const prefix = parts[0].trim().toLowerCase();
        const value = parts.slice(1).join('=').trim().replace(/^['\"]|['\"]$/g, '');
        const fuzzyRegex = new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

        switch (prefix) {
          case 'text':
            // Try exact, then button/link role, then fuzzy text
            candidates.push(scope.getByRole('button', { name: fuzzyRegex }));
            candidates.push(scope.getByRole('link', { name: fuzzyRegex }));
            candidates.push(scope.getByText(fuzzyRegex));
            break;
          case 'label':
            candidates.push(scope.getByLabel(fuzzyRegex));
            break;
          case 'placeholder':
            candidates.push(scope.getByPlaceholder(fuzzyRegex));
            break;
          case 'alt':
            candidates.push(scope.getByAltText(fuzzyRegex));
            break;
          case 'title':
            candidates.push(scope.getByTitle(fuzzyRegex));
            break;
          case 'testid':
            candidates.push(scope.getByTestId(value)); // testid usually strict
            break;
        }
      }

      // 3. Plain semantic text like "Login" or "Search diseases and conditions"
      const looksLikePlainText = !/[#.[\]=:>]/.test(raw) && !engineLike;
      if (looksLikePlainText && raw.length > 0) {
        const fuzzy = new RegExp(
          raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'),
          'i'
        );

        // buttons/links labeled with this text
        candidates.push(scope.getByRole('button', { name: fuzzy }));
        candidates.push(scope.getByRole('link', { name: fuzzy }));
        // search fields or inputs associated with this text
        candidates.push(scope.getByPlaceholder(fuzzy));
        candidates.push(scope.getByLabel(fuzzy));
        // final text search fallback
        candidates.push(scope.getByText(fuzzy));
      }

      // 4. Fallback / Standard selector
      // If we haven't matched a special pattern, or just as a fallback, treat as standard selector
      candidates.push(scope.locator(raw));

      return candidates;
    };

    // Phase 1: Quick Scan - check all frames for immediate visibility
    for (const frame of frames) {
      const candidates = getCandidates(frame);
      for (const loc of candidates) {
        try {
          // SPEED FIX: Reduce check timeout from default (30s) to 1s.
          // If it's not there instantly, we want to know so we can scroll.
          if (await loc.first().isVisible({ timeout: 1000 })) {
            return loc.first();
          }
        } catch {
          // Ignore errors during scan
        }
      }
    }

    // Phase 2: If nothing found immediately, we default to waiting on the
    // main page using the "best" candidate.
    // We prioritize the fuzzy matcher if we generated one, otherwise the raw selector.
    const mainCandidates = getCandidates(page);
    const primary = mainCandidates[0].first();

    // Special-case heuristic: if the selector mentions "search" and the primary
    // candidate resolves to nothing, fall back to any visible search-like input.
    try {
      if (/search/i.test(selector) && (await primary.count()) === 0) {
        const searchLike = page
          .locator('input, textarea, [role="textbox"], [type="search"]')
          .filter({
            has: page.locator('text=/search/i')
          });
        if (await searchLike.count()) {
          return searchLike.first();
        }
      }
    } catch {
      // ignore and fall back to primary
    }

    return primary;
  }

  /**
   * Given a base locator that might point at a wrapper element, return a
   * locator that actually targets a fillable control.
   */
  private async resolveFillTarget(base: Locator): Promise<Locator> {
    // (Existing logic kept, but ensured it's robust)
    try {
        const candidate = base.first();
        if (await candidate.count() === 0) return candidate; // let it fail naturally later

        const handle = await candidate.elementHandle().catch(() => null);
        if (handle) {
        const isFillable = await handle.evaluate((el: any) => {
            const tag = (el.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
            if (el.isContentEditable) return true;
            const role = typeof el.getAttribute === 'function' ? el.getAttribute('role') : null;
            return role === 'textbox' || role === 'combobox';
        });
        if (isFillable) return candidate;
        }

        const descendant = base.locator(
        'input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]'
        );
        if ((await descendant.count()) > 0) {
        return descendant.first();
        }
    } catch {
        // ignore errors during resolution
    }
    return base;
  }

  async click(selector: string): Promise<ElementInfo> {
    const page = this.getPage();
    const baseLocator = await this.smartLocate(selector, this.defaultTimeout);
    const locator = baseLocator.first();

    // 1. ROBUST SCROLLING & STABILITY CHECK (Prevents "Wrong Neighbor" Click)
    try {
      // Try fast scroll first
      await locator.scrollIntoViewIfNeeded({ timeout: 1500 });
      
      // FIX: Wait for scroll to COMPLETELY stop (Debounce)
      
      await page.evaluate(() => new Promise((resolve) => {
          let lastPos = -1;
          const check = () => {
            const current = window.scrollY + document.documentElement.scrollTop; // Checks both window and containers
            if (current === lastPos) resolve(true);
            else {
              lastPos = current;
              requestAnimationFrame(check);
            }
          };
          requestAnimationFrame(check);
      }));
    } catch {
      // Fallback: JS Scroll
      await locator.evaluate((el: any) => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
      await page.waitForTimeout(500); 
    }

    // 2. Visual Highlight
    try {
      await locator.evaluate((el: any) => { (el as HTMLElement).style.outline = '3px solid red'; });
      await page.waitForTimeout(200);
    } catch {}

    // 3. Extract Info
    let info: ElementInfo | undefined;
    try {
      const handle = await locator.elementHandle();
      if (handle) {
        const extractor = new SelectorExtractor(this.getPage());
        info = await extractor.extractFromHandle(handle);
      }
    } catch {}

    // 4. Click with Force Strategy (Fixes "Element not clickable")
    try {
      await locator.click({ timeout: 3000 });
    } catch (err) {
      console.warn(`Standard click failed, escalating to FORCE click...`);
      try {
        // Force click bypasses overlap checks
        await locator.click({ timeout: 3000, force: true });
      } catch (forceErr) {
        // JS Click is the ultimate fallback
        await locator.evaluate((el: any) => el.click());
      }
    }

    return info || { tagName: 'unknown', attributes: {}, cssSelector: selector };
  }

  async type(selector: string, text: string): Promise<ElementInfo> {
    const page = this.getPage();
    // 1. Find best locator using smart fuzzy matching
    const base = await this.smartLocate(selector, this.defaultTimeout);
    
    // 2. Drill down to input if the selector points to a wrapper/container
    const locator = await this.resolveFillTarget(base);

    // --- FIX START: ROBUST SCROLLING FOR TYPING ---
    // Instead of waiting 30s for Playwright to scroll, we try fast, then force it.
    try {
      // Try standard scroll first (Fail fast in 1.5s instead of 30s)
      await locator.scrollIntoViewIfNeeded({ timeout: 1500 });
    } catch {
      // Fallback: Force JS scroll (Instant Jump) if standard scroll gets stuck
      await locator.evaluate((el: any) => {
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
      });
      await page.waitForTimeout(500); 
    }
    // --- FIX END ---

    // 3. Ensure visibility (Now that we've scrolled, this should pass instantly)
    // We keep a moderate timeout here just in case the element is physically hidden 
    // by an animation, but since we handled scrolling above, it won't hang there.
    await locator.waitFor({ state: 'visible', timeout: 5000 });
    
    // Extract info for return
    let info: ElementInfo | undefined;
    try {
      const handle = await locator.elementHandle();
      if (handle) {
        const extractor = new SelectorExtractor(this.getPage());
        info = await extractor.extractFromHandle(handle);
      }
    } catch (e) {}

    // 4. HUMAN CLEAR PROTOCOL (Universal Fix)
    // Date and masked inputs often ignore programmatic clears (e.g. .fill(''))
    // and instead append new text. To behave like a real user, we ALWAYS
    // simulate "Select All" followed by "Backspace" before typing.
    try {
      await locator.focus(); // Ensure focus on the input
      await locator.press('Control+A'); // Select all existing content
      await locator.press('Backspace'); // Clear it via keyboard, like a human
    } catch (err) {
      console.warn(`Non-fatal error during input clearing for "${selector}": ${err}`);
    }

    try {
        // Now type the actual text
        await locator.type(text, { timeout: this.defaultTimeout });
        
        // Universal Commit: Press Enter to trigger any "on change" or "search" listeners
        await locator.press('Enter');
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Unable to fill element found by "${selector}": ${msg}`);
    }
    
    return info || { tagName: 'input', attributes: {}, cssSelector: selector };
  }

  /**
 * Universal Scroll: Automatically finds the best scroll target if none is provided.
 */
async scroll(selector: string | undefined, direction: 'up' | 'down'): Promise<ExecutionResult> {
    const page = this.getPage();
    const scrollAmount = direction === 'up' ? -400 : 400; // Increased amount for efficiency

    let targetLocator: Locator;

    if (selector) {
        targetLocator = await this.smartLocate(selector, 2000);
    } else {
        // INTELLIGENT FALLBACK V2: Prioritize "Active" Dropdowns/Menus
        const scrollableSelector = await page.evaluate(() => {
            // 1. Priority: Is there an open dropdown/menu? (High confidence)
            const activeMenus = document.querySelectorAll('[role="listbox"], [role="menu"], .dropdown-menu, .MuiMenu-paper');
            for (const menu of Array.from(activeMenus)) {
                const style = window.getComputedStyle(menu);
                // Check if it's visible and actually scrollable
                if (style.display !== 'none' && style.visibility !== 'hidden' && menu.scrollHeight > menu.clientHeight) {
                    // Generate a unique selector for this menu
                    return (menu.id) ? `#${menu.id}` : 
                           (menu.className) ? `.${menu.className.split(' ')[0]}` : 
                           `[role="${menu.getAttribute('role')}"]`;
                }
            }

            // 2. Fallback: Find the largest scrollable container (Your original logic)
            const all = document.querySelectorAll('*');
            let largestArea = 0;
            let bestSelector = 'body'; 

            for (const el of Array.from(all)) {
                const style = window.getComputedStyle(el);
                const isScrollable = (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
                
                if (isScrollable) {
                    const rect = el.getBoundingClientRect();
                    const area = rect.width * rect.height;
                    if (area > largestArea && area > 20000) { 
                        largestArea = area;
                        bestSelector = (el.id) ? `#${el.id}` : el.tagName; 
                    }
                }
            }
            return bestSelector === 'body' ? null : bestSelector; 
        });

        if (scrollableSelector) {
            console.log(`[AutoScroll] Detected scrollable container: ${scrollableSelector}`);
            targetLocator = page.locator(scrollableSelector).first();
        } else {
            // Standard window scroll
            await page.mouse.wheel(0, scrollAmount);
            await page.waitForTimeout(500);
            return { success: true, message: `Scrolled page ${direction}` };
        }
    }

    // Perform the scroll on the identified locator
    try {
        await targetLocator.evaluate((el: any, amount: number) => {
            el.scrollBy({ top: amount, behavior: 'smooth' });
        }, scrollAmount);
        await page.waitForTimeout(700); // Wait longer for rendering
        return { success: true, message: `Scrolled container ${direction}` };
    } catch (e) {
        // Fallback if locator fails
        await page.mouse.wheel(0, scrollAmount);
        return { success: true, message: `Scrolled page (fallback) ${direction}` };
    }
}

  /**
   * Smart wait that checks for specific conditions rather than just time.
   * Returns true if the condition was met, false if timed out.
   */
  async smartWait(options: {
    forSelector?: string;
    forUrl?: string | RegExp;
    forNavigation?: boolean;
    timeoutMs?: number;
  }): Promise<boolean> {
    const page = this.getPage();
    const timeout = options.timeoutMs ?? 5000;

    try {
      if (options.forSelector) {
        await page.waitForSelector(options.forSelector, { state: 'visible', timeout });
        return true;
      }
      if (options.forUrl) {
        await page.waitForURL(options.forUrl, { timeout });
        return true;
      }
      if (options.forNavigation) {
        await page.waitForLoadState('domcontentloaded', { timeout });
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  /**
   * Check if an element exists and is visible within a short timeout.
   */
  async elementExists(selector: string, timeoutMs: number = 2000): Promise<boolean> {
    const page = this.getPage();
    try {
      const loc = page.locator(selector);
      return await loc.isVisible({ timeout: timeoutMs });
    } catch {
      return false;
    }
  }

  async waitFor(selector: string, timeoutMs = 5000): Promise<void> {
    const locator = await this.smartLocate(selector, timeoutMs);
    await locator.waitFor({ state: 'visible', timeout: timeoutMs });
  }
  async pageSource(): Promise<string> {
    const page = this.getPage();
    return page.content();
  }

  /**
   * Best-effort handler for common cookie/consent banners.
   * It silently does nothing if no banner is found.
   * Returns the ElementInfo for the clicked consent button, or null.
   */
  async handleCookieBanner(): Promise<ElementInfo | null> {
    const page = this.getPage();
    const extractor = new SelectorExtractor(page);

    const candidates: Locator[] = [
      // Common "accept" patterns, including "Accept additional cookies" and
      // other variations where "accept" appears before "cookies".
      page.getByRole('button', { name: /accept.*cookies?/i }),
      page.locator('button', { hasText: /accept.*cookies?/i }),
      page.getByRole('button', { name: /accept all/i }),
      page.locator('button', { hasText: /accept all/i }),
      page.getByRole('button', { name: /allow all/i }),
      page.locator('button', { hasText: /allow all/i }),
      page.getByRole('button', { name: /agree/i }),
      page.locator('button', { hasText: /agree/i }),
      page.getByRole('button', { name: /got it/i }),
      page.locator('button', { hasText: /got it/i }),
      // Common "reject/deny" patterns, so the same helper can be reused if
      // you later want a "reject cookies" flow.
      page.getByRole('button', { name: /reject.*cookies?/i }),
      page.locator('button', { hasText: /reject.*cookies?/i }),
      page.getByRole('button', { name: /deny.*cookies?/i }),
      page.locator('button', { hasText: /deny.*cookies?/i }),
      // Generic consent text some sites use.
      page.getByRole('button', { name: /i agree/i }),
      page.locator('button', { hasText: /i agree/i }),
      page.getByRole('button', { name: /dismiss/i }),
      page.locator('button', { hasText: /dismiss/i })
    ];

    for (const base of candidates) {
      const locator = base.first();
      try {
        if (!(await locator.isVisible({ timeout: 2000 }))) continue;

        await locator.scrollIntoViewIfNeeded();

        // Try to extract selector info before we click, to survive navigation.
        let info: ElementInfo | null = null;
        try {
          const handle = await locator.elementHandle();
          if (handle) {
            info = await extractor.extractFromHandle(handle);
          }
        } catch {
          info = null;
        }

        try {
          await locator.click({ timeout: 5000 });
        } catch {
          // Final attempt with force in case of overlays.
          await locator.click({ timeout: 5000, force: true });
        }

        if (info) {
          // Store for later self-healing and history use.
          const key = `cookie_${Date.now()}`;
          this.storeSelector(key, info);
          return info;
        }

        // If we reached here, we clicked but failed to extract metadata;
        // still treat it as handled but without selector details.
        return null;
      } catch {
        // Ignore individual locator errors; move to next candidate.
      }
    }

    return null;
  }

  isOpen(): boolean {
    return this.state.isOpen && !!this.page;
  }

  storeSelector(key: string, info: ElementInfo): void {
    this.state.selectors.set(key, info);
  }

  getSelectors(): ElementInfo[] {
    return Array.from(this.state.selectors.values());
  }

  async close(): Promise<void> {
    if (this.page) await this.page.close();
    if (this.context) await this.context.close();
    if (this.browser) await this.browser.close();
    this.page = null;
    this.context = null;
    this.browser = null;
    this.state.isOpen = false;
  }
}
