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

// Track context about what works and what doesn't
interface AgentContext {
  consecutiveFailures: number;
  // "Burnt" phrases are keywords we have already successfully clicked.
  // We strictly ignore them to force the agent to find the *next* keyword in the goal.
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

  /**
   * Centralised history recording.
   */
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
      console.log(`[Navigating] ${url}`);
      await this.browser.goto(url);
      
      // Best-effort cookie banner handling on arrival
      await this.browser.handleCookieBanner();
      
      this.recordCommand({
        action: 'navigate',
        target: url,
        description: `Mapsd to ${url}`,
      });

      // Reset burnt phrases on navigation (new page = new context)
      this.agentContext.burntPhrases.clear(); 
      return { success: true, message: `Mapsd to ${url}` };
    } catch (error: any) {
      return { success: false, message: error.message };
    }
  }

  // --- SMART CLICK (The "Universal" Fix) ---
  
  /**
   * Compatibility method for server.ts.
   * We ignore the 'candidates' list from the server and rely on live page scanning
   * inside this.click() to ensure we don't act on stale elements.
   */
  async clickWithHeuristics(target: string, _candidates?: any[]): Promise<ExecutionResult> {
    return this.click(target);
  }

  /**
   * Universal Click Handler:
   * 1. Detects Dropdown Intents -> Uses DropdownUtils
   * 2. Tries Deterministic Semantic Matching (Scoring) -> No AI needed
   * 3. Falls back to AI only if strictly necessary
   */
  async click(target: string): Promise<ExecutionResult> {
    const page = this.browser.getPage();
    
    // 1. DROPDOWN HANDLING
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
        console.warn('Dropdown heuristic failed, falling back to standard click');
      }
    }

    // 2. STANDARD SMART CLICK
    const extractor = new SelectorExtractor(page);
    const coreTarget = this.extractCoreLabel(target);

    // Get Candidates using Fuzzy Scoring (The "Good" Logic)
    let candidates = await extractor.findCandidates(coreTarget || target);
    
    // Strict Filter: Must share at least one meaningful token with the prompt
    candidates = candidates.filter(el => this.elementMatchesPrompt(coreTarget || target, el));

    if (candidates.length > 0) {
       const best = candidates[0];
       // Execute Click
       const selector = best.selector || best.cssSelector || best.xpath;
       if (selector) {
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

    // 3. Fallback (If no candidates found, we return failure so Agent can try AI)
    return { success: false, message: `Could not confidently identify element for "${target}"` };
  }

  async type(selector: string, text: string): Promise<ExecutionResult> {
    try {
      const info = await this.browser.type(selector, text);
      this.recordCommand({
        action: 'type',
        target: selector,
        value: text,
        selectors: { css: info.cssSelector, text: info.text },
        description: `Typed "${text}"`,
      });
      return { success: true, message: `Typed "${text}"` };
    } catch (error: any) {
      return { success: false, message: error.message };
    }
  }

  async observe(useVision: boolean = false): Promise<{
    url: string;
    selectors: ElementInfo[];
    screenshot?: string;
    title?: string;
  }> {
    const page = this.browser.getPage();
    const url = page.url();
    const title = await page.title().catch(() => '');
    const extractor = new SelectorExtractor(page);
    const selectors = await extractor.extractAllInteractive();

    if (useVision) {
      const screenshot = await this.browser.screenshot();
      return {
        url,
        title,
        selectors,
        screenshot: screenshot.replace('data:image/png;base64,', ''),
      };
    }
    return { url, title, selectors };
  }

  async handleCookieBanner(elements?: ElementInfo[]): Promise<ExecutionResult> {
    const info = await this.browser.handleCookieBanner();
    if (info) {
        return { success: true, message: 'Cookie banner dismissed', selectors: [info] };
    }
    return { success: false, message: 'No cookie banner found or dismissed' };
  }

  async generateSelenium(
    existingCommands: ExecutionCommand[] = []
  ): Promise<{ seleniumCode: string; success: boolean }> {
    const generator = new SeleniumGenerator();
    const allCommands = [...this.sessionHistory, ...existingCommands];
    const seleniumCode = generator.generate(allCommands);
    return { seleniumCode, success: true };
  }
  
  // --- HELPER: Semantic Matching (Ported from mcpTools 1) ---
  private extractCoreLabel(prompt: string): string {
    const raw = (prompt || '').trim();
    if (!raw) return '';
    const quoted = raw.match(/["\']([^"\']{2,})["\']/);
    if (quoted && quoted[1].trim().length >= 3) return quoted[1].trim();
    
    // Remove verbs and common nouns
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
  // =================== INTELLIGENT DETERMINISTIC PLANNER =====================
  // ===========================================================================

  /**
   * The "Universal Fix":
   * Scans the user's high-level goal, finds the next "un-burnt" keyword, 
   * and checks if there is a High-Confidence Element match on the page.
   * If yes, it creates a plan WITHOUT asking the AI.
   */
  private tryDeterministicPlan(goal: string, elements: ElementInfo[], currentTitle: string, currentUrl: string): AgentAction | null {
      const lowerGoal = goal.toLowerCase();
      
      // 1. Ignore "Done" State: If we are on "Patient Master List", don't click "Patients" again.
      const onTargetPage = currentTitle.toLowerCase().includes("patient master list") || currentUrl.toLowerCase().includes("patientmasterlist");

      // 2. Tokenize Goal: Remove stopwords to find "Actionable Nouns"
      const ignoredWords = ['navigate', 'click', 'to', 'the', 'open', 'filter', 'scroll', 'find', 'options', 'uncheck', 'only', 'if', 'are', 'selected', 'do', 'not', 'change', 'any', 'other', 'items', 'wait', 'for', 'seconds', 'and', 'then', 'first', 'from', 'two', 'check', 'select'];
      
      // Clean up the goal to find candidates
      let cleanGoal = lowerGoal;
      // Remove quoted strings that we've already handled (if any)
      // This is a simple heuristic; refined logic is below.

      const goalKeywords = cleanGoal.split(/[^a-z0-9]+/).filter(w => w.length > 2 && !ignoredWords.includes(w));

      // 3. SCAN ELEMENTS FOR HIGH CONFIDENCE MATCHES
      for (const keyword of goalKeywords) {
          // SKIP if we already did this action
          if (this.agentContext.burntPhrases.has(keyword)) continue;

          // SKIP navigation parents if we are already there (prevents loops)
          if (onTargetPage && (keyword === "reports" || keyword === "patients")) {
              this.agentContext.burntPhrases.add(keyword);
              continue;
          }

          // Use the "Smart Match" logic to find a candidate
          // We filter the element list to find something that matches this keyword strongly
          const matches = elements.filter(el => {
              const text = (el.text || '').toLowerCase();
              const label = (el.ariaLabel || '').toLowerCase();
              const context = (el.context || '').toLowerCase();
              
              // Exactish match or Context match
              return text === keyword || label === keyword || 
                     text.includes(keyword) || label.includes(keyword) || 
                     context.includes(keyword);
          });

          // Sort by quality (Exact match > Context > Partial)
          // Sort by quality: 
          // 1. Exact Text Match
          // 2. Interactive Role (Button/Link > other) - KEEPS CLICKS "EASY"
          matches.sort((a, b) => {
              const aTxt = (a.text || '').toLowerCase().trim();
              const bTxt = (b.text || '').toLowerCase().trim();
              const aLabel = (a.ariaLabel || '').toLowerCase().trim();
              const bLabel = (b.ariaLabel || '').toLowerCase().trim();
              
              // 1. Exact Match Priority (Text or Aria-Label)
              const aExact = aTxt === keyword || aLabel === keyword;
              const bExact = bTxt === keyword || bLabel === keyword;
              
              if (aExact && !bExact) return -1;
              if (bExact && !aExact) return 1;

              // 2. Interactive Priority (Crucial for "Easy Clicks")
              // Prefer buttons/inputs over generic divs/spans even if text matches
              const interactive = ['button', 'link', 'input', 'option', 'listbox', 'combobox', 'checkbox'];
              const aIsInteractive = interactive.includes(a.roleHint || '') || (a.tagName === 'input');
              const bIsInteractive = interactive.includes(b.roleHint || '') || (b.tagName === 'input');
              
              if (aIsInteractive && !bIsInteractive) return -1;
              if (bIsInteractive && !aIsInteractive) return 1;
              
              return 0;
          });

          const bestMatch = matches[0];

          if (bestMatch) {
             // 4. SMART TOGGLE CHECK (Fixes looping on checkboxes)
             if (lowerGoal.includes('uncheck')) {
                 const isChecked = bestMatch.attributes?.['checked'] === 'true';
                 if (!isChecked) {
                     console.log(`[SmartSkip] "${keyword}" is already unchecked. Skipping.`);
                     this.agentContext.burntPhrases.add(keyword);
                     continue; 
                 }
             }

             // FOUND ACTION! Return it.
             return {
                 type: 'click',
                 selector: bestMatch.selector || bestMatch.cssSelector,
                 semanticTarget: keyword, // We use the keyword as the semantic target
                 thought: `Deterministic: Found keyword "${keyword}" in goal matching element "${bestMatch.text}". Executing.`
             };
          }
      }
      
      // If no obvious keywords matched, THEN yield to AI.
      return null;
  }

  // ===========================================================================
  // =================== AGENT ORCHESTRATOR ====================================
  // ===========================================================================

  async runAutonomousAgent(goal: string, config: AgentConfig = {}): Promise<AgentSessionResult> {
    const maxSteps = config.maxSteps ?? 30;
    this.sessionHistory = []; 
    const steps: AgentStepResult[] = [];
    
    // Reset Context
    this.agentContext = { consecutiveFailures: 0, burntPhrases: new Set(), pastActions: [] };

    await this.browser.init();
    const page = this.browser.getPage();
    const urlInGoal = this.extractUrlFromPrompt(goal);
    let stepNumber = 0;

    // 1. AUTO-START (Navigation)
    if (urlInGoal) {
        const currentUrl = page.url();
        if (currentUrl === 'about:blank' || !currentUrl.includes(this.extractDomain(urlInGoal))) {
            stepNumber++;
            await this.navigate(urlInGoal);
            
            steps.push({ 
                stepNumber, 
                action: { type: 'navigate', url: urlInGoal, thought: 'Initial navigation' }, 
                success: true, 
                message: `Mapsd to ${urlInGoal}`, 
                urlBefore: 'about:blank', 
                urlAfter: urlInGoal, 
                stateChanged: true, 
                retryCount: 0 
            });
            await page.waitForTimeout(2000);
        }
    }

    let isFinished = false;

    while (stepNumber < maxSteps && !isFinished) {
      stepNumber++;
      
      // OBSERVE (Lite Mode First)
      // We do NOT take a screenshot yet. Screenshots are slow (100-300ms) and heavy.
      // We only extract selectors to see if we can solve this purely with code.
      const observationLite = await this.observe(false); 
      const elements = observationLite.selectors ?? [];
      const currentTitle = observationLite.title || '';
      
      // PLAN (Hybrid)
      // 1. Try Code-Based Plan (Free & Fast)
      let nextAction = this.tryDeterministicPlan(goal, elements, currentTitle, observationLite.url);
      let screenshotForStep: string | undefined = undefined;

      // 2. If Code failed, go to "Heavy Mode" (Screenshot + AI)
      if (!nextAction) {
          // Now we pay the cost of a screenshot because the AI needs it
          const screenshotObj = await this.browser.screenshot();
          screenshotForStep = screenshotObj.replace('data:image/png;base64,', '');
          
          nextAction = await this.planNextAgentAction(
              goal, 
              elements, 
              this.agentContext.pastActions, 
              "", 
              this.agentContext.burntPhrases, 
              currentTitle, 
              observationLite.url, 
              screenshotForStep
          );
      }

      config.broadcast?.({
          type: 'log',
          timestamp: new Date().toISOString(),
          message: `ai_thought: ${nextAction.thought}`,
          data: { role: 'agent-reasoning', thought: nextAction.thought }
      });

      // EXECUTE
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
               if (target) this.agentContext.burntPhrases.add(target.toLowerCase().trim());
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
          stepNumber, 
          action: nextAction, 
          success: actionSuccess, 
          message: actionDesc, 
          urlBefore: observationLite.url, 
          urlAfter: page.url(), 
          stateChanged: actionSuccess, 
          retryCount,
          screenshot: screenshotForStep // Only attach if we actually took one
      });
    }

    return { success: isFinished, summary: "Task Completed", goal, totalSteps: stepNumber, steps, commands: this.sessionHistory, seleniumCode: "" };
  }

  // --- PARSING ---
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

  // --- PLANNER (Fallback) ---
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
        return { type: 'wait', durationMs: 3000, thought: `Planner Error: ${err.message}` };
    }
  }

  private async executeAgentAction(action: AgentAction, elements: ElementInfo[]): Promise<{success: boolean, message: string}> {
    
    if (action.type === 'click') {
      // Type safety: Explicitly cast 'any' to fallback safe access
      // or rely on the union type which has selector/semanticTarget for 'click'
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
          // Resolve target for typing
          const res = await this.click(semanticTarget); // Using click logic to find element
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

  // Used by clickExact and standard actions to log descriptive history
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