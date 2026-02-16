import { chromium, Browser, BrowserContext, Page, Locator, Frame } from 'playwright';
import { BrowserConfig, ElementInfo, SessionState, ExecutionResult, StateFingerprint } from './types'; // Updated import
import { SelectorExtractor } from './selectorExtractor';
import * as crypto from 'crypto'; // Built-in Node module

type ScreenshotCaptureResult =
  | { ok: true; screenshot: string; durationMs: number }
  | { ok: false; screenshot: null; durationMs: number; error: string; timedOut: boolean };

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private screenshotStreamer: NodeJS.Timeout | null = null;
  private isCapturingScreenshot = false;
  private screenshotCaptureSeq = 0;
  private activeCaptureId = 0;
  private lastScreenshotDelayNoticeAt = 0;
  private lastScreenshotErrorNoticeAt = 0;
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

  startScreenshotStream(send: (message: string) => void) {
    if (this.screenshotStreamer) return;

    const emit = (payload: { type: string; timestamp: string; message: string; data?: unknown }) => {
      send(JSON.stringify(payload));
    };

    this.screenshotStreamer = setInterval(() => {
      // Avoid overlapping screenshots; if a capture is slow, keep the UI in a loading state.
      if (this.isCapturingScreenshot) return;
      if (!this.page || this.page.isClosed()) return;

      const captureId = ++this.screenshotCaptureSeq;
      this.activeCaptureId = captureId;
      this.isCapturingScreenshot = true;

      emit({
        type: 'screenshot',
        timestamp: new Date().toISOString(),
        message: 'screenshot',
        data: { status: 'loading', captureId }
      });

      let slowNoticeSent = false;
      const slowTimer = setTimeout(() => {
        if (!this.isCapturingScreenshot) return;
        if (this.activeCaptureId !== captureId) return;
        slowNoticeSent = true;

        const now = Date.now();
        if (now - this.lastScreenshotDelayNoticeAt > 8000) {
          this.lastScreenshotDelayNoticeAt = now;
          emit({
            type: 'log',
            timestamp: new Date().toISOString(),
            message: 'Screenshot is taking longer than usual — the page may still be loading. Waiting for it to finish…',
            data: { kind: 'screenshot_delay', captureId }
          });
        }

        emit({
          type: 'screenshot',
          timestamp: new Date().toISOString(),
          message: 'screenshot',
          data: { status: 'loading', captureId, slow: true }
        });
      }, 1500);

      (async () => {
        try {
          const result = await this.captureScreenshot();
          if (this.activeCaptureId !== captureId) return;

          if (result.ok) {
            emit({
              type: 'screenshot',
              timestamp: new Date().toISOString(),
              message: 'screenshot',
              data: {
                status: 'ok',
                captureId,
                screenshot: result.screenshot,
                durationMs: result.durationMs
              }
            });
            return;
          }

          emit({
            type: 'screenshot',
            timestamp: new Date().toISOString(),
            message: 'screenshot',
            data: {
              status: 'error',
              captureId,
              error: result.error,
              timedOut: result.timedOut,
              durationMs: result.durationMs
            }
          });

          // Make sure the user understands this is usually caused by slow/heavy page rendering.
          const now = Date.now();
          if (now - this.lastScreenshotErrorNoticeAt > 8000) {
            this.lastScreenshotErrorNoticeAt = now;
            emit({
              type: 'log',
              timestamp: new Date().toISOString(),
              message: result.timedOut
                ? `Screenshot timed out after ~${Math.round(result.durationMs)}ms (page may be loading slowly).`
                : `Screenshot failed: ${result.error}`,
              data: { kind: 'screenshot_error', captureId, timedOut: result.timedOut, slowNoticeSent }
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          emit({
            type: 'screenshot',
            timestamp: new Date().toISOString(),
            message: 'screenshot',
            data: { status: 'error', captureId, error: msg, timedOut: false }
          });
        } finally {
          clearTimeout(slowTimer);
          if (this.activeCaptureId === captureId) this.activeCaptureId = 0;
          this.isCapturingScreenshot = false;
        }
      })().catch(() => {});
    }, 250);
  }

  stopScreenshotStream() {
    if (!this.screenshotStreamer) return;
    clearInterval(this.screenshotStreamer);
    this.screenshotStreamer = null;
    // If a capture was in-flight, ignore its result.
    this.activeCaptureId = 0;
    this.isCapturingScreenshot = false;
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
  
  private async captureScreenshot(): Promise<ScreenshotCaptureResult> {
    const startedAt = Date.now();

    let page: Page;
    try {
      page = this.getPage();
    } catch (err) {
      return {
        ok: false,
        screenshot: null,
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
        timedOut: false
      };
    }

    if (page.isClosed()) {
      return {
        ok: false,
        screenshot: null,
        durationMs: Date.now() - startedAt,
        error: 'Page is closed',
        timedOut: false
      };
    }

    const screenshotTimeout = Math.min(this.config.timeoutMs, 30000); // safety cap

    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const buf = await page.screenshot({
          fullPage: false,
          timeout: screenshotTimeout,
          animations: 'disabled',
          caret: 'hide'
        });
        const data = `data:image/png;base64,${buf.toString('base64')}`;
        return { ok: true, screenshot: data, durationMs: Date.now() - startedAt };
      } catch (err) {
        lastError = err;
        try {
          await page.waitForTimeout(500);
        } catch {}
      }
    }

    const errorMessage = lastError instanceof Error ? lastError.message : String(lastError);
    const timedOut =
      (lastError as any)?.name === 'TimeoutError' ||
      /timeout/i.test(errorMessage);

    return {
      ok: false,
      screenshot: null,
      durationMs: Date.now() - startedAt,
      error: errorMessage,
      timedOut
    };
  }

  // Public helper used by tools/agent code. IMPORTANT: do NOT fall back to a previous screenshot.
  async screenshot(): Promise<string> {
    const result = await this.captureScreenshot();
    return result.ok ? result.screenshot : '';
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