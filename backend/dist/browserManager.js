"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserManager = void 0;
const playwright_1 = require("playwright");
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
            viewport: config.viewport ?? { width: 1280, height: 720 },
            chromePath: config.chromePath
        };
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
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        this.state.currentUrl = page.url();
    }
    async screenshot() {
        const page = this.getPage();
        const buf = await page.screenshot({ fullPage: true });
        const base64 = buf.toString('base64');
        const dataUrl = `data:image/png;base64,${base64}`;
        this.state.lastScreenshot = dataUrl;
        return dataUrl;
    }
    async click(selector) {
        const page = this.getPage();
        await page.click(selector);
    }
    async type(selector, text) {
        const page = this.getPage();
        await page.fill(selector, '');
        await page.type(selector, text);
    }
    async waitFor(selector, timeoutMs = 5000) {
        const page = this.getPage();
        await page.waitForSelector(selector, { timeout: timeoutMs });
    }
    async pageSource() {
        const page = this.getPage();
        return page.content();
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