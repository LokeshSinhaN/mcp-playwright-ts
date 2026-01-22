import { GenerativeModel } from '@google/generative-ai';
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
} from './types';
import { 
  selectFromDropdown, 
  selectOptionInOpenDropdown, 
  parseDropdownInstruction, 
  DropdownIntent 
} from './dropdownUtils';

interface AgentContext {
  consecutiveFailures: number;
  burntPhrases: Set<string>; 
  pastActions: string[]; 
}

export class McpTools {
  private sessionHistory: ExecutionCommand[] = [];
  private agentCommandBuffer: ExecutionCommand[] | null = null;
  private agentContext: AgentContext = {
      consecutiveFailures: 0,
      burntPhrases: new Set(),
      pastActions: []
  };

  private recordCommand(cmd: ExecutionCommand | ExecutionCommand[]): void {
    const cmds = Array.isArray(cmd) ? cmd : [cmd];
    if (this.agentCommandBuffer) {
      this.agentCommandBuffer.push(...cmds);
    } else {
      this.sessionHistory.push(...cmds);
    }
  }

  constructor(private readonly browser: BrowserManager, private readonly model?: GenerativeModel) {}

  private extractUrlFromPrompt(prompt: string): string | null {
    const match = prompt.match(/https?:\/\/[^\s]+/);
    return match ? match[0] : null;
  }

  private extractDomain(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }

  // --- NAVIGATION ---
  async navigate(url: string): Promise<ExecutionResult> {
    try {
      await this.browser.goto(url);
      await this.browser.handleCookieBanner();
      this.recordCommand({
        action: 'navigate', target: url, description: `Mapsd to ${url}`,
      });
      this.agentContext.burntPhrases.clear(); 
      return { success: true, message: `Mapsd to ${url}` };
    } catch (error: any) {
      return { success: false, message: error.message };
    }
  }

  // --- COMPATIBILITY ---
  async clickWithHeuristics(target: string, _candidates?: any[]): Promise<ExecutionResult> {
    return this.click(target);
  }

  // --- UNIVERSAL CLICK ---
  async click(target: string): Promise<ExecutionResult> {
    const page = this.browser.getPage();
    const dropdownIntent = parseDropdownInstruction(target);
    
    if (dropdownIntent) {
      try {
        let message: string;
        if (dropdownIntent.kind === 'open-and-select') {
          const res = await selectFromDropdown(page, dropdownIntent.dropdownLabel, dropdownIntent.optionLabel);
          this.recordCommand([
             { action: 'click', target: dropdownIntent.dropdownLabel, selectors: { text: dropdownIntent.dropdownLabel }, description: `Open ${dropdownIntent.dropdownLabel}` },
             { action: 'click', target: res.optionSelector || dropdownIntent.optionLabel, selectors: { css: res.optionSelector, text: dropdownIntent.optionLabel }, description: `Select ${dropdownIntent.optionLabel}` }
          ]);
          message = `Selected "${dropdownIntent.optionLabel}" from "${dropdownIntent.dropdownLabel}"`;
        } else {
          const res = await selectOptionInOpenDropdown(page, dropdownIntent.optionLabel);
          this.recordCommand({
             action: 'click', target: res.optionSelector || dropdownIntent.optionLabel, selectors: { css: res.optionSelector, text: dropdownIntent.optionLabel }, description: `Select ${dropdownIntent.optionLabel}`
          });
          message = `Selected "${dropdownIntent.optionLabel}"`;
        }
        return { success: true, message };
      } catch (e) {
        // Fallback
      }
    }

    const extractor = new SelectorExtractor(page);
    const coreTarget = this.extractCoreLabel(target);
    let candidates = await extractor.findCandidates(coreTarget || target);
    candidates = candidates.filter(el => this.elementMatchesPrompt(coreTarget || target, el));

    if (candidates.length > 0) {
       const best = candidates[0];
       const selector = best.selector || best.cssSelector || best.xpath;
       if (selector) {
           // Pass the element text as description to help the selenium generator
           const info = await this.browser.click(selector);
           this.recordCommand({
               action: 'click',
               target: selector,
               selectors: { css: info.cssSelector, xpath: info.xpath, text: info.text, id: info.id },
               description: target
           });
           return { success: true, message: `Clicked "${info.text || target}"`, selectors: [info] };
       }
    }
    return { success: false, message: `Could not confidently identify element for "${target}"` };
  }

  async type(selector: string, text: string): Promise<ExecutionResult> {
    try {
      const info = await this.browser.type(selector, text);
      this.recordCommand({
        action: 'type', target: selector, value: text,
        selectors: { css: info.cssSelector, text: info.text },
        description: `Typed "${text}"`,
      });
      return { success: true, message: `Typed "${text}"` };
    } catch (error: any) {
      return { success: false, message: error.message };
    }
  }

  async observe(useVision: boolean = false): Promise<{
    url: string; selectors: ElementInfo[]; screenshot?: string; title?: string;
  }> {
    const page = this.browser.getPage();
    const url = page.url();
    const title = await page.title().catch(() => '');
    const extractor = new SelectorExtractor(page);
    
    // IMPORTANT: Scans ALL frames now
    const selectors = await extractor.extractAllInteractive();

    if (useVision) {
      const screenshot = await this.browser.screenshot();
      return {
        url, title, selectors,
        screenshot: screenshot.replace('data:image/png;base64,', ''),
      };
    }
    return { url, title, selectors };
  }

  async handleCookieBanner(elements?: ElementInfo[]): Promise<ExecutionResult> {
    const info = await this.browser.handleCookieBanner();
    if (info) return { success: true, message: 'Cookie banner dismissed', selectors: [info] };
    return { success: false, message: 'No cookie banner found' };
  }

  async generateSelenium(existingCommands: ExecutionCommand[] = []): Promise<{ seleniumCode: string; success: boolean }> {
    const generator = new SeleniumGenerator();
    const allCommands = [...this.sessionHistory, ...existingCommands];
    return { seleniumCode: generator.generate(allCommands), success: true };
  }
  
  private extractCoreLabel(prompt: string): string {
    const raw = (prompt || '').trim();
    if (!raw) return '';
    const quoted = raw.match(/["\']([^"\']{2,})["\']/);
    if (quoted && quoted[1].trim().length >= 3) return quoted[1].trim();
    let core = raw.replace(/^(click|select|press|tap|open)\s+/i, '');
    core = core.replace(/\b(button|link|input|dropdown|menu|tab)\b/gi, '').trim();
    return core || raw;
  }

  private elementMatchesPrompt(prompt: string, el: ElementInfo): boolean {
    const core = this.extractCoreLabel(prompt);
    const tokens = core.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3);
    if (tokens.length === 0) return true;
    const label = [el.text, el.ariaLabel, el.placeholder, el.dataTestId, el.context]
       .filter(Boolean).join(' ').toLowerCase();
    return tokens.some(tok => label.includes(tok));
  }

  // ===========================================================================
  // =================== BLOCKER & PLANNER LOGIC ===============================
  // ===========================================================================

  /**
   * Universal Blocker Detection.
   * Checks for login fields or cookie banners that MUST be handled before anything else.
   */
  private checkForBlockers(elements: ElementInfo[], goal: string): AgentAction | null {
      // 1. Password Field Trap
      const passwordField = elements.find(el => el.attributes?.['type'] === 'password');
      if (passwordField) {
          // If we see a password field, and we haven't just typed in it...
          if (!this.agentContext.burntPhrases.has('login_password')) {
              console.log("[Blocker] Login Screen Detected.");
              // Does the goal contain credentials?
              // Simple heuristic: look for "password" in goal or just assume generic fill
              return {
                  type: 'finish', // Stop and ask user, OR:
                  // type: 'type', selector: passwordField.cssSelector, text: '...', 
                  thought: 'Login Page Detected. I need credentials to proceed. Stopping to ask user.',
                  summary: 'Login Required. Please provide username and password in the prompt.'
              };
          }
      }

      // 2. Cookie / Modal Trap (High Z-Index "Accept" buttons)
      const acceptCookies = elements.find(el => 
          (el.text?.toLowerCase().includes('accept') || el.text?.toLowerCase().includes('agree')) && 
          (el.text?.toLowerCase().includes('cookie') || el.isFloating)
      );

      if (acceptCookies && !this.agentContext.burntPhrases.has('cookies_accepted')) {
          return {
              type: 'click',
              selector: acceptCookies.cssSelector || acceptCookies.selector,
              semanticTarget: 'Accept Cookies',
              thought: 'Blocking Modal detected (Cookies). Clearing it first.'
          };
      }
      
      return null;
  }

  private tryDeterministicPlan(goal: string, elements: ElementInfo[], currentTitle: string, currentUrl: string): AgentAction | null {
      const lowerGoal = goal.toLowerCase();
      const onTargetPage = currentTitle.toLowerCase().includes("patient master list");
      const ignoredWords = ['navigate', 'click', 'to', 'the', 'open', 'filter', 'scroll', 'find', 'options', 'wait', 'check', 'select'];
      
      let cleanGoal = lowerGoal;
      const goalKeywords = cleanGoal.split(/[^a-z0-9]+/).filter(w => w.length > 2 && !ignoredWords.includes(w));

      for (const keyword of goalKeywords) {
          if (this.agentContext.burntPhrases.has(keyword)) continue;

          // Prevent loop on navigation parents
          if (onTargetPage && (keyword === "reports" || keyword === "patients")) {
              this.agentContext.burntPhrases.add(keyword);
              continue;
          }

          const matches = elements.filter(el => {
              // Only consider VISIBLE elements
              if (!el.visible && !el.isVisible) return false;
              
              const text = (el.text || '').toLowerCase();
              const label = (el.ariaLabel || '').toLowerCase();
              return text === keyword || label === keyword || text.includes(keyword);
          });

          // Sort: Exact Match > Interactive > visible
          matches.sort((a, b) => {
              const aTxt = (a.text || '').toLowerCase().trim();
              const bTxt = (b.text || '').toLowerCase().trim();
              if (aTxt === keyword && bTxt !== keyword) return -1;
              if (bTxt === keyword && aTxt !== keyword) return 1;
              return 0;
          });

          const bestMatch = matches[0];
          if (bestMatch) {
             return {
                 type: 'click',
                 selector: bestMatch.selector || bestMatch.cssSelector,
                 semanticTarget: keyword,
                 thought: `Deterministic: Found keyword "${keyword}" in goal. Executing.`
             };
          }
      }
      return null;
  }

  // --- AGENT LOOP ---
  async runAutonomousAgent(goal: string, config: AgentConfig = {}): Promise<AgentSessionResult> {
    const maxSteps = config.maxSteps ?? 30;
    this.sessionHistory = []; 
    const steps: AgentStepResult[] = [];
    this.agentContext = { consecutiveFailures: 0, burntPhrases: new Set(), pastActions: [] };

    await this.browser.init();
    const page = this.browser.getPage();
    const urlInGoal = this.extractUrlFromPrompt(goal);
    let stepNumber = 0;

    if (urlInGoal) {
        const currentUrl = page.url();
        if (currentUrl === 'about:blank' || !currentUrl.includes(this.extractDomain(urlInGoal))) {
            stepNumber++;
            await this.navigate(urlInGoal);
            await page.waitForTimeout(2000);
            steps.push({ 
                stepNumber, action: { type: 'navigate', url: urlInGoal, thought: 'Init' }, 
                success: true, message: `Mapsd to ${urlInGoal}`, urlBefore: '', urlAfter: urlInGoal, stateChanged: true, retryCount: 0 
            });
        }
    }

    let isFinished = false;

    while (stepNumber < maxSteps && !isFinished) {
      stepNumber++;
      
      // 1. Observe (Lite)
      const observationLite = await this.observe(false); 
      const elements = observationLite.selectors ?? [];
      
      // 2. CHECK BLOCKERS (Login, Cookies)
      let nextAction = this.checkForBlockers(elements, goal);

      // 3. Deterministic Plan
      if (!nextAction) {
          nextAction = this.tryDeterministicPlan(goal, elements, observationLite.title || '', observationLite.url);
      }

      // 4. AI Plan (With 429 Retry)
      let screenshotForStep: string | undefined = undefined;
      if (!nextAction) {
          const screenshotObj = await this.browser.screenshot();
          screenshotForStep = screenshotObj.replace('data:image/png;base64,', '');
          
          try {
              nextAction = await this.planNextAgentAction(
                  goal, elements, this.agentContext.pastActions, "", 
                  this.agentContext.burntPhrases, observationLite.title || '', observationLite.url, screenshotForStep
              );
          } catch (err: any) {
              // RATE LIMIT HANDLER
              if (String(err).includes('429')) {
                   console.log("Rate Limit Hit. Waiting 20s...");
                   await new Promise(r => setTimeout(r, 20000));
                   // Retry once
                   nextAction = await this.planNextAgentAction(
                      goal, elements, this.agentContext.pastActions, "", 
                      this.agentContext.burntPhrases, observationLite.title || '', observationLite.url, screenshotForStep
                   ).catch(() => ({ type: 'wait', durationMs: 5000, thought: 'Rate limit persist' } as AgentAction));
              } else {
                  nextAction = { type: 'wait', durationMs: 2000, thought: 'Error planning' };
              }
          }
      }

      config.broadcast?.({
          type: 'log', timestamp: new Date().toISOString(),
          message: `ai_thought: ${nextAction.thought}`,
          data: { role: 'agent-reasoning', thought: nextAction.thought }
      });

      // 5. Execute
      let actionSuccess = false;
      let retryCount = 0;
      let executionMsg = "";
      
      while (retryCount <= 1 && !actionSuccess) {
           this.agentCommandBuffer = []; 
           const result = await this.executeAgentAction(nextAction, elements); 
           actionSuccess = result.success;
           executionMsg = result.message;
           
           if (actionSuccess) {
               if (this.agentCommandBuffer.length > 0) this.sessionHistory.push(...this.agentCommandBuffer);
               const target = (nextAction as any).semanticTarget || (nextAction as any).text;
               if (target) {
                   this.agentContext.burntPhrases.add(target.toLowerCase().trim());
                   if (nextAction.type === 'click' && target === 'Accept Cookies') this.agentContext.burntPhrases.add('cookies_accepted');
               }
           } else {
               retryCount++;
               await page.waitForTimeout(1000);
           }
      }

      const actionDesc = executionMsg || this.describeAction(nextAction, actionSuccess);
      this.agentContext.pastActions.push(actionDesc);
      
      if (actionSuccess) {
           config.broadcast?.({ type: 'log', timestamp: new Date().toISOString(), message: `Step ${stepNumber}: ${actionDesc.replace('[SUCCESS] ', '')}` });
      }

      if (nextAction.type === 'finish' && actionSuccess) isFinished = true;
      
      steps.push({ 
          stepNumber, action: nextAction, success: actionSuccess, message: actionDesc, 
          urlBefore: observationLite.url, urlAfter: page.url(), stateChanged: actionSuccess, retryCount,
          screenshot: screenshotForStep 
      });
    }

    return { success: isFinished, summary: "Task Completed", goal, totalSteps: stepNumber, steps, commands: this.sessionHistory, seleniumCode: "" };
  }

  // ... (parseAgentActionResponse, extractBalancedJson - Keep same as previous)
  private parseAgentActionResponse(responseText: string): AgentAction {
    let clean = responseText.replace(/```json\s*|\s*```/gi, '').trim();
    const jsonStr = this.extractBalancedJson(clean);
    
    if (!jsonStr) {
       return { type: 'wait', durationMs: 1000, thought: 'AI returned non-JSON response' };
    }
    try {
      const parsed = JSON.parse(jsonStr);
      if (parsed.type === 'type' && !parsed.text && parsed.value) parsed.text = parsed.value;
      if (!parsed.thought) parsed.thought = "Executing action...";
      return parsed as AgentAction;
    } catch (e) {
      return { type: 'wait', durationMs: 1000, thought: 'Malformed AI JSON.' };
    }
  }

  private extractBalancedJson(str: string): string | null {
    const start = str.indexOf('{');
    if (start === -1) return null;
    let balance = 0;
    for (let i = start; i < str.length; i++) {
      if (str[i] === '{') balance++;
      else if (str[i] === '}') balance--;
      if (balance === 0) return str.substring(start, i + 1);
    }
    return null;
  }

  // ... (planNextAgentAction - Keep same, just ensure type safety)
  private async planNextAgentAction(
    goal: string,
    elements: ElementInfo[],
    actionHistory: string[],
    feedbackForPlanner: string,
    burntPhrases: Set<string>, 
    currentTitle: string,
    currentUrl: string,
    screenshot?: string
  ): Promise<AgentAction> {
    
    if (elements.length === 0) {
        return { type: 'wait', durationMs: 3000, thought: 'No interactive elements found.' };
    }
    if (!this.model) return { type: 'finish', thought: 'No AI model', summary: 'No AI' };

    // Valid Elements Filtering 
    // Filter out burned elements to save context and force progress
    const validElements = elements.filter(el => {
        const text = (el.text || '').toLowerCase().trim();
        const label = (el.ariaLabel || '').toLowerCase().trim();
        if (burntPhrases.has(text) || burntPhrases.has(label)) return false;
        return true;
    });

    const elementList = validElements.slice(0, 150).map((el, idx) => ({
        id: `el_${idx}`,  
        tag: el.tagName,
        text: (el.text || '').slice(0, 50).replace(/\s+/g, ' '),
        context: (el.context || '').slice(0, 50),
        role: el.roleHint,
        label: (el.ariaLabel || '').slice(0, 50),
    }));

    const prompt = `
SYSTEM: Web Automation Agent.
GOAL: ${goal}
HISTORY: ${actionHistory.slice(-5).join('; ')}
ALREADY DONE: ${Array.from(burntPhrases).join(', ')}

ELEMENTS:
${JSON.stringify(elementList)}

INSTRUCTIONS:
1. Pick the NEXT step to achieve GOAL. 
2. IGNORE actions in "ALREADY DONE".
3. RETURN JSON: { "type": "click"|"type"|"finish"|"wait", "elementId": "el_X", "text"?: "...", "thought": "..." }
`;

    try {
        const result = await this.model.generateContent({ contents: [{ role: 'user', parts: [{ text: prompt }] }] } as any);
        const response = (result as any).response?.text?.() ?? '';
        const parsed = this.parseAgentActionResponse(response);
        
        // Resolve elementId to Selector immediately
        if ((parsed.type === 'click' || parsed.type === 'type') && parsed.elementId) {
            const match = parsed.elementId.match(/el_(\d+)/);
            if (match) {
                const idx = parseInt(match[1]);
                const el = validElements[idx];
                if (el) {
                    parsed.selector = el.cssSelector || el.selector;
                    parsed.semanticTarget = el.text || el.ariaLabel;
                }
            }
        }
        return parsed;

    } catch (err: any) {
        // RETHROW so runAutonomousAgent can handle 429
        throw err;
    }
  }

  // ... (executeAgentAction, describeAction, clickExact - Keep same)
  private async executeAgentAction(action: AgentAction, elements: ElementInfo[]): Promise<{success: boolean, message: string}> {
    
    if (action.type === 'click') {
      const selector = action.selector; 
      const semanticTarget = action.semanticTarget;

      if (selector) return await this.clickExact(selector, semanticTarget || selector);
      if (semanticTarget) return await this.click(semanticTarget);
      return { success: false, message: "Missing selector/target for click" };
    } 
    else if (action.type === 'type') {
      const selector = action.selector; 
      const semanticTarget = action.semanticTarget;

      if (selector) return await this.type(selector, action.text);
      if (semanticTarget) {
          const res = await this.click(semanticTarget); 
          if (res.success && res.selectors?.[0]) {
               return await this.type(res.selectors[0].cssSelector!, action.text);
          }
      }
      return { success: false, message: "Missing selector for type" };
    } 
    else if (action.type === 'navigate') {
      return this.navigate(action.url);
    } 
    else if (action.type === 'scroll') {
      await this.browser.scroll(action.elementId, action.direction); 
      return { success: true, message: 'Scrolled' };
    } 
    else if (action.type === 'wait') {
      await new Promise((r) => setTimeout(r, action.durationMs));
      return { success: true, message: 'Waited' };
    } 
    else if (action.type === 'finish') {
      return { success: true, message: action.summary };
    }
    return { success: false, message: "Unknown action type" };
  }

  async clickExact(selector: string, description?: string): Promise<ExecutionResult> {
    const command: ExecutionCommand = {
      action: 'click',
      target: selector,
      description: description || `Clicked ${selector}`,
    };
    try {
      await this.browser.click(selector);
      this.recordCommand(command);
      return { success: true, message: `Clicked ${description || selector}` };
    } catch (error: any) {
      return { success: false, message: error.message };
    }
  }

  private describeAction(action: AgentAction, success: boolean): string {
    const status = success ? 'SUCCESS' : 'FAIL';
    
    if (action.type === 'click' || action.type === 'select_option') {
        const tgt = action.semanticTarget || action.selector || 'element';
        return `[${status}] Click ${tgt}`;
    }
    if (action.type === 'type') {
        const tgt = action.semanticTarget || action.selector || 'element';
        return `[${status}] Type "${action.text}" into ${tgt}`;
    }
    if (action.type === 'navigate') {
        return `[${status}] Navigate to ${action.url}`;
    }
    if (action.type === 'wait') {
        return `[${status}] Wait ${action.durationMs}ms`;
    }
    if (action.type === 'scroll') {
        return `[${status}] Scroll ${action.direction}`;
    }
    
    return `[${status}] ${action.type}`;
  }
}