import { BrowserManager } from './browserManager';
import { SelectorExtractor } from './selectorExtractor';
import { SeleniumGenerator } from './seleniumGenerator';
import { ExecutionCommand, ExecutionResult } from './types';

export class McpTools {
  constructor(private readonly browser: BrowserManager) {}

  async navigate(url: string): Promise<ExecutionResult> {
    await this.browser.init();
    await this.browser.goto(url);
    const screenshot = await this.browser.screenshot();
    return { success: true, message: `Navigated to ${url}`, screenshot };
  }

  async click(selector: string): Promise<ExecutionResult> {
    await this.browser.click(selector);
    const screenshot = await this.browser.screenshot();
    return { success: true, message: `Clicked ${selector}`, screenshot };
  }

  async type(selector: string, text: string): Promise<ExecutionResult> {
    await this.browser.type(selector, text);
    const screenshot = await this.browser.screenshot();
    return { success: true, message: `Typed into ${selector}`, screenshot };
  }

  async extractSelectors(targetSelector?: string): Promise<ExecutionResult> {
    const page = this.browser.getPage();
    const extractor = new SelectorExtractor(page);

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

  async generateSelenium(commands: ExecutionCommand[]): Promise<ExecutionResult> {
    const gen = new SeleniumGenerator({
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
