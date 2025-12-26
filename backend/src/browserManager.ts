import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { BrowserConfig, ElementInfo, SessionState } from './types';

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private readonly config: BrowserConfig;
  private readonly state: SessionState = {
    isOpen: false,
    selectors: new Map()
  };

  constructor(config: Partial<BrowserConfig> = {}) {
    this.config = {
      headless: config.headless ?? true,
      timeoutMs: config.timeoutMs ?? 30000,
      viewport: config.viewport ?? { width: 1280, height: 720 },
      chromePath: config.chromePath
    };
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
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    this.state.currentUrl = page.url();
  }

  async screenshot(): Promise<string> {
    const page = this.getPage();
    const buf = await page.screenshot({ fullPage: true });
    const base64 = buf.toString('base64');
    const dataUrl = `data:image/png;base64,${base64}`;
    this.state.lastScreenshot = dataUrl;
    return dataUrl;
  }

  async click(selector: string): Promise<void> {
    const page = this.getPage();
    await page.click(selector);
  }

  async type(selector: string, text: string): Promise<void> {
    const page = this.getPage();
    await page.fill(selector, '');
    await page.type(selector, text);
  }

  async waitFor(selector: string, timeoutMs = 5000): Promise<void> {
    const page = this.getPage();
    await page.waitForSelector(selector, { timeout: timeoutMs });
  }

  async pageSource(): Promise<string> {
    const page = this.getPage();
    return page.content();
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
