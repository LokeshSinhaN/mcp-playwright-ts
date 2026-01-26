import { GenerativeModel } from '@google/generative-ai';
import OpenAI from 'openai';
import { BrowserManager } from './browserManager';
import { SelectorExtractor } from './selectorExtractor';
import { SeleniumGenerator } from './seleniumGenerator';
import {
  ExecutionCommand,
  ExecutionResult,
  ElementInfo,
  AgentAction,
  AgentStepResult,
  AgentSessionResult,
  AgentConfig,
  StateFingerprint
} from './types';
import { selectFromDropdown, selectOptionInOpenDropdown, parseDropdownInstruction, DropdownIntent } from './dropdownUtils';

export class McpTools {
  private sessionHistory: ExecutionCommand[] = [];
  private agentCommandBuffer: ExecutionCommand[] | null = null;

  private recordCommand(cmd: ExecutionCommand | ExecutionCommand[]): void {
    const cmds = Array.isArray(cmd) ? cmd : [cmd];
    if (this.agentCommandBuffer) {
      this.agentCommandBuffer.push(...cmds);
    } else {
      this.sessionHistory.push(...cmds);
    }
  }

  constructor(
    private readonly browser: BrowserManager, 
    private readonly gemini?: GenerativeModel,
    private readonly openai?: OpenAI
  ) {}

  // ... [extractUrlFromPrompt, extractDomain helper methods] ...
  private extractUrlFromPrompt(prompt: string): string | null {
    const match = prompt.match(/https?:\/\/[^\s]+/);
    return match ? match[0] : null;
  }
  private extractDomain(url: string): string {
    try { return new URL(url).hostname; } catch { return url; }
  }

  // ... [navigate, click, type methods tailored for direct API use] ...
  // (Keeping these briefly as they are used by the server direct endpoints)
  async navigate(url: string): Promise<ExecutionResult> {
      try {
          await this.browser.goto(url);
          await this.browser.handleCookieBanner();
          this.recordCommand({ action: 'navigate', target: url });
          return { success: true, message: `Navigated to ${url}` };
      } catch (e: any) { return { success: false, message: e.message }; }
  }

  async clickExact(selector: string, desc?: string): Promise<ExecutionResult> {
      try {
          const info = await this.browser.click(selector);
          this.recordCommand({ action: 'click', target: selector, description: desc });
          return { success: true, message: `Clicked ${desc || selector}`, selectors: [info] };
      } catch (e: any) { return { success: false, message: e.message }; }
  }

  async type(selector: string, text: string): Promise<ExecutionResult> {
    try {
      await this.browser.type(selector, text);
      this.recordCommand({ action: 'type', target: selector, value: text });
      return { success: true, message: `Typed "${text}" into ${selector}` };
    } catch (e: any) {
      return { success: false, message: e.message };
    }
  }

  async observe(): Promise<ExecutionResult> {
    try {
      const extractor = new SelectorExtractor(this.browser.getPage());
      const elements = await extractor.extractAllInteractive();
      return { success: true, message: 'Observed page', selectors: elements };
    } catch (e: any) {
      return { success: false, message: e.message };
    }
  }

  async handleCookieBanner(): Promise<ExecutionResult> {
    try {
      await this.browser.handleCookieBanner();
      return { success: true, message: 'Cookie banner dismissed' };
    } catch (e: any) {
      return { success: false, message: e.message };
    }
  }

  // ===========================================================================
  // =================== INTELLIGENT AGENT LOGIC ===============================
  // ===========================================================================

  async runAutonomousAgent(goal: string, config: AgentConfig = {}): Promise<AgentSessionResult> {
    const maxSteps = config.maxSteps ?? 30;
    const maxRetries = 1;
    
    this.sessionHistory = []; 
    const steps: AgentStepResult[] = [];
    const failedElements: Set<string> = new Set();
    const actionHistory: string[] = [];
    
    // ADD: Loop detection
    const recentActions: string[] = [];
    const MAX_IDENTICAL_ACTIONS = 2;

    await this.browser.init();
    const page = this.browser.getPage();

    const urlInGoal = this.extractUrlFromPrompt(goal);
    if (urlInGoal) {
        const currentUrl = page.url();
        if (currentUrl === 'about:blank' || !currentUrl.includes(this.extractDomain(urlInGoal))) {
             await this.navigate(urlInGoal);
             actionHistory.push(`[SUCCESS] Navigated to ${urlInGoal}`);
             await page.waitForTimeout(1000);
        }
    }

    let stepNumber = 0;
    let isFinished = false;

    while (stepNumber < maxSteps && !isFinished) {
      stepNumber++;

      const extractor = new SelectorExtractor(page);
      let elements = await extractor.extractAllInteractive();
      const screenshotObj = await this.browser.screenshot();
      const screenshotBase64 = screenshotObj.replace('data:image/png;base64,', '');

      let nextAction = await this.planNextAgentAction(
        goal,
        elements,
        actionHistory,
        failedElements,
        screenshotBase64,
        config.modelProvider
      );

      config.broadcast?.({
          type: 'log', timestamp: new Date().toISOString(),
          message: `ai_thought: ${nextAction.thought}`,
          data: { role: 'agent-reasoning', thought: nextAction.thought }
      });

      // Before executing the action
      const progressCheck = await this.validateProgress(goal, nextAction, actionHistory);
      if (!progressCheck.onTrack) {
          console.warn(`[Progress Check Failed] ${progressCheck.reason}`);
          config.broadcast?.({
              type: 'log',
              timestamp: new Date().toISOString(),
              message: `⚠️ Progress concern: ${progressCheck.reason}`,
              data: { progress: progressCheck }
          });
      }

      // ADD: Loop detection
      const actionSignature = `${nextAction.type}:${(nextAction as any).selector || (nextAction as any).semanticTarget || ''}`;
      recentActions.push(actionSignature);
      if (recentActions.length > MAX_IDENTICAL_ACTIONS) recentActions.shift();
      
      const identicalCount = recentActions.filter(a => a === actionSignature).length;
      if (identicalCount >= MAX_IDENTICAL_ACTIONS && nextAction.type !== 'finish') {
          console.warn(`[LOOP DETECTED] Same action repeated ${identicalCount} times: ${actionSignature}`);
          actionHistory.push(`[LOOP] Detected repetition: ${actionSignature}`);
          
          // Force finish if stuck
          nextAction = { 
              type: 'finish', 
              thought: 'Loop detected, ending to prevent infinite retries',
              summary: 'Task ended due to repetitive actions - possible completion or blocker'
          };
      }

      let retryCount = 0;
      let actionSuccess = false;
      let actionMessage = '';
      let stateChanged = false;
      let result: ExecutionResult | undefined;

      while (retryCount <= maxRetries && !actionSuccess) {
           this.agentCommandBuffer = []; 
           
           result = await this.executeAgentAction(nextAction, elements);
           actionSuccess = result.success;
           actionMessage = result.message;
           stateChanged = result.stateChanged ?? false;

           if (result.success && nextAction.type === 'click' && !stateChanged) {
               const target = nextAction.semanticTarget?.toLowerCase() || '';
               const criticalClick = target.includes('log') || target.includes('sign') || 
                                   target.includes('search') || target.includes('go') || 
                                   target.includes('submit') || target.includes('export'); // ADD export
               
               if (criticalClick) {
                   actionSuccess = false; 
                   actionMessage = "Click successful but page state did not change (Dead Click). Retrying...";
                   if (result.failedSelector) failedElements.add(result.failedSelector);
               }
           }

           if (actionSuccess) {
               if (this.agentCommandBuffer.length > 0) this.sessionHistory.push(...this.agentCommandBuffer);
           } else {
               retryCount++;
               if (result?.failedSelector) failedElements.add(result?.failedSelector);
               await page.waitForTimeout(1000);

                if (!actionSuccess && retryCount > 0) {
                    console.log(`[Agent] Retry ${retryCount}: Re-extracting elements...`);
                    
                    // RE-OBSERVE the page - maybe elements changed
                    const freshExtractor = new SelectorExtractor(page);
                    elements = await freshExtractor.extractAllInteractive();
                    
                    // Re-plan with fresh elements
                    nextAction = await this.planNextAgentAction(
                        goal,
                        elements,
                        actionHistory,
                        failedElements,
                        screenshotBase64,
                        config.modelProvider
                    );
                }
           }
      }

      const actionDesc = this.describeAction(nextAction, actionSuccess);
      actionHistory.push(actionDesc);
      
      if (nextAction.type === 'finish') isFinished = true; // Remove actionSuccess check

      steps.push({ 
          stepNumber, action: nextAction, success: actionSuccess, message: actionMessage, 
          urlBefore: '', urlAfter: page.url(), stateChanged, retryCount, 
          screenshot: screenshotBase64 
      });
    }

    return { 
        success: isFinished, 
        summary: isFinished ? "Task completed successfully" : "Task ended - max steps reached", 
        goal, 
        totalSteps: stepNumber, 
        steps, 
        commands: this.sessionHistory, 
        seleniumCode: await new SeleniumGenerator().generate(this.sessionHistory)
    };
  }

  // --- EXECUTE ACTION WITH STATE AWARENESS ---
  private async executeAgentAction(action: AgentAction, elements: ElementInfo[]): Promise<ExecutionResult> {
    
    // 1. Capture State BEFORE
    let fingerprintBefore: StateFingerprint | null = null;
    try { fingerprintBefore = await this.browser.getFingerprint(); } catch {}

    let result: ExecutionResult = { success: false, message: '' };

    const resolveSelector = (id?: string, sel?: string): string | undefined => {
        if (sel) return sel;
        if (id && id.startsWith('el_')) {
            const idx = parseInt(id.split('_')[1]);
            return elements[idx]?.cssSelector || elements[idx]?.selector;
        }
        return undefined;
    };

    try {
        if (action.type === 'click') {
            const sel = resolveSelector(action.elementId, action.selector);
            
    // DEBUG: Log what we're trying to click
    console.log(`[Agent Click Attempt]`);
    console.log(`  semanticTarget: "${action.semanticTarget}"`);
    console.log(`  elementId: ${action.elementId}`);
    console.log(`  resolved selector: ${sel}`);
    
    // DEBUG: Check if element exists in the DOM
    if (sel) {
        const page = this.browser.getPage();
        const count = await page.locator(sel).count();
        console.log(`  element count in DOM: ${count}`);
    }
            
            if (sel) {
                try {
                    const clickRes = await this.browser.click(sel);
                    result = { success: true, message: `Clicked ${action.semanticTarget || sel}`, selectors: [clickRes], failedSelector: sel };
                } catch (e: any) {
                    console.warn(`[Agent] Click failed on selector: ${sel}, falling back to semantic target`);
                    result = { success: false, message: e.message, failedSelector: sel };
                }
            }
            
            // IMPROVED FALLBACK (from previous fix)
            if (!result.success && action.semanticTarget) {
                const page = this.browser.getPage();
                const target = action.semanticTarget.trim();
                
                console.log(`[Agent] Attempting intelligent text-based click for: "${target}"`);
                
                // Try multiple strategies...
                const strategies = [
                    { name: 'exact-text', fn: () => page.getByText(target, { exact: true }).first() },
                    { name: 'role-link', fn: () => page.getByRole('link', { name: new RegExp(target, 'i') }).first() },
                    { name: 'role-button', fn: () => page.getByRole('button', { name: new RegExp(target, 'i') }).first() },
                    { name: 'partial-text', fn: () => page.getByText(new RegExp(target, 'i')).first() },
                    { name: 'xpath', fn: () => page.locator(`xpath=//*[contains(text(), '${target.replace(/'/g, "\\'")}') or @aria-label='${target.replace(/'/g, "\\'")}']`).first() }
                ];
                
                for (const strategy of strategies) {
                    try {
                        const locator = strategy.fn();
                        if (await locator.count() > 0) {
                            await locator.click({ timeout: 3000 });
                            result = { success: true, message: `Clicked "${target}" via ${strategy.name}` };
                            this.recordCommand({ action: 'click', target: `${strategy.name}:${target}`, description: action.semanticTarget });
                            console.log(`[Agent] ✓ Success with strategy: ${strategy.name}`);
                            break;
                        }
                    } catch (e) {
                        console.warn(`[Agent] Strategy ${strategy.name} failed for "${target}"`);
                    }
                }
            }
            
            if (!result.success) {
                result = { success: false, message: "No valid selector or text found for click" };
            }
            
            // INTELLIGENT VERIFICATION (after any successful click)
            if (result.success && fingerprintBefore) {
                const verification = await this.verifyClickSuccess(action, fingerprintBefore);
                
                if (!verification.verified) {
                    // Low confidence = treat as failure
                    console.warn(`[Agent] Click verification failed: ${verification.reason}`);
                    result.success = false;
                    result.message = `Click executed but no change detected: ${verification.reason}`;
                    result.stateChanged = false;
                } else {
                    // Success! Log confidence level
                    console.log(`[Agent] ✓ Click verified (${verification.confidence}% confidence): ${verification.reason}`);
                    result.stateChanged = true;
                    result.message = `${result.message} [Verified: ${verification.reason}]`;
                }
            }
        } 
        else if (action.type === 'type') {
            const sel = resolveSelector(action.elementId, action.selector);
            if (sel) {
                await this.browser.type(sel, action.text);
                this.recordCommand({ action: 'type', target: sel, value: action.text });
                result = { success: true, message: `Typed "${action.text}"`, failedSelector: sel, stateChanged: true };
            } else {
                result = { success: false, message: "No selector for type" };
            }
        }
        else if (action.type === 'scroll') {
             await this.browser.scroll(undefined, action.direction);
             result = { success: true, message: "Scrolled", stateChanged: true };
        }
        else if (action.type === 'wait') {
             await new Promise(r => setTimeout(r, action.durationMs));
             result = { success: true, message: "Waited", stateChanged: true };
        }
        else if (action.type === 'finish') {
             result = { success: true, message: action.summary, stateChanged: true };
        }
        else if (action.type === 'navigate') {
             await this.navigate(action.url);
             result = { success: true, message: `Navigated to ${action.url}`, stateChanged: true };
        }
    } catch (e: any) {
        let failedSelector: string | undefined = undefined;
        if ('selector' in action) {
            failedSelector = action.selector;
        }
        return { success: false, message: e.message, failedSelector };
    }

    return result;
}

  // --- ROBUST PLANNING & PARSING (From Reference File) ---
  
  private async planNextAgentAction(
    goal: string,
    elements: ElementInfo[],
    history: string[],
    failedElements: Set<string>,
    screenshot: string,
    provider: 'gemini' | 'openai' = 'gemini'
  ): Promise<AgentAction> {
      
      const page = this.browser.getPage();
      const currentUrl = page.url();
      const currentTitle = await page.title().catch(() => '');
      
      const visibleEl = elements.filter(el => 
          el.visible && 
          !failedElements.has(el.cssSelector || '') &&
          !failedElements.has(el.selector || '') && 
          el.tagName !== 'script'
      );

      const simplified = visibleEl.slice(0, 200).map((el, i) => ({
          id: `el_${i}`,
          tag: el.tagName,
          text: (el.text || '').slice(0, 60).replace(/\s+/g, ' ').trim(),
          label: el.ariaLabel || el.placeholder || '',
          role: el.roleHint,
          region: el.region,
          selector: el.cssSelector
      }));

      // ADD: Contextual page understanding
      const pageContext = await page.evaluate(() => {
          // Get the most prominent text on the page
          const headings = Array.from(document.querySelectorAll('h1, h2, h3')).map(h => h.textContent?.trim()).filter(Boolean).slice(0, 5);
          
          // Get all visible navigation links
          const navLinks = Array.from(document.querySelectorAll('nav a, header a, [role="navigation"] a')).map(a => a.textContent?.trim()).filter(Boolean);
          
          // Get breadcrumbs if present
          const breadcrumbs = Array.from(document.querySelectorAll('[aria-label*="breadcrumb" i] *, .breadcrumb *')).map(b => b.textContent?.trim()).filter(Boolean);
          
          return { headings, navLinks, breadcrumbs };
      });

      const recentHistory = history.slice(-5).join('\n');
      
      const prompt = `
SYSTEM: Web Automation Agent
GOAL: "${goal}"

CURRENT PAGE STATE:
- URL: ${currentUrl}
- Page Title: "${currentTitle}"
- Main Headings: ${pageContext.headings.join(' | ') || 'None visible'}
- Navigation Links Available: ${pageContext.navLinks.join(', ') || 'None found'}
- Breadcrumbs: ${pageContext.breadcrumbs.join(' > ') || 'None'}

EXECUTION HISTORY (last 5 actions):
${recentHistory}

FAILED ELEMENTS (do NOT reuse): ${JSON.stringify(Array.from(failedElements).slice(-10))}

VISIBLE UI ELEMENTS:
${JSON.stringify(simplified, null, 2)}

ELEMENT INTERPRETATION GUIDE:
- Elements with role="link" in region="header" are MAIN NAVIGATION (top menu items)
- Elements with text prefixed "[NAV]" are primary navigation - USE THESE for menu navigation
- If you need to go to "Practice" → look for element with text containing "Practice" and role="link"
- If you need to click a button → look for element with role="button" or tag="button"

CRITICAL REASONING STEPS:
1. **WHERE AM I?** Look at URL, title, and headings to understand current location
2. **WHAT DO I SEE?** Check navigation links and visible elements
3. **WHAT DO I NEED?** Parse the goal to extract the next required action
4. **HOW DO I GET THERE?** Match goal requirements to available UI elements

EXAMPLE REASONING:
Goal: "Navigate to Practice -> Appointment view"
Current: On homepage (URL shows /default.aspx, see "Welcome" heading)
Available: Navigation links include "Practice", "EMR", "Billing"
Action: Click "Practice" link (element with text="Practice" and role="link")

PROGRESS CHECK:
- If last 3 actions were the same and failed → try a DIFFERENT element or approach
- If you clicked "Practice" but page didn't change → try clicking it differently (use semanticTarget)
- If goal mentions going to a submenu (like "Appointment view") but you haven't clicked the parent menu ("Practice") → do parent first

RESPONSE FORMAT (JSON only - NO markdown, NO explanations):
{
  "type": "click"|"type"|"navigate"|"wait"|"finish",
  "elementId": "el_X",
  "semanticTarget": "EXACT visible text like 'Practice' or 'Appointment view'",
  "text": "...",
  "thought": "Clear explanation: WHERE I am, WHAT I see, WHY this action moves toward goal",
  "goalComplete": true|false,
  "summary": "What was accomplished"
}

RESPOND WITH VALID JSON ONLY:
`;

      let responseText = '';
      if (provider === 'openai' && this.openai) {
           const completion = await this.openai.chat.completions.create({
               model: "gpt-4o",
               messages: [
                   { role: "system", content: "You are a JSON-only bot. Analyze page context carefully. Always include semanticTarget for clicks." },
                   { role: "user", content: [
                       { type: "text", text: prompt },
                       { type: "image_url", image_url: { url: `data:image/png;base64,${screenshot}` } }
                   ]}
               ],
               response_format: { type: "json_object" },
               temperature: 0.3 // Lower temperature for more deterministic behavior
           });
           responseText = completion.choices[0].message.content || '';
      } else if (this.gemini) {
           const parts: any[] = [{ text: prompt }];
           if (screenshot) parts.push({ inlineData: { data: screenshot, mimeType: 'image/png' } });
           const res = await this.gemini.generateContent({ 
               contents: [{ role: 'user', parts }],
               generationConfig: { temperature: 0.4 } // More focused
           });
           responseText = res.response.text();
      } else {
          return { type: 'finish', thought: 'No AI', summary: 'Config Error' };
      }

      const action = this.parseAgentActionResponse(responseText);
      
      if ('goalComplete' in action && (action as any).goalComplete === true) {
          return { 
              type: 'finish', 
              thought: action.thought || 'Goal completed',
              summary: (action as any).summary || 'Task completed successfully'
          };
      }
      
      if ((action.type === 'click' || action.type === 'type') && action.elementId) {
          const idx = parseInt(action.elementId.split('_')[1]);
          const el = visibleEl[idx];
          if (el) {
              action.selector = el.cssSelector || el.selector;
              if (!action.semanticTarget) {
                  action.semanticTarget = el.text || el.ariaLabel || el.placeholder || '';
              }
          }
      }
      
      return action;
  }

  // Robust Parser from Reference File
  private parseAgentActionResponse(raw: string): AgentAction {
      let clean = raw.replace(/```json\s*|\s*```/gi, '').trim();
      const start = clean.indexOf('{');
      const end = clean.lastIndexOf('}');
      if (start !== -1 && end !== -1) clean = clean.substring(start, end + 1);

      try {
          const parsed = JSON.parse(clean);
          
          // Validate required fields
          if (!parsed.type) {
              if (parsed.action) parsed.type = parsed.action;
              else throw new Error('Missing type field');
          }
          
          if (!parsed.thought) parsed.thought = "Executing action";
          
          // Validate finish requires summary
          if (parsed.type === 'finish' && !parsed.summary) {
              parsed.summary = 'Task completed';
          }
          
          return parsed;
      } catch (e) {
          console.error('[PARSE ERROR]', e, 'Raw:', raw);
          // Intelligent fallback based on content
          if (raw.toLowerCase().includes('finish') || raw.toLowerCase().includes('complete')) {
              return { 
                  type: 'finish', 
                  thought: 'Detected completion intent', 
                  summary: 'Task appears complete' 
              };
          }
          return { type: 'wait', durationMs: 2000, thought: 'Failed to parse JSON, waiting.' };
      }
  }

  private describeAction(action: AgentAction, success: boolean): string {
      let description = `[${success ? 'OK' : 'FAIL'}] ${action.type}`;
      if ('semanticTarget' in action && action.semanticTarget) {
          description += ` ${action.semanticTarget}`;
      }
      description += ` - ${action.thought}`;
      return description;
  }

private async validateProgress(goal: string, currentAction: AgentAction, history: string[]): Promise<{ onTrack: boolean; reason: string }> {
    const page = this.browser.getPage();
    const currentUrl = page.url();
    const currentTitle = await page.title().catch(() => '');
    
    // Extract goal keywords
    const goalLower = goal.toLowerCase();
    const goalKeywords = goalLower.match(/(?:navigate to|go to|click|open)\s+["']?([^"',]+)["']?/gi);
    
    if (!goalKeywords) {
        return { onTrack: true, reason: 'Cannot validate - goal unclear' };
    }
    
    // Check if we're moving in the right direction
    const pageText = await page.evaluate(() => document.body.innerText.toLowerCase());
    
    for (const keyword of goalKeywords) {
        const cleaned = keyword.replace(/navigate to|go to|click|open/gi, '').trim().replace(/['"]/g, '');
        
        // Check if this goal keyword appears in current page
        if (pageText.includes(cleaned.toLowerCase()) || currentTitle.toLowerCase().includes(cleaned.toLowerCase())) {
            return { onTrack: true, reason: `Page contains goal keyword: "${cleaned}"` };
        }
    }
    
    // Check history - are we repeating the same action?
    const lastActions = history.slice(-3);
    const currentActionDesc = `${currentAction.type}:${(currentAction as any).semanticTarget || ''}`;
    const repeating = lastActions.filter(h => h.includes(currentActionDesc)).length >= 2;
    
    if (repeating) {
        return { onTrack: false, reason: 'Repeating same action without progress' };
    }
    
    return { onTrack: true, reason: 'Appears to be making progress' };
}

private async verifyClickSuccess(
    action: AgentAction, 
    fingerprintBefore: StateFingerprint
): Promise<{ verified: boolean; reason: string; confidence: number }> {
    const page = this.browser.getPage();
    
    // Give the page a moment to react
    await page.waitForTimeout(300);
    
    const fingerprintAfter = await this.browser.getFingerprint();
    
    // UNIVERSAL CHECK 1: URL Change (strongest signal)
    if (fingerprintAfter.url !== fingerprintBefore.url) {
        return { verified: true, reason: 'URL changed', confidence: 100 };
    }
    
    // UNIVERSAL CHECK 2: Content Hash Changed (DOM changed significantly)
    if (fingerprintAfter.contentHash !== fingerprintBefore.contentHash) {
        return { verified: true, reason: 'Page content changed', confidence: 90 };
    }
    
    // UNIVERSAL CHECK 3: Element Count Changed Significantly (new UI appeared/disappeared)
    const elementDelta = Math.abs(fingerprintAfter.elementCount - fingerprintBefore.elementCount);
    const percentChange = (elementDelta / fingerprintBefore.elementCount) * 100;
    
    if (percentChange > 10) { // More than 10% change in interactive elements
        return { 
            verified: true, 
            reason: `UI structure changed (${elementDelta} elements, ${percentChange.toFixed(0)}% change)`, 
            confidence: 85 
        };
    }
    
    // UNIVERSAL CHECK 4: Dynamic Content Detection (AJAX/React updates)
    try {
        const dynamicChanges = await page.evaluate(() => {
            // Check for common dynamic indicators
            const indicators = {
                hasLoader: !!document.querySelector('[class*="load" i], [class*="spin" i], [role="progressbar"]'),
                hasNewModal: !!document.querySelector('[role="dialog"]:not([style*="display: none"]), .modal.show, .popup.open'),
                hasNewDropdown: !!document.querySelector('[role="menu"]:not([style*="display: none"]), [role="listbox"][aria-expanded="true"]'),
                hasSuccessToast: !!document.querySelector('[role="alert"], [class*="toast" i], [class*="notification" i]'),
                hasActiveTab: !!document.querySelector('[role="tab"][aria-selected="true"]'),
                focusedElementChanged: document.activeElement?.tagName !== 'BODY'
            };
            
            // Check if any new overlay/floating elements appeared
            const floatingElements = Array.from(document.querySelectorAll('*')).filter(el => {
                const style = window.getComputedStyle(el);
                const zIndex = parseInt(style.zIndex || '0');
                return zIndex > 100 && style.display !== 'none' && style.visibility !== 'hidden';
            });
            
            return {
                ...indicators,
                newFloatingCount: floatingElements.length
            };
        });
        
        if (dynamicChanges.hasNewModal) {
            return { verified: true, reason: 'Modal/dialog opened', confidence: 95 };
        }
        
        if (dynamicChanges.hasNewDropdown) {
            return { verified: true, reason: 'Dropdown menu opened', confidence: 95 };
        }
        
        if (dynamicChanges.hasSuccessToast) {
            return { verified: true, reason: 'Success notification appeared', confidence: 90 };
        }
        
        if (dynamicChanges.newFloatingCount > 0) {
            return { verified: true, reason: `New overlay elements appeared (${dynamicChanges.newFloatingCount})`, confidence: 80 };
        }
        
        if (dynamicChanges.focusedElementChanged) {
            return { verified: true, reason: 'Focus changed to interactive element', confidence: 70 };
        }
        
    } catch (e) {
        console.warn('[VerifyClick] Dynamic check failed:', e);
    }
    
    // UNIVERSAL CHECK 5: Network Activity (for SPA/AJAX apps)
    // This is already partially covered by waitForNetworkIdle in click(), but we can add:
    try {
        const hasOngoingRequests = await page.evaluate(() => {
            // Check if there are any pending fetch/XHR requests
            // This is a heuristic - some apps expose this info
            return (window as any).__pendingRequests > 0 || 
                   (window as any).fetch?.pending > 0;
        });
        
        if (hasOngoingRequests) {
            // Wait a bit for requests to complete
            await page.waitForTimeout(500);
            return { verified: true, reason: 'Async operation in progress', confidence: 75 };
        }
    } catch {}
    
    // UNIVERSAL CHECK 6: Semantic Target Validation (context-aware)
    // Only as a LAST resort and with LOW confidence
    if (action.type === 'click' && action.semanticTarget) {
        try {
            const targetText = action.semanticTarget.toLowerCase();
            
            // Check if the clicked element is now in a different state
            const elementStateChanged = await page.evaluate((text) => {
                // Find elements containing the target text
                const elements = Array.from(document.querySelectorAll('*')).filter(el => 
                    (el.textContent || '').toLowerCase().includes(text)
                );
                
                // Check if any of them have state indicators
                return elements.some(el => {
                    const ariaExpanded = el.getAttribute('aria-expanded');
                    const ariaSelected = el.getAttribute('aria-selected');
                    const ariaPressed = el.getAttribute('aria-pressed');
                    const classes = el.className || '';
                    
                    return ariaExpanded === 'true' || 
                           ariaSelected === 'true' || 
                           ariaPressed === 'true' ||
                           /active|current|selected|open/i.test(classes);
                });
            }, targetText);
            
            if (elementStateChanged) {
                return { 
                    verified: true, 
                    reason: 'Clicked element changed state (aria-expanded/selected)', 
                    confidence: 60 
                };
            }
            
            // Check if related content appeared on the page
            const relatedContentAppeared = await page.evaluate((text) => {
                const bodyText = document.body.innerText.toLowerCase();
                const beforeLength = bodyText.length;
                
                // See if content related to our click target is now more prominent
                const relevantHeadings = Array.from(document.querySelectorAll('h1, h2, h3, h4')).filter(
                    h => (h.textContent || '').toLowerCase().includes(text)
                );
                
                return relevantHeadings.length > 0;
            }, targetText);
            
            if (relatedContentAppeared) {
                return { 
                    verified: true, 
                    reason: 'Related content became prominent on page', 
                    confidence: 55 
                };
            }
            
        } catch {}
    }
    
    // NO CHANGE DETECTED
    return { 
        verified: false, 
        reason: 'No detectable change (possible dead click or slow loading)', 
        confidence: 0 
    };
}

  async generateSelenium(commands: ExecutionCommand[]): Promise<ExecutionResult> {
    try {
      const seleniumCode = await new SeleniumGenerator().generate(commands);
      return { success: true, message: 'Selenium code generated', seleniumCode };
    } catch (e: any) {
      return { success: false, message: e.message };
    }
  }
}