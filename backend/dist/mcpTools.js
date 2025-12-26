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
    async click(selector) {
        await this.browser.click(selector);
        const screenshot = await this.browser.screenshot();
        return { success: true, message: `Clicked ${selector}`, screenshot };
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