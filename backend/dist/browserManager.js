"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserManager = void 0;
const playwright_1 = require("playwright");
const selectorExtractor_1 = require("./selectorExtractor");
class BrowserManager {
    constructor(config = {}) {
        this.browser = null;
        this.context = null;
        this.page = null;
        this.state = {
            isOpen: false,
            selectors: new Map()
        };
        this.config = {
            headless: config.headless ?? true,
            timeoutMs: config.timeoutMs ?? 30000,
            // Use a larger default viewport so screenshots look less "zoomed out"
            // in the preview UI, and more like a maximized browser window.
            viewport: config.viewport ?? { width: 1600, height: 900 },
            chromePath: config.chromePath
        };
    }
    get defaultTimeout() {
        return this.config.timeoutMs;
    }
    async init() {
        if (this.browser)
            return; // idempotent
        const launchOptions = {
            headless: this.config.headless
        };
        if (this.config.chromePath) {
            // Note: Playwright uses its own Chromium, this path is for parity/logging.
            console.log('Using custom chrome path hint:', this.config.chromePath);
        }
        this.browser = await playwright_1.chromium.launch(launchOptions);
        this.context = await this.browser.newContext({
            viewport: this.config.viewport
        });
        this.page = await this.context.newPage();
        this.page.setDefaultTimeout(this.config.timeoutMs);
        this.page.setDefaultNavigationTimeout(this.config.timeoutMs);
        this.state.isOpen = true;
    }
    getPage() {
        if (!this.page)
            throw new Error('Browser not initialized');
        return this.page;
    }
    getState() {
        return this.state;
    }
    async goto(url) {
        const page = this.getPage();
        try {
            // Use a more forgiving load state and explicit timeout. Some sites
            // (including large, analytics-heavy ones) never truly reach
            // "networkidle" but are still fully interactive much earlier.
            await page.goto(url, { waitUntil: 'load', timeout: this.defaultTimeout });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (/Timeout/i.test(msg)) {
                // Treat navigation timeouts as soft failures: keep whatever URL
                // the page reached so the rest of the flow can continue.
                console.warn('goto timeout, proceeding with current page:', msg);
            }
            else {
                throw err;
            }
        }
        this.state.currentUrl = page.url();
    }
    async screenshot() {
        const page = this.getPage();
        // Capture only the current viewport at a larger size instead of a full-page
        // tall image. This makes the preview appear closer to a maximized view
        // instead of a shrunk-down full-page thumbnail.
        const buf = await page.screenshot({ fullPage: false });
        const base64 = buf.toString('base64');
        const dataUrl = `data:image/png;base64,${base64}`;
        this.state.lastScreenshot = dataUrl;
        return dataUrl;
    }
    /**
     * Smart locator resolution that:
     * 1. Parses "engine-like" selectors (text=, label=, etc.)
     * 2. Handles AI-generated CSS (input[placeholder=...]) with fuzzy matching
     * 3. Handles plain semantic text like "Login" or "Search diseases and conditions"
     * 4. Searches across ALL frames (iframes), not just the main page
     * 5. Returns the first Locator that is visible, or the "best guess" to wait on.
     */
    async smartLocate(selector, timeoutMs) {
        const page = this.getPage();
        const frames = [page, ...page.frames().filter(f => f !== page.mainFrame())];
        // Helper to generate candidate locators for a given frame/page
        const getCandidates = (scope) => {
            const candidates = [];
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
                const fuzzy = new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'i');
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
                    // Check if attached & visible without waiting too long
                    if (await loc.first().isVisible({ timeout: Math.min(250, timeoutMs) })) {
                        return loc.first();
                    }
                }
                catch {
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
        }
        catch {
            // ignore and fall back to primary
        }
        return primary;
    }
    /**
     * Given a base locator that might point at a wrapper element, return a
     * locator that actually targets a fillable control.
     */
    async resolveFillTarget(base) {
        // (Existing logic kept, but ensured it's robust)
        try {
            const candidate = base.first();
            if (await candidate.count() === 0)
                return candidate; // let it fail naturally later
            const handle = await candidate.elementHandle().catch(() => null);
            if (handle) {
                const isFillable = await handle.evaluate((el) => {
                    const tag = (el.tagName || '').toLowerCase();
                    if (tag === 'input' || tag === 'textarea' || tag === 'select')
                        return true;
                    if (el.isContentEditable)
                        return true;
                    const role = typeof el.getAttribute === 'function' ? el.getAttribute('role') : null;
                    return role === 'textbox' || role === 'combobox';
                });
                if (isFillable)
                    return candidate;
            }
            const descendant = base.locator('input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]');
            if ((await descendant.count()) > 0) {
                return descendant.first();
            }
        }
        catch {
            // ignore errors during resolution
        }
        return base;
    }
    async click(selector) {
        // 1. Find best locator (frames, fuzzy, etc.)
        const locator = await this.smartLocate(selector, this.defaultTimeout);
        // 2. Wait for it to be ready
        await locator.waitFor({ state: 'visible', timeout: this.defaultTimeout });
        await locator.scrollIntoViewIfNeeded();
        // 3. Extract robust info before clicking (in case click navigates away)
        let info;
        try {
            const handle = await locator.elementHandle();
            if (handle) {
                const extractor = new selectorExtractor_1.SelectorExtractor(this.getPage());
                info = await extractor.extractFromHandle(handle);
            }
        }
        catch (e) {
            // ignore extraction errors, proceed to click
        }
        // 3. Click
        await locator.click({ timeout: this.defaultTimeout });
        // Re-resolve if we failed to extract before? No, strict flow.
        // If we couldn't extract, we return a dummy info or throw?
        // We'll return the info if we got it, or a basic one.
        if (info)
            return info;
        // Fallback if extraction failed (shouldn't happen often)
        return {
            tagName: 'unknown',
            attributes: {},
            cssSelector: selector // better than nothing
        };
    }
    async type(selector, text) {
        // 1. Find best locator
        const base = await this.smartLocate(selector, this.defaultTimeout);
        // 2. Drill down to input if it's a wrapper
        const locator = await this.resolveFillTarget(base);
        // 3. Type
        await locator.waitFor({ state: 'visible', timeout: this.defaultTimeout });
        // Extract info
        let info;
        try {
            const handle = await locator.elementHandle();
            if (handle) {
                const extractor = new selectorExtractor_1.SelectorExtractor(this.getPage());
                info = await extractor.extractFromHandle(handle);
            }
        }
        catch (e) { }
        try {
            await locator.fill('');
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(`Unable to fill element found by "${selector}": ${msg}`);
        }
        await locator.type(text, { timeout: this.defaultTimeout });
        return info || { tagName: 'input', attributes: {}, cssSelector: selector };
    }
    async waitFor(selector, timeoutMs = 5000) {
        const locator = await this.smartLocate(selector, timeoutMs);
        await locator.waitFor({ state: 'visible', timeout: timeoutMs });
    }
    async pageSource() {
        const page = this.getPage();
        return page.content();
    }
    /**
     * Best-effort handler for common cookie/consent banners.
     * It silently does nothing if no banner is found.
     * Returns true if a banner was detected and dismissed.
     */
    async handleCookieBanner() {
        const page = this.getPage();
        const candidates = [
            // Common "accept" patterns, including "Accept additional cookies" and
            // other variations where "accept" appears before "cookies".
            page.getByRole('button', { name: /accept.*cookies/i }),
            page.locator('button', { hasText: /accept.*cookies/i }),
            // Common "reject/deny" patterns, so the same helper can be reused if
            // you later want a "reject cookies" flow.
            page.getByRole('button', { name: /reject.*cookies/i }),
            page.locator('button', { hasText: /reject.*cookies/i }),
            // Generic consent text some sites use.
            page.getByRole('button', { name: /i agree/i })
        ];
        for (const locator of candidates) {
            try {
                if (await locator.isVisible({ timeout: 2000 })) {
                    await locator.scrollIntoViewIfNeeded();
                    await locator.click({ timeout: 5000 });
                    return true;
                }
            }
            catch {
                // Ignore individual locator timeouts; move to next candidate.
            }
        }
        return false;
    }
    isOpen() {
        return this.state.isOpen && !!this.page;
    }
    storeSelector(key, info) {
        this.state.selectors.set(key, info);
    }
    getSelectors() {
        return Array.from(this.state.selectors.values());
    }
    async close() {
        if (this.page)
            await this.page.close();
        if (this.context)
            await this.context.close();
        if (this.browser)
            await this.browser.close();
        this.page = null;
        this.context = null;
        this.browser = null;
        this.state.isOpen = false;
    }
}
exports.BrowserManager = BrowserManager;
//# sourceMappingURL=browserManager.js.map