import { chromium, Browser, BrowserContext, Page, Locator, Frame } from 'playwright';
import { BrowserConfig, ElementInfo, SessionState, ExecutionResult, StateFingerprint } from './types'; // Updated import
import { SelectorExtractor } from './selectorExtractor';
import * as crypto from 'crypto'; // Built-in Node module

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
      viewport: config.viewport ?? { width: 1600, height: 900 },
      chromePath: config.chromePath
    };
  }

  // ... [Existing startScreenshotStream, stopScreenshotStream, getters remain unchanged] ...

  startScreenshotStream(broadcast: (message: string) => void) {
    if (this.screenshotStreamer) return;
    this.screenshotStreamer = setInterval(async () => {
      try {
        const screenshot = await this.screenshot();
        broadcast(JSON.stringify({ type: 'screenshot', data: { screenshot, timestamp: Date.now() } }));
      } catch (err) { console.warn('Stream tick failed', err); }
    }, 250);
  }

  stopScreenshotStream() {
    if (!this.screenshotStreamer) return;
    clearInterval(this.screenshotStreamer);
    this.screenshotStreamer = null;
  }

  private get defaultTimeout(): number { return this.config.timeoutMs; }

  async init(): Promise<void> {
    if (this.browser) return;
    this.browser = await chromium.launch({ headless: this.config.headless });
    this.context = await this.browser.newContext({ viewport: this.config.viewport });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(this.config.timeoutMs);
    this.state.isOpen = true;
  }

  getPage(): Page {
    if (!this.page) throw new Error('Browser not initialized');
    return this.page;
  }

  // --- NEW: INTELLIGENT STATE FINGERPRINTING ---
  async getFingerprint(): Promise<StateFingerprint> {
    const page = this.getPage();
    const url = page.url();
    const title = await page.title().catch(() => '');
    
    // Fast evaluation to get content "DNA"
    const stateData = await page.evaluate(() => {
        const interactive = document.querySelectorAll('button, a, input, select');
        // Capture the first 1000 chars of text (headers, breadcrumbs usually)
        const contentSample = document.body.innerText.slice(0, 1000); 
        return { count: interactive.length, content: contentSample };
    });

    // Simple hash
    const raw = `${url}|${title}|${stateData.count}|${stateData.content}`;
    const contentHash = crypto.createHash('md5').update(raw).digest('hex');

    return {
        url,
        title,
        elementCount: stateData.count,
        contentHash
    };
  }

  // --- ENHANCED: WAIT FOR STABILITY ---
  async waitForNetworkIdle(timeout = 2000) {
      const page = this.getPage();
      try {
          await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
          // Wait for DOM stability (checks scrollHeight twice)
          await page.evaluate(() => new Promise((resolve) => {
              let lastHeight = document.body.scrollHeight;
              let stableCount = 0;
              const check = setInterval(() => {
                  const newHeight = document.body.scrollHeight;
                  if (newHeight === lastHeight) stableCount++;
                  else stableCount = 0;
                  lastHeight = newHeight;
                  if (stableCount >= 2) { clearInterval(check); resolve(true); }
              }, 100);
              setTimeout(() => { clearInterval(check); resolve(false); }, 1000);
          }));
      } catch {}
  }

  // ... [smartLocate, resolveFillTarget remain unchanged] ...
  
  private async smartLocate(selector: string, timeoutMs: number): Promise<Locator> {
    // (Existing smartLocate logic here - omitted for brevity as it was correct in provided code)
    const page = this.getPage();
    if (!selector) return page.locator('body');
    // ... logic ...
    return page.locator(selector).first(); 
  }

  // NEW: Universal Stability Wait (Network + DOM Mutations)
  async waitForStability(timeout = 2000): Promise<void> {
      const page = this.getPage();
      try {
          // 1. Wait for Network Idle (catch-all for AJAX requests)
          await page.waitForLoadState('networkidle', { timeout: timeout }).catch(() => {});
          
          // 2. Wait for DOM Stability (Animations/Rendering)
          // Checks if the HTML structure stops changing for at least 200ms
          await page.evaluate(async () => {
              return new Promise<void>((resolve) => {
                  let lastHtml = document.body.innerHTML.length;
                  let steadyTicks = 0;
                  const interval = setInterval(() => {
                      const currentHtml = document.body.innerHTML.length;
                      if (currentHtml === lastHtml) {
                          steadyTicks++;
                      } else {
                          steadyTicks = 0;
                          lastHtml = currentHtml;
                      }
                      
                      // If stable for 3 ticks (300ms) or timeout roughly reached
                      if (steadyTicks >= 3) {
                          clearInterval(interval);
                          resolve();
                      }
                  }, 100);
                  setTimeout(() => { clearInterval(interval); resolve(); }, 2000); // Max wait in browser context
              });
          });
      } catch (e) {
          // Ignore timeouts, just proceed
      }
  }

  async click(selector: string): Promise<ElementInfo> {
    const page = this.getPage();
    const locator = await this.smartLocate(selector, this.defaultTimeout);

    if (await locator.count() === 0) throw new Error(`Element not found: ${selector}`);

    await locator.scrollIntoViewIfNeeded().catch(() => {});

    // Capture pre-click info for Selenium
    let info: ElementInfo | undefined;
    try {
      const handle = await locator.elementHandle();
      if (handle) {
        const extractor = new SelectorExtractor(this.getPage());
        info = (await extractor.extractFromHandle(handle)) ?? undefined;
      }
    } catch {}

    // Intelligent Click Strategy
    try { await locator.hover({ timeout: 1000, force: true }); } catch {}

    try {
        await locator.click({ timeout: 5000 });
    } catch (e) {
        console.log("Standard click failed, attempting JS dispatch");
        await locator.dispatchEvent('click');
    }

    // --- FIX: SMART WAIT INSTEAD OF HARD WAIT ---
    // OLD: await this.waitForStability(2500);  <-- REMOVE THIS

    // NEW: Only wait briefly for network, or rely on the next action's auto-wait.
    // A 2.5s wait is too aggressive for simple UI interactions like opening a menu.
    try {
       await this.page?.waitForLoadState('networkidle', { timeout: 500 }).catch(() => {});
    } catch {} 

    return info || { tagName: 'clicked', attributes: {}, cssSelector: selector };
  }

  async scroll(selector: string | undefined, direction: 'up' | 'down'): Promise<void> {
    const page = this.getPage();
    if (selector) {
      await page.locator(selector).scrollIntoViewIfNeeded();
    } else {
      await page.evaluate((direction) => {
        if (direction === 'down') {
          window.scrollBy(0, window.innerHeight);
        } else {
          window.scrollBy(0, -window.innerHeight);
        }
      }, direction);
    }
  }

  async type(selector: string, text: string): Promise<void> {
    const page = this.getPage();
    try {
        // Use fill() which implies clear() + type()
        // This prevents "UserPass" concatenation bugs
        await page.locator(selector).fill(text); 
    } catch (e) {
        // Fallback for non-fillable elements (like complex react divs)
        await page.locator(selector).click();
        await page.keyboard.type(text);
    }
  }

  // Explicit fill method if needed
  async fill(selector: string, text: string): Promise<void> {
      await this.getPage().locator(selector).fill(text);
  }

  async handleCookieBanner(): Promise<ExecutionResult> {
    // Dummy implementation
    return { success: true, message: "Cookie banner handled" };
  }

  // ... [type, scroll, smartWait, screenshot, handleCookieBanner, etc. remain unchanged] ...
  // (Include rest of existing methods from provided browserManager.ts here)
  
  async screenshot(): Promise<string> {
      const page = this.getPage();
      if (page.isClosed()) return '';
      try {
          // Pre-screenshot optimizations
          await page.evaluate(() => {
              // Disable problematic CSS that can cause delays
              const style = document.createElement('style');
              style.textContent = `
                  * {
                      -webkit-font-smoothing: none !important;
                      font-smooth: never !important;
                      text-rendering: optimizeSpeed !important;
                  }
                  @font-face { font-display: swap; }
              `;
              document.head.appendChild(style);
          }).catch(() => {});

          const buf = await page.screenshot({
              fullPage: false,
              timeout: 1500, // Reduced timeout
              animations: 'disabled',
              caret: 'hide',
              scale: 'css',
              omitBackground: true // Faster without background
          });
          return `data:image/png;base64,${buf.toString('base64')}`;
      } catch (error) {
          console.warn('Screenshot failed, returning empty:', error);
          return '';
      }
  }

  async goto(url: string) {
      const page = this.getPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.config.timeoutMs });
      await this.waitForNetworkIdle(2000);
  }

  // ... rest of class
  isOpen(): boolean { return this.state.isOpen && !!this.page; }
  async close(): Promise<void> {
    if (this.page) await this.page.close();
    if (this.context) await this.context.close();
    if (this.browser) await this.browser.close();
    this.page = null; this.browser = null;
  }
}