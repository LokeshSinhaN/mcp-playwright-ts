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

  private get defaultTimeout(): number {
    return this.config.timeoutMs;
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
    await page.goto(url, { waitUntil: 'networkidle' });
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

  /**
   * Clicks an element in a more robust way than page.click:
   *  - for plain CSS/XPath selectors: waits for visibility and clicks the first match
   *  - for Playwright text selectors (e.g. "text=LOGIN"): prefers ARIA roles
   *    like button/link with that accessible name, to avoid hitting headings
   */
  async click(selector: string): Promise<void> {
    const page = this.getPage();

    // Heuristic: if the selector is of the form `text=Something`, try to
    // resolve it as a button/link first. This avoids cases like headings
    // that contain the same text but are not actually clickable.
    const textPrefix = 'text=';
    if (selector.startsWith(textPrefix)) {
      const rawText = selector.slice(textPrefix.length).replace(/^['"]|['"]$/g, '');
      const escaped = rawText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const nameRegex = new RegExp(`^${escaped}$`, 'i');

      const candidates = [
        page.getByRole('button', { name: nameRegex }),
        page.getByRole('link', { name: nameRegex }),
        page.getByText(rawText, { exact: true })
      ];

      for (const loc of candidates) {
        try {
          if ((await loc.count()) === 0) continue;
          await loc.first().waitFor({ state: 'visible', timeout: this.defaultTimeout });
          await loc.first().scrollIntoViewIfNeeded();
          await loc.first().click({ timeout: this.defaultTimeout });
          return;
        } catch {
          // If this candidate fails, fall through to the next one.
        }
      }
      // If all heuristics fail, fall back to the generic locator logic below.
    }

    const locator = page.locator(selector).first();
    await locator.waitFor({ state: 'visible', timeout: this.defaultTimeout });
    await locator.scrollIntoViewIfNeeded();
    await locator.click({ timeout: this.defaultTimeout });
  }

  async type(selector: string, text: string): Promise<void> {
    const page = this.getPage();
    const locator = page.locator(selector).first();

    await locator.waitFor({ state: 'visible', timeout: this.defaultTimeout });
    await locator.fill('');
    await locator.type(text, { timeout: this.defaultTimeout });
  }

  async waitFor(selector: string, timeoutMs = 5000): Promise<void> {
    const page = this.getPage();
    await page.waitForSelector(selector, { timeout: timeoutMs, state: 'visible' });
  }

  async pageSource(): Promise<string> {
    const page = this.getPage();
    return page.content();
  }

  /**
   * Best-effort handler for common cookie/consent banners.
   * It silently does nothing if no banner is found.
   * Returns true if a banner was detected and dismissed.
   */
  async handleCookieBanner(): Promise<boolean> {
    const page = this.getPage();

    const candidates = [
      page.getByRole('button', { name: /accept( all)? cookies/i }),
      page.getByRole('button', { name: /i agree/i }),
      page.locator('button', { hasText: /accept cookies/i })
    ];

    for (const locator of candidates) {
      try {
        if (await locator.isVisible({ timeout: 2000 })) {
          await locator.scrollIntoViewIfNeeded();
          await locator.click({ timeout: 5000 });
          return true;
        }
      } catch {
        // Ignore individual locator timeouts; move to next candidate.
      }
    }

    return false;
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
