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
            selectors: new Map(),
            smartMatches: [],
            lastFocusedSelector: undefined
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
    async smartClickFromPrompt(prompt) {
        const page = this.getPage();
        const raw = typeof prompt === 'string' ? prompt : '';
        const lower = raw.toLowerCase();
        const words = lower.match(/[a-z0-9]+/g) || [];
        const seen = new Set();
        const stopWords = new Set([
            'click',
            'tap',
            'press',
            'the',
            'a',
            'an',
            'on',
            'into',
            'in',
            'to',
            'of',
            'box',
            'field',
            'input',
            'button',
            'link',
            'icon',
            'text',
            'textbox',
            'type',
            'open',
            'page',
            'tab'
        ]);
        const terms = [];
        for (const w of words) {
            if (w.length < 3)
                continue;
            if (stopWords.has(w))
                continue;
            if (seen.has(w))
                continue;
            seen.add(w);
            terms.push(w);
        }
        if (lower.includes('search') && !terms.includes('search')) {
            terms.push('search');
        }
        if (!terms.length) {
            return { clicked: false, matches: [] };
        }
        const result = await page.evaluate((searchTerms) => {
            const lowerTerms = searchTerms.map((t) => t.toLowerCase());
            const interactiveSelectors = 'input, button, a, textarea, select, [role=button], [role=link], [onclick]';
            const els = Array.from(document.querySelectorAll(interactiveSelectors));
            const candidates = [];
            const combinedText = (el) => {
                const aria = el.getAttribute('aria-label') || '';
                const placeholder = el.getAttribute('placeholder') || '';
                const title = el.getAttribute('title') || '';
                const nameAttr = el.getAttribute('name') || '';
                const text = (el.innerText || el.textContent || '');
                return (aria + ' ' + placeholder + ' ' + title + ' ' + nameAttr + ' ' + text).toLowerCase();
            };
            const isVisible = (el) => {
                const style = window.getComputedStyle(el);
                if (style.visibility === 'hidden' || style.display === 'none') {
                    return false;
                }
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) {
                    return false;
                }
                return true;
            };
            const describe = (el) => {
                const rect = el.getBoundingClientRect();
                const vw = window.innerWidth || document.documentElement.clientWidth || 0;
                const vh = window.innerHeight || document.documentElement.clientHeight || 0;
                const cx = rect.left + rect.width / 2;
                const cy = rect.top + rect.height / 2;
                const horiz = cx < vw / 3 ? 'left' : cx > (2 * vw) / 3 ? 'right' : 'center';
                const vert = cy < vh / 3 ? 'top' : cy > (2 * vh) / 3 ? 'bottom' : 'middle';
                const positionDescription = `${vert} ${horiz}`.trim();
                const ariaLabel = el.getAttribute('aria-label') || '';
                const placeholder = el.getAttribute('placeholder') || '';
                const nameAttr = el.getAttribute('name') || '';
                const ownText = (el.textContent || '').trim();
                let label = ariaLabel || placeholder || nameAttr || ownText;
                if (!label && el.tagName) {
                    label = el.tagName.toLowerCase();
                }
                let context = '';
                let ancestor = el.parentElement;
                while (ancestor && !context) {
                    const t = (ancestor.innerText || '').trim();
                    if (t) {
                        context = t;
                        break;
                    }
                    ancestor = ancestor.parentElement;
                }
                if (context.length > 80) {
                    context = context.slice(0, 77) + '...';
                }
                const summaryParts = [];
                if (label)
                    summaryParts.push(`"${label}"`);
                if (positionDescription)
                    summaryParts.push(`at ${positionDescription} of page`);
                return {
                    positionDescription,
                    label,
                    context,
                    summary: summaryParts.join(' ')
                };
            };
            for (const el of els) {
                if (!isVisible(el))
                    continue;
                const full = combinedText(el);
                let score = 0;
                for (const term of lowerTerms) {
                    const idx = full.indexOf(term);
                    if (idx >= 0) {
                        score += 10;
                        if (idx === 0 || /\s/.test(full[idx - 1])) {
                            score += 5;
                        }
                    }
                }
                if (!score)
                    continue;
                const tag = el.tagName.toLowerCase();
                if (tag === 'input' || tag === 'textarea') {
                    score += 4;
                }
                const typeAttr = (el.getAttribute('type') || '').toLowerCase();
                if (typeAttr === 'search') {
                    score += 3;
                }
                const cssPath = (el) => {
                    if (el.id)
                        return `#${el.id}`;
                    const parts = [];
                    let curr = el;
                    const doc = el.ownerDocument || document;
                    while (curr && curr !== doc.body) {
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
                            .map((c) => `.${c}`);
                        if (classes.length)
                            part += classes.join('');
                        const parent = curr.parentElement;
                        if (parent) {
                            const siblings = Array.from(parent.children);
                            const index = siblings.indexOf(curr) + 1;
                            if (index > 0)
                                part += `:nth-child(${index})`;
                        }
                        parts.unshift(part);
                        curr = parent;
                    }
                    return parts.join(' > ');
                };
                candidates.push({ el, score, meta: Object.assign(Object.assign({}, describe(el)), { cssSelector: cssPath(el) }) });
            }
            if (!candidates.length) {
                return { clicked: false, matches: [] };
            }
            // Sort by descending score so the best options are first.
            candidates.sort((a, b) => b.score - a.score);
            const shouldClick = candidates.length === 1;
            const best = candidates[0];
            if (shouldClick && best && best.el) {
                best.el.scrollIntoView({ block: 'center', inline: 'center' });
                best.el.click();
            }
            return {
                clicked: shouldClick && !!best,
                chosenIndex: shouldClick ? 1 : null,
                matches: candidates.map((c, idx) => (Object.assign({ index: idx + 1, score: c.score }, c.meta)))
            };
        }, terms);
        // Persist the last smart matches so a follow-up command like "option 1" can
        // directly reference them without relying on the LLM.
        this.state.smartMatches = Array.isArray(result === null || result === void 0 ? void 0 : result.matches) ? result.matches : [];
        // If we uniquely clicked something, prefer that element for subsequent type
        // commands by storing its selector as the last focused control.
        if (result && result.clicked && Array.isArray(result.matches) && result.matches.length) {
            const chosen = typeof result.chosenIndex === 'number'
                ? result.matches.find((m) => m.index === result.chosenIndex) || result.matches[0]
                : result.matches[0];
            if (chosen && chosen.cssSelector) {
                this.state.lastFocusedSelector = chosen.cssSelector;
            }
        }
        return result;
    }
    async type(selector, text) {
        const page = this.getPage();
        const sel = selector;
        const tryBestVisibleInput = async () => {
            const inputHandles = await page.$$('input:not([type="hidden"]), textarea');
            let best = null;
            let bestScore = -1;
            for (const h of inputHandles) {
                const meta = await h.evaluate((el) => {
                    const style = window.getComputedStyle(el);
                    if (style.visibility === 'hidden' || style.display === 'none')
                        return null;
                    const rect = el.getBoundingClientRect();
                    if (rect.width === 0 || rect.height === 0)
                        return null;
                    const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
                    const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
                    const nameAttr = (el.getAttribute('name') || '').toLowerCase();
                    const typeAttr = (el.getAttribute('type') || '').toLowerCase();
                    return { placeholder, ariaLabel, nameAttr, typeAttr };
                });
                if (!meta)
                    continue;
                let score = 0;
                if (meta.typeAttr === 'search')
                    score += 20;
                if (meta.placeholder.includes('search'))
                    score += 15;
                if (meta.ariaLabel.includes('search'))
                    score += 15;
                if (meta.nameAttr.includes('search'))
                    score += 10;
                // Generic preference for any visible text input.
                score += 1;
                if (score > bestScore) {
                    bestScore = score;
                    best = h;
                }
            }
            if (!best)
                return false;
            await best.fill('');
            await best.type(text);
            try {
                const css = await best.evaluate((el) => {
                    if (el.id)
                        return `#${el.id}`;
                    const parts = [];
                    let curr = el;
                    const doc = el.ownerDocument || document;
                    while (curr && curr !== doc.body) {
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
                            .map((c) => `.${c}`);
                        if (classes.length)
                            part += classes.join('');
                        const parent = curr.parentElement;
                        if (parent) {
                            const siblings = Array.from(parent.children);
                            const index = siblings.indexOf(curr) + 1;
                            if (index > 0)
                                part += `:nth-child(${index})`;
                        }
                        parts.unshift(part);
                        curr = parent;
                    }
                    return parts.join(' > ');
                });
                if (css)
                    this.state.lastFocusedSelector = css;
            }
            catch (_a) {
                // best-effort
            }
            return true;
        };
        let handle = null;
        try {
            handle = await page.$(sel);
        }
        catch (_b) {
            // If selector lookup itself fails we may still try heuristic input search below.
        }
        if (handle) {
            const info = await handle.evaluate((el) => {
                const tag = el.tagName.toLowerCase();
                const typeAttr = (el.getAttribute('type') || '').toLowerCase();
                const role = (el.getAttribute('role') || '').toLowerCase();
                return { tag, typeAttr, role };
            });
            const isTextInput = info.tag === 'input' || info.tag === 'textarea';
            if (isTextInput) {
                // Directly type into real input/textarea elements.
                await page.fill(sel, '');
                await page.type(sel, text);
                this.state.lastFocusedSelector = sel;
                return;
            }
            // Non-input trigger (button/div/icon). Follow click-to-focus strategy:
            // click it, wait briefly, then find the best visible input field.
            await handle.click();
            await page.waitForTimeout(500);
            if (await tryBestVisibleInput()) {
                return;
            }
            // If we clicked a trigger but could not find any input, fall through
            // to a simple attempt using the original selector so the error is visible.
        }
        else {
            // Selector did not resolve to an element. If it's search-like, try heuristic
            // input discovery before giving up.
            const lowerSel = String(sel).toLowerCase();
            if (lowerSel.includes('search')) {
                if (await tryBestVisibleInput()) {
                    return;
                }
            }
        }
        // Fallback: one last direct attempt so any error is surfaced clearly.
        await page.fill(sel, '');
        await page.type(sel, text);
        this.state.lastFocusedSelector = sel;
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
    async clickSmartOption(index) {
        const page = this.getPage();
        const matches = Array.isArray(this.state.smartMatches) ? this.state.smartMatches : [];
        const match = matches.find((m) => m.index === index);
        if (!match) {
            const available = matches.map((m) => m.index).join(', ') || 'none';
            throw new Error(`No stored smart option ${index}. Available options: ${available}`);
        }
        if (!match.cssSelector) {
            throw new Error(`Stored smart option ${index} is missing a cssSelector`);
        }
        await page.click(match.cssSelector);
        // Remember which element we interacted with so follow-up "type" commands
        // can reuse the same control without re-discovering it.
        this.state.lastFocusedSelector = match.cssSelector;
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