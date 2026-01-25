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
    // Key Robustness: Track failed selectors to prevent looping on bad elements
    const failedElements: Set<string> = new Set();
    const actionHistory: string[] = [];

    await this.browser.init();
    const page = this.browser.getPage();

    // 1. Auto-Navigation Check (Smart Start)
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

      // OBSERVE
      // We extract interactive elements to feed the brain
      const extractor = new SelectorExtractor(page);
      const elements = await extractor.extractAllInteractive();
      const screenshotObj = await this.browser.screenshot();
      const screenshotBase64 = screenshotObj.replace('data:image/png;base64,', '');

      // THINK (Plan Next Action)
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

      // ACT (Execute with State Verification)
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

           // INTELLIGENT SELF-CORRECTION
           // If we clicked a "Submit/Login" button but State Didn't Change -> Dead Click
           if (result.success && nextAction.type === 'click' && !stateChanged) {
               const target = nextAction.semanticTarget?.toLowerCase() || '';
               const criticalClick = target.includes('log') || target.includes('sign') || target.includes('search') || target.includes('go') || target.includes('submit');
               
               if (criticalClick) {
                   // Mark as failed so we don't try this specific element again
                   actionSuccess = false; 
                   actionMessage = "Click successful but page state did not change (Dead Click). Retrying...";
                   if (result.failedSelector) failedElements.add(result.failedSelector);
               }
           }

           if (actionSuccess) {
               // Commit commands
               if (this.agentCommandBuffer.length > 0) this.sessionHistory.push(...this.agentCommandBuffer);
           } else {
               retryCount++;
               // If failed, add selector to blocklist
               if (result?.failedSelector) failedElements.add(result?.failedSelector);
               await page.waitForTimeout(1000);
           }
      }

      const actionDesc = this.describeAction(nextAction, actionSuccess);
      actionHistory.push(actionDesc);
      
      if (nextAction.type === 'finish' && actionSuccess) isFinished = true;

      steps.push({ 
          stepNumber, action: nextAction, success: actionSuccess, message: actionMessage, 
          urlBefore: '', urlAfter: page.url(), stateChanged, retryCount, 
          screenshot: screenshotBase64 
      });
    }

    return { 
        success: isFinished, 
        summary: "Agent Session Ended", 
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

    // ... Helper to resolve "el_3" to actual selector ...
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
            if (sel) {
                result = await this.clickExact(sel, action.semanticTarget);
                result.failedSelector = sel; // store potential failure source
            } else if (action.semanticTarget) {
                // Fallback to text click
                const clickRes = await this.browser.click(`text=${action.semanticTarget}`);
                result = { success: true, message: `Clicked "${action.semanticTarget}"`, selectors: [clickRes] };
            } else {
                result = { success: false, message: "No selector for click" };
            }
        } 
        else if (action.type === 'type') {
            const sel = resolveSelector(action.elementId, action.selector);
            if (sel) {
                await this.browser.type(sel, action.text);
                this.recordCommand({ action: 'type', target: sel, value: action.text });
                result = { success: true, message: `Typed "${action.text}"`, failedSelector: sel };
            } else {
                result = { success: false, message: "No selector for type" };
            }
        }
        else if (action.type === 'scroll') {
             await this.browser.scroll(undefined, action.direction);
             result = { success: true, message: "Scrolled" };
        }
        else if (action.type === 'wait') {
             await new Promise(r => setTimeout(r, action.durationMs));
             result = { success: true, message: "Waited" };
        }
        else if (action.type === 'finish') {
             result = { success: true, message: action.summary };
        }
        else if (action.type === 'navigate') {
             await this.navigate(action.url);
             result = { success: true, message: `Navigated to ${action.url}` };
        }
    } catch (e: any) {
        let failedSelector: string | undefined = undefined;
        if ('selector' in action) {
            failedSelector = action.selector;
        }
        return { success: false, message: e.message, failedSelector };
    }

    // 2. Capture State AFTER & Compare
    if (result.success && ['click', 'type', 'navigate'].includes(action.type)) {
        try {
            const fingerprintAfter = await this.browser.getFingerprint();
            if (fingerprintBefore && fingerprintAfter) {
                // Determine if state changed (URL diff OR Content Hash diff)
                const isDifferent = (fingerprintBefore.contentHash !== fingerprintAfter.contentHash) || 
                                    (fingerprintBefore.url !== fingerprintAfter.url);
                result.stateChanged = isDifferent;
            }
        } catch {}
    } else {
        // Scroll/Wait are considered state changes for flow control purposes
        result.stateChanged = true; 
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
      
      // Filter out technical noise and FAILED elements
      const visibleEl = elements.filter(el => 
          el.visible && 
          !failedElements.has(el.cssSelector || '') &&
          !failedElements.has(el.selector || '') && 
          el.tagName !== 'script'
      );

      const simplified = visibleEl.slice(0, 200).map((el, i) => ({
          id: `el_${i}`, // We map this back later
          tag: el.tagName,
          text: (el.text || '').slice(0, 50).replace(/\s+/g, ' '),
          label: el.ariaLabel || el.placeholder || '',
          selector: el.cssSelector
      }));

      const prompt = `
      SYSTEM: Web Agent. Goal: "${goal}".
      HISTORY: ${history.slice(-4).join('; ')}
      FAILED SELECTORS (Do not use): ${JSON.stringify(Array.from(failedElements))}
      
      UI ELEMENTS:
      ${JSON.stringify(simplified)}

      INSTRUCTIONS:
      1. Analyze the UI and History.
      2. If you see a "Login" or "Submit" button and you just typed credentials, CLICK IT.
      3. If the page hasn't changed after a click, try a different element or strategy.
      4. RETURN JSON ONLY: { "type": "click"|"type"|"wait"|"finish"|"scroll", "elementId": "el_X", "text"?: "...", "thought": "..." }
      `;

      // ... [LLM Call Logic - Gemini/OpenAI - similar to before] ...
      let responseText = '';
      if (provider === 'openai' && this.openai) {
           const completion = await this.openai.chat.completions.create({
               model: "gpt-4o",
               messages: [
                   { role: "system", content: "You are a JSON-only bot." },
                   { role: "user", content: [
                       { type: "text", text: prompt },
                       { type: "image_url", image_url: { url: `data:image/png;base64,${screenshot}` } }
                   ]}
               ],
               response_format: { type: "json_object" }
           });
           responseText = completion.choices[0].message.content || '';
      } else if (this.gemini) {
           const parts: any[] = [{ text: prompt }];
           if (screenshot) parts.push({ inlineData: { data: screenshot, mimeType: 'image/png' } });
           const res = await this.gemini.generateContent({ contents: [{ role: 'user', parts }] });
           responseText = res.response.text();
      } else {
          return { type: 'finish', thought: 'No AI', summary: 'Config Error' };
      }

      // Map back el_X to actual selector
      const action = this.parseAgentActionResponse(responseText);
      if ((action.type === 'click' || action.type === 'type') && action.elementId) {
          const idx = parseInt(action.elementId.split('_')[1]);
          const el = visibleEl[idx];
          if (el) {
              action.selector = el.cssSelector || el.selector;
              action.semanticTarget = el.text || el.ariaLabel;
          }
      }
      return action;
  }

  // Robust Parser from Reference File
  private parseAgentActionResponse(raw: string): AgentAction {
      let clean = raw.replace(/```json\s*|\s*```/gi, '').trim();
      // Extract balanced JSON to handle extra chatter
      const start = clean.indexOf('{');
      const end = clean.lastIndexOf('}');
      if (start !== -1 && end !== -1) clean = clean.substring(start, end + 1);

      try {
          const parsed = JSON.parse(clean);
          if (!parsed.type && parsed.action) parsed.type = parsed.action; // Compat
          if (!parsed.thought) parsed.thought = "Executing...";
          return parsed;
      } catch {
          // Fallback regex for common failures
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

  async generateSelenium(commands: ExecutionCommand[]): Promise<ExecutionResult> {
    try {
      const seleniumCode = await new SeleniumGenerator().generate(commands);
      return { success: true, message: 'Selenium code generated', seleniumCode };
    } catch (e: any) {
      return { success: false, message: e.message };
    }
  }
}