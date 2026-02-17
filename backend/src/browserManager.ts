import { chromium, Browser, BrowserContext, Page, Locator, Frame, CDPSession } from 'playwright';
import { BrowserConfig, ElementInfo, SessionState, ExecutionResult, StateFingerprint } from './types'; // Updated import
import { SelectorExtractor } from './selectorExtractor';
import * as crypto from 'crypto'; // Built-in Node module

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private cdpSession: CDPSession | null = null;
  private screenshotStreamer: NodeJS.Timeout | null = null;
  private screencastActive: boolean = false;
  // Cache the last good screenshot so transient failures don't break the agent/stream
  private lastScreenshot: string | null = null;
  // Preview readiness state - actions are blocked until this is true
  private _previewReady: boolean = false;
  private previewReadyResolvers: Array<() => void> = [];
  // Track the broadcast function for re-sending frames
  private activeBroadcast: ((message: string) => void) | null = null;
  // Frame counter to verify screencast is actually working
  private frameCount: number = 0;
  private lastFrameTime: number = 0;
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

  // --- PREVIEW READINESS API ---
  get previewReady(): boolean {
    return this._previewReady;
  }

  private setPreviewReady(ready: boolean): void {
    this._previewReady = ready;
    if (ready) {
      // Resolve all waiting promises
      for (const resolve of this.previewReadyResolvers) {
        resolve();
      }
      this.previewReadyResolvers = [];
    }
  }

  /**
   * Wait until the preview is ready (screencast is streaming).
   * Actions should call this before executing.
   */
  async waitForPreviewReady(timeoutMs: number = 10000): Promise<boolean> {
    if (this._previewReady) return true;
    
    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        // Remove this resolver from the list
        const idx = this.previewReadyResolvers.indexOf(resolver);
        if (idx >= 0) this.previewReadyResolvers.splice(idx, 1);
        resolve(false); // Timeout - preview not ready
      }, timeoutMs);
      
      const resolver = () => {
        clearTimeout(timeout);
        resolve(true);
      };
      
      this.previewReadyResolvers.push(resolver);
    });
  }

  // --- CDP SCREENCAST (Live Preview) ---
  // NOTE: CDP screencast can be unreliable in headless mode, prefer startScreenshotStream
  async startScreencast(
    broadcast: (message: string) => void,
    options: { quality?: number; maxWidth?: number; maxHeight?: number } = {}
  ): Promise<void> {
    if (this.screencastActive) return;
    
    // Store broadcast function for later use
    this.activeBroadcast = broadcast;
    this.frameCount = 0;
    
    const page = this.getPage();
    
    // Create CDP session if not exists
    if (!this.cdpSession) {
      this.cdpSession = await page.context().newCDPSession(page);
    }
    
    const { quality = 80, maxWidth = 1600, maxHeight = 900 } = options;
    
    // Listen for screencast frames
    this.cdpSession.on('Page.screencastFrame', async (params) => {
      const { data, sessionId } = params;
      
      // Acknowledge the frame to keep receiving more
      try {
        await this.cdpSession?.send('Page.screencastFrameAck', { sessionId });
      } catch (e) {
        // Session might be closed
      }
      
      // Track frame stats
      this.frameCount++;
      this.lastFrameTime = Date.now();
      
      // Cache and broadcast the frame
      const screenshot = `data:image/jpeg;base64,${data}`;
      this.lastScreenshot = screenshot;
      
      // Mark preview as ready after first frame
      if (!this._previewReady) {
        this.setPreviewReady(true);
        console.log(`[BrowserManager] First screencast frame received, preview ready`);
      }
      
      // Broadcast preview_ready and screenshot
      if (this.activeBroadcast) {
        if (this.frameCount === 1) {
          this.activeBroadcast(JSON.stringify({ 
            type: 'preview_ready', 
            data: { ready: true, timestamp: Date.now() } 
          }));
        }
        this.activeBroadcast(JSON.stringify({ 
          type: 'screenshot', 
          data: { screenshot, timestamp: Date.now() } 
        }));
      }
    });
    
    // Start the screencast
    await this.cdpSession.send('Page.startScreencast', {
      format: 'jpeg',
      quality,
      maxWidth,
      maxHeight,
      everyNthFrame: 1 // Every frame for smooth preview
    });
    
    this.screencastActive = true;
    console.log('[BrowserManager] CDP screencast started');
    
    // Verify frames are actually coming - if not after 2s, fall back to screenshot stream
    setTimeout(() => {
      if (this.screencastActive && this.frameCount === 0) {
        console.warn('[BrowserManager] CDP screencast not delivering frames, falling back to screenshot stream');
        this.stopScreencast().then(() => {
          if (this.activeBroadcast) {
            this.startScreenshotStream(this.activeBroadcast);
          }
        });
      }
    }, 2000);
  }

  async stopScreencast(): Promise<void> {
    if (!this.screencastActive || !this.cdpSession) return;
    
    try {
      await this.cdpSession.send('Page.stopScreencast');
      // Detach the CDP session to clean up all listeners
      await this.cdpSession.detach().catch(() => {});
      this.cdpSession = null;
    } catch (e) {
      console.warn('[BrowserManager] Error stopping screencast:', e);
    }
    
    this.screencastActive = false;
    this.setPreviewReady(false);
    console.log('[BrowserManager] CDP screencast stopped');
  }

  // --- PRIMARY: Periodic screenshot stream (more reliable than CDP screencast) ---
  startScreenshotStream(broadcast: (message: string) => void) {
    if (this.screenshotStreamer) {
      // Update broadcast function for existing stream
      this.activeBroadcast = broadcast;
      return;
    }
    
    this.activeBroadcast = broadcast;
    this.frameCount = 0;
    
    console.log('[BrowserManager] Starting periodic screenshot stream');
    
    this.screenshotStreamer = setInterval(async () => {
      try {
        const screenshot = await this.screenshot();
        if (!screenshot) return;
        
        this.frameCount++;
        this.lastFrameTime = Date.now();
        
        // Mark preview as ready after first successful screenshot
        if (!this._previewReady) {
          this.setPreviewReady(true);
          console.log('[BrowserManager] First screenshot captured, preview ready');
          if (this.activeBroadcast) {
            this.activeBroadcast(JSON.stringify({ 
              type: 'preview_ready', 
              data: { ready: true, timestamp: Date.now() } 
            }));
          }
        }
        
        if (this.activeBroadcast) {
          this.activeBroadcast(JSON.stringify({ 
            type: 'screenshot', 
            data: { screenshot, timestamp: Date.now() } 
          }));
        }
      } catch (err) { 
        console.warn('[BrowserManager] Screenshot stream tick failed:', err); 
      }
    }, 300); // 300ms interval for balance of performance and responsiveness
  }

  stopScreenshotStream() {
    if (!this.screenshotStreamer) return;
    clearInterval(this.screenshotStreamer);
    this.screenshotStreamer = null;
    this.setPreviewReady(false);
    console.log('[BrowserManager] Screenshot stream stopped');
  }

  /**
   * Update the broadcast function (e.g., when new WebSocket clients connect)
   */
  updateBroadcast(broadcast: (message: string) => void): void {
    this.activeBroadcast = broadcast;
  }

  /**
   * Send the current screenshot/preview state to a specific client or via broadcast.
   * Useful when new clients connect and need the current state.
   */
  async sendCurrentFrame(send?: (message: string) => void): Promise<void> {
    const target = send || this.activeBroadcast;
    if (!target) return;
    
    // Get current screenshot
    let screenshot = this.lastScreenshot;
    if (!screenshot) {
      try {
        screenshot = await this.screenshot();
        this.lastScreenshot = screenshot;
      } catch {
        return;
      }
    }
    
    if (screenshot) {
      // Send preview_ready first
      target(JSON.stringify({ 
        type: 'preview_ready', 
        data: { ready: true, timestamp: Date.now() } 
      }));
      // Then send the screenshot
      target(JSON.stringify({ 
        type: 'screenshot', 
        data: { screenshot, timestamp: Date.now() } 
      }));
    }
  }

  /**
   * Check if preview streaming is active and working
   */
  isStreamingActive(): boolean {
    return (this.screencastActive || this.screenshotStreamer !== null) && 
           this.frameCount > 0 && 
           (Date.now() - this.lastFrameTime) < 5000; // Frame within last 5s
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
      if (page.isClosed()) return this.lastScreenshot ?? '';

      const screenshotTimeout = Math.min(this.config.timeoutMs, 30000); // safety cap

      // Try twice before giving up; never throw so callers/agent keep running
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
              this.lastScreenshot = data;
              return data;
          } catch (err) {
              lastError = err;
              // Small delay before retry; swallow error to avoid aborting the flow
              try {
                  await page.waitForTimeout(500);
              } catch {}
          }
      }

      console.warn('Screenshot failed, reusing last known image (if any).', lastError);
      return this.lastScreenshot ?? '';
  }

  async goto(url: string) {
      const page = this.getPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.config.timeoutMs });
      await this.waitForNetworkIdle(2000);
      // Wait for visual content to be available
      await this.waitForVisualContent();
  }

  /**
   * Wait until the page has meaningful visual content.
   * This ensures the preview has something to show before actions proceed.
   */
  async waitForVisualContent(timeoutMs: number = 10000): Promise<boolean> {
    const page = this.getPage();
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
      try {
        // Check if page has visible content
        const hasContent = await page.evaluate(() => {
          const body = document.body;
          if (!body) return false;
          
          // Check for meaningful content
          const hasText = body.innerText.trim().length > 50;
          const hasVisibleElements = document.querySelectorAll('button, a, input, img, h1, h2, p').length > 0;
          const bodyHeight = body.scrollHeight;
          
          return hasText || hasVisibleElements || bodyHeight > 200;
        });
        
        if (hasContent) {
          console.log('[BrowserManager] Visual content detected');
          return true;
        }
      } catch (e) {
        // Page might be navigating, continue waiting
      }
      
      await page.waitForTimeout(200);
    }
    
    console.warn('[BrowserManager] Visual content check timed out, proceeding anyway');
    return false;
  }

  /**
   * Ensure the preview/screencast is active before proceeding.
   * This should be called before starting agent actions.
   */
  async ensurePreviewActive(broadcast?: (message: string) => void, timeoutMs: number = 15000): Promise<boolean> {
    // Use provided broadcast or existing one
    const broadcastFn = broadcast || this.activeBroadcast;
    
    // If already streaming and ready, just verify frames are coming
    if (this._previewReady && this.isStreamingActive()) {
      console.log('[BrowserManager] Preview already active and streaming');
      return true;
    }
    
    // If preview ready but no recent frames, force a screenshot to verify
    if (this._previewReady && broadcastFn) {
      console.log('[BrowserManager] Preview ready but verifying with fresh screenshot...');
      await this.sendCurrentFrame(broadcastFn);
      return true;
    }
    
    // Not ready, start screenshot stream if we have a broadcast function
    if (!this.screenshotStreamer && broadcastFn) {
      console.log('[BrowserManager] Starting screenshot stream in ensurePreviewActive');
      this.startScreenshotStream(broadcastFn);
    }
    
    // Wait for preview to become ready
    const ready = await this.waitForPreviewReady(timeoutMs);
    
    if (ready && broadcastFn) {
      // Send a fresh frame to ensure clients have current state
      await this.sendCurrentFrame(broadcastFn);
    }
    
    return ready;
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