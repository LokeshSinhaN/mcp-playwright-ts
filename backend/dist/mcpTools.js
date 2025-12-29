"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.McpTools = void 0;
const selectorExtractor_1 = require("./selectorExtractor");
const seleniumGenerator_1 = require("./seleniumGenerator");
class McpTools {
    constructor(browser) {
        this.browser = browser;
    }
    async navigate(url) {
        await this.browser.init();
        await this.browser.goto(url);
        const screenshot = await this.browser.screenshot();
        return { success: true, message: `Navigated to ${url}`, screenshot };
    }
    async click(selector, context = {}) {
        // Support multiple fallback selectors in a single string, separated by "||".
        const page = this.browser.getPage();
        const promptText = context && typeof context.prompt === 'string' ? context.prompt : '';
        // If the user refers to a previously listed "option N", honor that first by
        // using the persisted smartMatches from the last ambiguous click.
        const optionMatch = promptText && promptText.match(/option\s+(\d+)/i);
        if (optionMatch) {
            const optionIndex = Number(optionMatch[1]);
            if (Number.isFinite(optionIndex) && optionIndex > 0) {
                try {
                    await this.browser.clickSmartOption(optionIndex);
                    const screenshot = await this.browser.screenshot();
                    return {
                        success: true,
                        message: `Clicked smart option ${optionIndex} from previous suggestions`,
                        screenshot
                    };
                }
                catch (err) {
                    // Fall through to the rest of the logic if the stored options
                    // are not available or clicking fails.
                }
            }
        }
        const raw = selector == null ? '' : String(selector);
        const candidates = raw
            .split('||')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        const tried = [];
        let lastError = null;
        const toTry = candidates.length ? candidates : (raw ? [raw] : []);
        for (const sel of toTry) {
            tried.push(sel);
            try {
                await page.click(sel);
                const screenshot = await this.browser.screenshot();
                const suffix = toTry.length > 1 ? ` (matched using \"${sel}\")` : '';
                return { success: true, message: `Clicked ${sel}${suffix}`, screenshot };
            }
            catch (err) {
                lastError = err;
            }
        }
        let extraInfo = '';
        // Intelligent DOM-based fallback using the natural-language prompt, if available.
        if (promptText) {
            try {
                const smart = await this.browser.smartClickFromPrompt(promptText);
                if (smart && smart.clicked) {
                    const screenshot = await this.browser.screenshot();
                    const chosen = smart.chosenIndex && Array.isArray(smart.matches)
                        ? smart.matches.find((m) => m.index === smart.chosenIndex)
                        : null;
                    const desc = chosen
                        ? ` Smart-selected option ${smart.chosenIndex}: ${chosen.label || chosen.summary || ''}.`
                        : '';
                    return {
                        success: true,
                        message: `Smart-clicked element based on prompt \"${promptText}\".${desc}`,
                        screenshot,
                        smart
                    };
                }
                if (smart && Array.isArray(smart.matches) && smart.matches.length) {
                    const lines = smart.matches.map((m) => {
                        const parts = [];
                        if (m.label)
                            parts.push(`labeled \"${m.label}\"`);
                        if (m.context)
                            parts.push(`inside section containing text \"${m.context}\"`);
                        if (m.positionDescription)
                            parts.push(`around the ${m.positionDescription} of the page`);
                        return `${m.index}. ${parts.join(', ')}`;
                    });
                    extraInfo =
                        ` Could not uniquely identify an element from the description. Possible matches based on the page DOM:\n` +
                            lines.join('\n');
                }
            }
            catch (_a) {
                // Best-effort only; ignore errors from smart DOM analysis.
            }
        }
        // If we still haven't helped the user, fall back to selector-based introspection.
        if (!extraInfo && tried.length) {
            try {
                const lastSelector = tried[tried.length - 1];
                const handles = await page.$$(lastSelector);
                if (handles.length > 0) {
                    const descriptions = [];
                    for (let i = 0; i < handles.length; i++) {
                        const h = handles[i];
                        const data = await h.evaluate((el) => {
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
                            return { positionDescription, label, context };
                        });
                        const parts = [];
                        if (data.label) {
                            parts.push(`labeled \"${data.label}\"`);
                        }
                        if (data.context) {
                            parts.push(`inside section containing text \"${data.context}\"`);
                        }
                        parts.push(`around the ${data.positionDescription} of the page`);
                        descriptions.push(`${i + 1}. ${parts.join(', ')}`);
                    }
                    extraInfo = ` Possible targets for selector \"${lastSelector}\":\n` + descriptions.join('\n');
                }
            }
            catch (_b) {
                // Best-effort only; ignore errors from introspection.
            }
        }
        const baseMsg = lastError instanceof Error ? lastError.message : String(lastError || 'Unknown click error');
        throw new Error(`Failed to click any of the selectors: ${tried.join(', ')}. ${baseMsg}${extraInfo}`);
    }
    async type(selector, text) {
        await this.browser.type(selector, text);
        const screenshot = await this.browser.screenshot();
        return { success: true, message: `Typed into ${selector}`, screenshot };
    }
    async extractSelectors(targetSelector) {
        const page = this.browser.getPage();
        const extractor = new selectorExtractor_1.SelectorExtractor(page);
        const selectors = targetSelector
            ? [await extractor.extractForSelector(targetSelector)]
            : await extractor.extractAllInteractive();
        selectors.forEach((s, idx) => this.browser.storeSelector(`el_${idx}`, s));
        return {
            success: true,
            message: `Extracted ${selectors.length} elements`,
            selectors
        };
    }
    async generateSelenium(commands) {
        const gen = new seleniumGenerator_1.SeleniumGenerator({
            language: 'python',
            testName: 'test_flow',
            chromeDriverPath: 'C:\\\\hyprtask\\\\lib\\\\Chromium\\\\chromedriver.exe'
        });
        const code = gen.generate(commands);
        return {
            success: true,
            message: 'Generated selenium code',
            seleniumCode: code
        };
    }
}
exports.McpTools = McpTools;
//# sourceMappingURL=mcpTools.js.map