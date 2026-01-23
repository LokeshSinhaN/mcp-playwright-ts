import { GenerativeModel } from '@google/generative-ai';
import OpenAI from 'openai'; // NEW
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

  // Updated Constructor to accept both models
  constructor(
    private readonly browser: BrowserManager, 
    private readonly gemini?: GenerativeModel,
    private readonly openai?: OpenAI
  ) {}

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
      // Navigation resets the "burnt" cache because we are on a new page
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
  // =================== INTELLIGENT PLANNER LOGIC =============================
  // ===========================================================================

  private tryDeterministicPlan(goal: string, elements: ElementInfo[]): AgentAction | null {
      const lowerGoal = goal.toLowerCase();
      
      if (lowerGoal.includes('username') || lowerGoal.includes('password') || lowerGoal.includes('login to') || lowerGoal.includes('search for')) {
          return null; 
      }

      const ignoredWords = ['navigate', 'click', 'to', 'the', 'open', 'filter', 'scroll', 'find', 'options', 'wait', 'check', 'select', 'and', 'only', 'from', 'if', 'they', 'are', 'not', 'then', 'menu', 'button'];
      
      let cleanGoal = lowerGoal;
      const goalKeywords = cleanGoal.split(/[^a-z0-9]+/).filter(w => w.length > 3 && !ignoredWords.includes(w));

      for (const keyword of goalKeywords) {
          if (this.agentContext.burntPhrases.has(keyword)) continue;

          const matches = elements.filter(el => {
              if (!el.visible && !el.isVisible) return false;
              
              const tag = el.tagName.toLowerCase();
              const role = (el.roleHint || '').toLowerCase();
              const isInteractive = tag === 'button' || tag === 'a' || tag === 'input' || tag === 'select' || role === 'button' || role === 'link' || role === 'checkbox' || role === 'listbox' || role === 'combobox';

              if (!isInteractive) return false;

              const text = (el.text || '').toLowerCase();
              const label = (el.ariaLabel || '').toLowerCase();
              
              if (text === keyword || label === keyword) return true;
              if ((role === 'listbox' || role === 'combobox' || tag === 'select' || role === 'input') && (text.includes(keyword) || label.includes(keyword))) {
                  return true;
              }

              return false;
          });

          if (matches.length === 1) { 
             const bestMatch = matches[0];
             return {
                 type: 'click',
                 selector: bestMatch.selector || bestMatch.cssSelector,
                 semanticTarget: keyword,
                 thought: `Deterministic: Found unique interactive element "${keyword}". Executing.`
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

    // 1. Intelligent Start
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
      
      const observationLite = await this.observe(false); 
      const elements = observationLite.selectors ?? [];
      
      // 2. Deterministic Check
      let nextAction = this.tryDeterministicPlan(goal, elements);

      // 3. AI Planning (The Brain)
      let screenshotForStep: string | undefined = undefined;
      
      if (!nextAction) {
          const screenshotObj = await this.browser.screenshot();
          screenshotForStep = screenshotObj.replace('data:image/png;base64,', '');
          
          try {
              nextAction = await this.planNextAgentAction(
                  goal, elements, this.agentContext.pastActions, 
                  this.agentContext.burntPhrases, screenshotForStep,
                  config.modelProvider // Pass the chosen provider
              );
          } catch (err: any) {
              if (String(err).includes('429')) {
                   console.log("Rate Limit Hit. Waiting 20s...");
                   await new Promise(r => setTimeout(r, 20000));
                   nextAction = { type: 'wait', durationMs: 2000, thought: 'Rate limit recovery' };
              } else {
                  console.error("Agent planning error:", err);
                  nextAction = { type: 'scroll', direction: 'down', thought: 'AI unavailable, scrolling to find more elements' };
              }
          }
      }

      config.broadcast?.({
          type: 'log', timestamp: new Date().toISOString(),
          message: `ai_thought: ${nextAction.thought}`,
          data: { role: 'agent-reasoning', thought: nextAction.thought }
      });

      // 4. Execution Loop
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
               const target = (nextAction as any).semanticTarget || (nextAction as any).text || '';
               if (target) {
                   const lowerTarget = target.toLowerCase().trim();
                   this.agentContext.burntPhrases.add(lowerTarget);
                   if (result.success && (nextAction as any).selector) {
                        const el = elements.find(e => e.cssSelector === (nextAction as any).selector || e.selector === (nextAction as any).selector);
                        if (el && el.text) this.agentContext.burntPhrases.add(el.text.toLowerCase().trim());
                   }
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

  // --- INTELLIGENT PROMPT ENGINEERING ---
  private async planNextAgentAction(
    goal: string,
    elements: ElementInfo[],
    actionHistory: string[],
    burntPhrases: Set<string>, 
    screenshot: string | undefined,
    modelProvider: 'gemini' | 'openai' = 'gemini'
  ): Promise<AgentAction> {
    
    if (elements.length === 0) {
        return { type: 'wait', durationMs: 3000, thought: 'No interactive elements found.' };
    }

    // Filter out "burnt" items
    const validElements = elements.filter(el => {
        const text = (el.text || '').toLowerCase().trim();
        // Exception: Always show login-related fields even if burnt (retries)
        if (text.includes('user') || text.includes('pass') || text.includes('log') || text.includes('sign')) return true;
        if (burntPhrases.has(text)) return false;
        return true;
    });

    const elementList = validElements.slice(0, 200).map((el, idx) => ({
        id: `el_${idx}`,  
        tag: el.tagName,
        text: (el.text || '').slice(0, 60).replace(/\s+/g, ' '),
        role: el.roleHint,
        label: (el.ariaLabel || '').slice(0, 50),
        type: el.attributes?.['type'] 
    }));

    const systemInstructions = `
SYSTEM: Web Automation Agent.
GOAL: ${goal}
HISTORY: ${actionHistory.slice(-5).join('; ')}

ELEMENTS (Interactive):
${JSON.stringify(elementList)}

INSTRUCTIONS:
1. **Login Check**: If you just typed a password, you MUST look for a "Login", "Sign In", or "Go" button and CLICK it. Do not wait.
2. **Missing Elements**: If you cannot find the target (e.g., "Insurance"), return a "scroll" action to find it.
3. **Credentials**: If the goal has username/password, type them into the inputs.
4. **Navigation**: If logged in, proceed with the menu steps.

RETURN JSON ONLY: { "type": "click"|"type"|"finish"|"wait"|"scroll", "elementId": "el_X", "text"?: "...", "thought": "..." }
`;

    let responseText = '';

    // --- GEMINI PROVIDER ---
    if (modelProvider === 'gemini') {
        if (!this.gemini) return { type: 'finish', thought: 'Gemini not configured', summary: 'No Gemini Model' };
        
        try {
            // For Gemini, we pass parts. If screenshot exists, we add inline data.
            const parts: any[] = [{ text: systemInstructions }];
            if (screenshot) {
                 parts.push({
                    inlineData: {
                        data: screenshot,
                        mimeType: 'image/png'
                    }
                });
            }

            const result = await this.gemini.generateContent({ 
                contents: [{ role: 'user', parts }]
            });
            responseText = result.response.text();
        } catch (err) {
            console.error("Gemini API Error:", err);
            throw err;
        }
    } 
    // --- OPENAI PROVIDER ---
    else if (modelProvider === 'openai') {
        if (!this.openai) return { type: 'finish', thought: 'OpenAI not configured', summary: 'No OpenAI Client' };

        try {
            const messages: any[] = [
                { role: "system", content: "You are a web automation assistant. You respond only in JSON." },
            ];

            const userContent: any[] = [
                { type: "text", text: systemInstructions }
            ];

            if (screenshot) {
                userContent.push({
                    type: "image_url",
                    image_url: {
                        url: `data:image/png;base64,${screenshot}`,
                        detail: "high"
                    }
                });
            }

            messages.push({ role: "user", content: userContent });

            const completion = await this.openai.chat.completions.create({
                model: "gpt-5", // Uses GPT-4o for best vision capabilities
                messages: messages,
                response_format: { type: "json_object" }, // Enforce JSON
                max_tokens: 1000
            });

            responseText = completion.choices[0].message.content || '';
        } catch (err) {
            console.error("OpenAI API Error:", err);
            throw err;
        }
    } else {
        return { type: 'finish', thought: 'Unknown Model Provider', summary: 'Config Error' };
    }

    // --- PARSE & MAP BACK ---
    const parsed = this.parseAgentActionResponse(responseText);
    
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
  }

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
