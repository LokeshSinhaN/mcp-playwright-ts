import { BrowserManager } from './browserManager';
import { SelectorExtractor } from './selectorExtractor';
import { SeleniumGenerator } from './seleniumGenerator';
import { ExecutionCommand, ExecutionResult } from './types';

export class McpTools {
  private sessionHistory: ExecutionCommand[] = [];

  constructor(private readonly browser: BrowserManager) {}

  async navigate(url: string): Promise<ExecutionResult> {
    await this.browser.init();
    await this.browser.goto(url);

    this.sessionHistory.push({ action: 'navigate', target: url });

    // Best-effort cookie/consent banner handling so subsequent
    // clicks (e.g. LOGIN, ACCEPT) are less likely to time out.
    await this.browser.handleCookieBanner();

    const screenshot = await this.browser.screenshot();
    return { success: true, message: `Navigated to ${url}`, screenshot };
  }

  /**
   * Click an element, always returning a structured result.
   * On failure we include the latest screenshot and a snapshot of
   * interactive elements so the LLM can retry or ask clarifying questions.
   */
  async click(selector: string): Promise<ExecutionResult> {
    const page = this.browser.getPage();
    const extractor = new SelectorExtractor(page);

    try {
      const info = await this.browser.click(selector);
      
      // Use the robust CSS from the extraction if available, otherwise fallback
      const robustSelector = info.cssSelector || selector;
      this.sessionHistory.push({ action: 'click', target: robustSelector });

      const screenshot = await this.browser.screenshot();
      return { 
        success: true, 
        message: `Clicked ${selector}`, 
        screenshot,
        selectors: [info] 
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const screenshot = await this.browser.screenshot().catch(() => undefined as any);
      let selectors;
      try {
        selectors = await extractor.extractAllInteractive();
      } catch {
        selectors = undefined;
      }
      return {
        success: false,
        message: msg,
        error: msg,
        screenshot,
        selectors
      };
    }
  }

  /**
   * Type into an element. Similar to click(), we always return a rich
   * ExecutionResult and never throw for normal locator issues.
   */
  async type(selector: string, text: string): Promise<ExecutionResult> {
    const page = this.browser.getPage();
    const extractor = new SelectorExtractor(page);

    try {
      const info = await this.browser.type(selector, text);
      
      const robustSelector = info.cssSelector || selector;
      this.sessionHistory.push({ action: 'type', target: robustSelector, value: text });

      const screenshot = await this.browser.screenshot();
      return { 
        success: true, 
        message: `Typed into ${selector}`, 
        screenshot,
        selectors: [info] 
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const screenshot = await this.browser.screenshot().catch(() => undefined as any);
      let selectors;
      try {
        selectors = await extractor.extractAllInteractive();
      } catch {
        selectors = undefined;
      }
      return {
        success: false,
        message: msg,
        error: msg,
        screenshot,
        selectors
      };
    }
  }

  async handleCookieBanner(): Promise<ExecutionResult> {
    const dismissed = await this.browser.handleCookieBanner();
    const screenshot = await this.browser.screenshot();
    return {
      success: true,
      message: dismissed ? 'Cookie banner dismissed' : 'No cookie banner detected',
      screenshot
    };
  }

  /**
   * Extract selectors for either a specific target or all interactive elements.
   * This is the primary way for the LLM to "observe" the page structure.
   */
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

  /**
   * Convenience helper for the agent: capture both screenshot and a selector
   * snapshot in a single call, without performing any action.
   */
  async observe(targetSelector?: string): Promise<ExecutionResult> {
    const page = this.browser.getPage();
    const extractor = new SelectorExtractor(page);

    const selectors = targetSelector
      ? [await extractor.extractForSelector(targetSelector)]
      : await extractor.extractAllInteractive();

    selectors.forEach((s, idx) => this.browser.storeSelector(`observe_${idx}`, s));

    const screenshot = await this.browser.screenshot();

    return {
      success: true,
      message: `Observed ${selectors.length} interactive elements`,
      screenshot,
      selectors
    };
  }

  async generateSelenium(commands?: ExecutionCommand[]): Promise<ExecutionResult> {
    const gen = new SeleniumGenerator({
      language: 'python',
      testName: 'test_flow',
      chromeDriverPath: 'C:\\\\hyprtask\\\\lib\\\\Chromium\\\\chromedriver.exe'
    });

    const cmdsToUse = (commands && commands.length > 0) ? commands : this.sessionHistory;
    
    // If we're using history, we might want to filter out non-essential steps if needed,
    // but usually exact replay is desired.

    const code = gen.generate(cmdsToUse);
    return {
      success: true,
      message: `Generated selenium code from ${cmdsToUse.length} steps`,
      seleniumCode: code
    };
  }
}
