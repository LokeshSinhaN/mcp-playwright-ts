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
import { selectFromDropdown, selectOptionInOpenDropdown, parseDropdownInstruction } from './dropdownUtils';

// Track context about what works and what doesn't
interface AgentContext {
  consecutiveFailures: number;
  ineffectivePhrases: Set<string>; 
  pastActions: string[]; 
}

export class McpTools {
  private sessionHistory: ExecutionCommand[] = [];
  private agentCommandBuffer: ExecutionCommand[] | null = null;
  private agentContext: AgentContext = {
      consecutiveFailures: 0,
      ineffectivePhrases: new Set(),
      pastActions: []
  };

  constructor(private readonly browser: BrowserManager, private readonly model?: GenerativeModel) {}

  // --- FIX 1: CORRECT URL REGEX ---
  private extractUrlFromPrompt(prompt: string): string | null {
    // Previous code had a typo: /https?:\]\/[^\s]+/
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

  async navigate(url: string): Promise<ExecutionResult> {
    try {
      console.log(`[Navigating] ${url}`);
      await this.browser.goto(url);
      
      // CRITICAL: Wait for the visual page to settle
      const page = this.browser.getPage();
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(2000); // Hard wait for React/Angular hydration
      
      return { success: true, message: `Mapsd to ${url}` };
    } catch (error: any) {
      return { success: false, message: error.message };
    }
  }

  async click(
    elementId: string,
    elements: ElementInfo[]
  ): Promise<ExecutionResult> {
    const element = elements[parseInt(elementId.split('_')[1])];
    if (!element) {
      return { success: false, message: 'Element not found' };
    }

    const selector = element.selector;
    if (!selector) {
        return { success: false, message: 'Element has no selector' };
    }

    const desc =
      element.text || element.ariaLabel || element.tagName || 'element';
    const command: ExecutionCommand = {
      action: 'click',
      target: selector,
      description: `Clicked "${desc}"`,
    };

    try {
      await this.browser.click(selector);
      this.agentCommandBuffer?.push(command);
      return { success: true, message: `Clicked ${desc}` };
    } catch (e1) {
      console.log(`Direct click failed for ${selector}, trying JS click.`);
      try {
        await this.browser.getPage().evaluate((sel) => {
          const el = document.querySelector(sel) as HTMLElement;
          el?.click();
        }, selector);
        this.agentCommandBuffer?.push(command);
        return {
          success: true,
          message: `Clicked ${desc} using JavaScript.`,
        };
      } catch (e2: any) {
        return { success: false, message: e2.message };
      }
    }
  }

  async clickExact(selector: string): Promise<ExecutionResult> {
    const command: ExecutionCommand = {
      action: 'click',
      target: selector,
      description: `Clicked element matching selector ${selector}`,
    };
    try {
      await this.browser.click(selector);
      this.agentCommandBuffer?.push(command);
      return { success: true, message: `Clicked ${selector}` };
    } catch (error: any) {
      return { success: false, message: error.message };
    }
  }

  async withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    timeoutMessage: string
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(timeoutMessage));
      }, ms);

      promise
        .then((res) => {
          clearTimeout(timer);
          resolve(res);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  private sanitizeElementsForLLM(elements: ElementInfo[]): any[] {
    return elements.slice(0, 150).map((el, idx) => ({
      id: `el_${idx}`,
      tag: el.tagName,
      text: (el.text || '').slice(0, 100).replace(/\s+/g, ' '),
      ariaLabel: (el.ariaLabel || '').slice(0, 100).replace(/\s+/g, ' '),
      role: el.roleHint,
    }));
  }

  private extractCoreLabel(element: ElementInfo): string {
    return (
      element.text ||
      element.ariaLabel ||
      element.placeholder ||
      'Unnamed Element'
    ).trim();
  }

  async identifyTargetWithLLM(
    elements: ElementInfo[],
    instruction: string
  ): Promise<string | null> {
    if (!this.model) {
      throw new Error('Generative model not available.');
    }

    const simplifiedElements = this.sanitizeElementsForLLM(elements);

    const prompt = `
      You are an expert system for mapping human language to web elements.
      Based on the following instruction, identify the single best element from the list.
      Instruction: "${instruction}"
      Elements:
      ${JSON.stringify(simplifiedElements, null, 2)}

      Respond with ONLY the JSON object for the single best matching element, or null if no clear match is found.
    `;

    try {
      const result = await this.withTimeout(
        this.model.generateContent({ contents: [{ role: 'user', parts: [{ text: prompt }] }] } as any),
        3000,
        'LLM element identification timed out.'
      );
      const responseText = (result as any).response?.text?.() ?? '';
      const matchedElement = JSON.parse(responseText.trim());

      if (matchedElement && matchedElement.id) {
        const elementIndex = parseInt(matchedElement.id.split('_')[1]);
        if (!isNaN(elementIndex) && elements[elementIndex]) {
          const selector = elements[elementIndex].selector;
          return selector || null;
        }
      }
      return null;
    } catch (error) {
      console.error('Error identifying target with LLM:', error);
      return null;
    }
  }

  async clickWithHeuristics(
    instruction: string,
    elements: ElementInfo[]
  ): Promise<ExecutionResult> {
    const selector = await this.identifyTargetWithLLM(elements, instruction);
    if (selector) {
      return this.clickExact(selector);
    }

    const dropdownInstruction = parseDropdownInstruction(instruction);
    if (dropdownInstruction) {
      if (dropdownInstruction.kind === 'open-and-select') {
        const result = await selectFromDropdown(
          this.browser.getPage(),
          dropdownInstruction.dropdownLabel,
          dropdownInstruction.optionLabel
        );
        return { success: !!result.optionSelector, message: `Selected option using ${result.method}` };
      } else if (dropdownInstruction.kind === 'select-only') {
        const result = await selectOptionInOpenDropdown(
          this.browser.getPage(),
          dropdownInstruction.optionLabel
        );
        return { success: !!result.optionSelector, message: `Selected option using ${result.method}` };
      }
    }

    return {
      success: false,
      message: `Could not identify a clickable element for: "${instruction}"`,
    };
  }

  async type(
    elementIdOrSelector: string,
    text: string,
    elements?: ElementInfo[]
  ): Promise<ExecutionResult> {
    let selector: string | undefined;
    let desc: string;

    if (elements && elementIdOrSelector.startsWith('el_')) {
      const element = elements[parseInt(elementIdOrSelector.split('_')[1])];
      if (!element) {
        return { success: false, message: 'Element not found' };
      }
      selector = element.selector;
      desc =
        element.text || element.ariaLabel || element.tagName || 'element';
    } else {
      selector = elementIdOrSelector;
      desc = `element with selector ${selector}`;
    }

    if (!selector) {
        return { success: false, message: 'Element has no selector' };
    }

    const command: ExecutionCommand = {
      action: 'type',
      target: selector,
      value: text,
      description: `Typed "${text}" into ${desc}`,
    };

    try {
      await this.browser.type(selector, text);
      this.agentCommandBuffer?.push(command);
      return { success: true, message: `Typed "${text}" into ${desc}` };
    } catch (error: any) {
      return { success: false, message: error.message };
    }
  }

  async handleCookieBanner(
    elements: ElementInfo[]
  ): Promise<ExecutionResult> {
    const bannerKeywords = [
      'accept all',
      'agree',
      'allow cookies',
      'ok',
      'got it',
      'i agree',
    ];
    const cookieElement = elements.find((el) => {
      const elText = (el.text || '').toLowerCase();
      return bannerKeywords.some((keyword) => elText.includes(keyword));
    });

    if (cookieElement && cookieElement.selector) {
      return this.clickExact(cookieElement.selector);
    }

    return { success: false, message: 'No cookie banner found.' };
  }

  async observe(useVision: boolean = false): Promise<{
    url: string;
    selectors: ElementInfo[];
    screenshot?: string;
  }> {
    const page = this.browser.getPage();
    const url = page.url();
    const extractor = new SelectorExtractor(page);
    const selectors = await extractor.extractAllInteractive();

    if (useVision) {
      // Use a safer screenshot approach (return existing if current fails)
      const screenshot = await this.browser.screenshot();
      return {
        url,
        selectors,
        screenshot: screenshot.replace('data:image/png;base64,', ''),
      };
    }

    return { url, selectors };
  }

  async generateSelenium(
    existingCommands: ExecutionCommand[] = []
  ): Promise<{ seleniumCode: string; success: boolean }> {
    const generator = new SeleniumGenerator();
    const allCommands = [...this.sessionHistory, ...existingCommands];
    const seleniumCode = generator.generate(allCommands);
    return { seleniumCode, success: true };
  }
  
  private calculateDomFingerprint(elements: ElementInfo[]): string {
    const signature = elements
        .filter(el => el.visible && ['button', 'a', 'input', 'select', 'textarea'].includes(el.tagName))
        .map(el => {
            return `${el.tagName}|${(el.text||'').slice(0,10)}|${el.roleHint}`;
        })
        .join(';');
    
    let hash = 0;
    for (let i = 0; i < signature.length; i++) {
        const char = signature.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
    }
    return hash.toString(16);
  }

  // ===========================================================================
  // =================== INTELLIGENT AUTONOMOUS AGENT ==========================
  // ===========================================================================

  async runAutonomousAgent(goal: string, config: AgentConfig = {}): Promise<AgentSessionResult> {
    const maxSteps = config.maxSteps ?? 30;
    this.sessionHistory = []; 
    const steps: AgentStepResult[] = [];
    
    this.agentContext = {
        consecutiveFailures: 0,
        ineffectivePhrases: new Set<string>(),
        pastActions: []
    };

    await this.browser.init();
    const page = this.browser.getPage();
    const urlInGoal = this.extractUrlFromPrompt(goal);
    
    // Initial Navigation
    if (urlInGoal) {
        const currentUrl = page.url();
        if (currentUrl === 'about:blank' || !currentUrl.includes(this.extractDomain(urlInGoal))) {
            await this.navigate(urlInGoal);
            // Double check: Wait specifically for Inputs if "Login" is in the goal
            if (goal.toLowerCase().includes('login')) {
                console.log("[Agent] Waiting for login fields...");
                try {
                    await page.waitForSelector('input', { timeout: 5000 });
                } catch {
                    console.log("[Agent] Warning: No inputs found immediately.");
                }
            }
        }
    }

    let stepNumber = 0;
    let isFinished = false;
    let lastFingerprint = '';

    while (stepNumber < maxSteps && !isFinished) {
      stepNumber++;
      
      // Observation with Retry
      let observation = await this.observe(true);
      if (!observation.selectors || observation.selectors.length === 0) {
          console.log("Empty page detected. Waiting...");
          await page.waitForTimeout(3000);
          observation = await this.observe(true);
      }

      const elements = observation.selectors ?? [];
      const currentFingerprint = this.calculateDomFingerprint(elements);
      
      let feedbackForPlanner = '';
      if (stepNumber > 1 && lastFingerprint === currentFingerprint) {
          const lastAction = steps[steps.length - 1]?.action;
          if (lastAction && (lastAction.type === 'click' || lastAction.type === 'navigate')) {
              let burnedLabel = '';
              if (lastAction.type === 'click' && lastAction.elementId) {
                  const lastCmd = this.sessionHistory[this.sessionHistory.length - 1];
                  const match = lastCmd?.description?.match(/"([^"]+)"/); 
                  if (match) burnedLabel = match[1];
              }

              if (burnedLabel && burnedLabel.length > 2) {
                  this.agentContext.ineffectivePhrases.add(burnedLabel);
                  feedbackForPlanner = `CRITICAL: Clicking "${burnedLabel}" changed NOTHING. It is broken or requires a HOVER. Mark it as 'Ineffective' and DO NOT click it again. Try a different strategy.`; 
              } else {
                  feedbackForPlanner = `CRITICAL: The last action had NO EFFECT on the page state. Do not repeat it.`; 
              }
          }
      }

      // FIX 2: Strict "Login First" Logic in the Prompt
      // We inject a specific instruction if we detect we are likely on a login page
      const hasPasswordField = elements.some(el => 
        (el.attributes?.type === 'password') || 
        (el.text?.toLowerCase().includes('password')) ||
        (el.placeholder?.toLowerCase().includes('password'))
      );
      
      let systemInstruction = "";
      if (hasPasswordField && stepNumber < 5) {
          systemInstruction = "CRITICAL: You are on a LOGIN PAGE. You MUST fill in the Username and Password and click Login. DO NOT attempt to click other menu links (like 'Reports') until you have successfully logged in.";
      }

      // Pass this new instruction to planNextAgentAction
      let nextAction = await this.planNextAgentAction(
          goal, 
          elements, 
          this.agentContext.pastActions, 
          feedbackForPlanner + "\n" + systemInstruction, 
          this.agentContext.ineffectivePhrases,
          observation.screenshot
      );

      config.broadcast?.({
          type: 'log',
          timestamp: new Date().toISOString(),
          message: `ai_thought: ${nextAction.thought}`,
          data: { role: 'agent-reasoning', thought: nextAction.thought }
      });

      const urlBefore = page.url();
      let actionSuccess = false;
      let actionMessage = '';
      
      let retryCount = 0;
      while (retryCount <= 1 && !actionSuccess) {
           this.agentCommandBuffer = []; 
           const result = await this.executeAgentAction(nextAction, elements);
           actionSuccess = result.success;
           actionMessage = result.message;
           
           if (actionSuccess) {
               if (this.agentCommandBuffer.length > 0) this.sessionHistory.push(...this.agentCommandBuffer);
           } else {
               retryCount++;
               await page.waitForTimeout(1000);
           }
      }

      const actionDesc = this.describeAction(nextAction, actionSuccess);
      this.agentContext.pastActions.push(actionDesc);
      if (this.agentContext.pastActions.length > 5) this.agentContext.pastActions.shift();

      if (nextAction.type === 'finish' && actionSuccess) isFinished = true;
      
      steps.push({ 
          stepNumber, 
          action: nextAction, 
          success: actionSuccess, 
          message: actionMessage, 
          urlBefore, 
          urlAfter: page.url(), 
          stateChanged: lastFingerprint !== currentFingerprint, 
          retryCount 
      });

      lastFingerprint = currentFingerprint;
      
      const last3 = this.agentContext.pastActions.slice(-3);
      if (last3.length === 3 && last3.every(a => a === last3[0]) && !isFinished) {
          await this.browser.scroll(undefined, 'down');
          this.agentContext.pastActions.push('SYSTEM_FORCED_SCROLL');
      }
    }

    return { 
        success: isFinished, 
        summary: `Completed ${steps.length} steps.`, 
        goal, 
        totalSteps: stepNumber, 
        steps, 
        commands: [...this.sessionHistory], 
        seleniumCode: await this.generateSelenium().then(r => r.seleniumCode) 
    };
  }

  // --- FIX 2: IMPROVED PARSING & SAFETY ---
  private parseAgentActionResponse(responseText: string): AgentAction {
    const jsonStr = this.extractBalancedJson(responseText);
    if (!jsonStr) {
      return { type: 'wait', durationMs: 1000, thought: 'Invalid AI JSON.' };
    }
    try {
      const parsed = JSON.parse(jsonStr);
      // Fallback: If AI puts 'value' instead of 'text' for type actions, map it.
      if (parsed.type === 'type' && !parsed.text && parsed.value) {
          parsed.text = parsed.value;
      }
      return parsed as AgentAction;
    } catch (e) {
      return { type: 'wait', durationMs: 1000, thought: 'Malformed AI JSON.' };
    }
  }

  private extractBalancedJson(str: string): string | null {
    let openBraces = 0;
    let startIndex = -1;
    for (let i = 0; i < str.length; i++) {
      if (str[i] === '{') {
        if (openBraces === 0) startIndex = i;
        openBraces++;
      } else if (str[i] === '}') {
        openBraces--;
        if (openBraces === 0 && startIndex !== -1) return str.substring(startIndex, i + 1);
      }
    }
    return null;
  }

  private async planNextAgentAction(
    goal: string,
    elements: ElementInfo[],
    actionHistory: string[],
    feedbackForPlanner: string,
    ineffectivePhrases: Set<string>,
    screenshot?: string
  ): Promise<AgentAction> {
    if (!this.model) return { type: 'finish', thought: 'No AI model', summary: 'No AI' };

    const validElements = elements.filter(el => {
        const text = (el.text || '').trim();
        const label = (el.ariaLabel || '').trim();
        if (ineffectivePhrases.has(text)) return false;
        if (ineffectivePhrases.has(label)) return false;
        for (const badPhrase of ineffectivePhrases) {
            if (text.includes(badPhrase) || label.includes(badPhrase)) return false;
        }
        return true;
    });

    const elementList = validElements.slice(0, 150).map((el, idx) => ({
        id: `el_${idx}`, 
        tag: el.tagName,
        text: (el.text || '').slice(0, 50).replace(/\s+/g, ' '),
        role: el.roleHint,
        state: el.expanded ? 'OPEN' : 'CLOSED', 
    }));

    // --- FIX 3: EXPLICIT JSON EXAMPLES FOR TYPING ---
    const prompt = `
SYSTEM: You are an intelligent autonomous agent.
GOAL: ${goal}

HISTORY (Last 5 steps):
${actionHistory.join('\n')}

**CRITICAL FEEDBACK:**
${feedbackForPlanner || "None. Proceed."} 

**DEAD ENDS (Do not click):**
${Array.from(ineffectivePhrases).join(', ')}

AVAILABLE INTERACTIVE ELEMENTS:
${JSON.stringify(elementList)}

INSTRUCTIONS:
1. **Analyze Feedback:** If last action failed, CHANGE strategy.
2. **Typing:** If the goal is to type, use { "type": "type", "elementId": "el_X", "text": "YOUR TEXT", "thought": "..." }.
3. **Menu:** If a menu click failed, it might need a hover or is already open.
4. **No Loops:** Do not repeat the exact same action.

RETURN ONLY JSON matching these shapes:
- { "type": "click", "elementId": "el_X", "thought": "..." }
- { "type": "type", "elementId": "el_X", "text": "value", "thought": "..." }
- { "type": "scroll", "direction": "down", "thought": "..." }
- { "type": "finish", "thought": "...", "summary": "..." }
`;

    try {
        const result = await this.model.generateContent({ contents: [{ role: 'user', parts: [{ text: prompt }] }] } as any);
        const response = (result as any).response?.text?.() ?? '';
        const parsed = this.parseAgentActionResponse(response);
        
        if ('elementId' in parsed && parsed.elementId) {
            const match = parsed.elementId.match(/el_(\d+)/);
            if (match) {
                const idx = parseInt(match[1]);
                const el = validElements[idx]; 
                if (el) {
                    if('selector' in parsed){
                        parsed.selector = el.selector || el.cssSelector;
                    }
                    delete parsed.elementId; 
                }
            }
        }
        return parsed;
    } catch (err) {
        return { type: 'wait', durationMs: 2000, thought: 'Planner failed' };
    }
  }

  private async executeAgentAction(action: AgentAction, elements: ElementInfo[]): Promise<any> {
    if (action.type === 'click') {
      if (action.selector) {
        return await this.clickExact(action.selector);
      } else if (action.elementId) {
        return this.click(action.elementId, elements);
      }
    } else if (action.type === 'type') {
      if (action.selector) {
        return await this.type(action.selector, action.text);
      } else if (action.elementId) {
        return this.type(action.elementId, action.text, elements);
      }
    } else if (action.type === 'navigate') {
      return this.navigate(action.url);
    } else if (action.type === 'scroll') {
      await this.browser.scroll(action.elementId, action.direction);
      return { success: true, message: 'Scrolled' };
    } else if (action.type === 'wait') {
      await new Promise((r) => setTimeout(r, action.durationMs));
      return { success: true, message: 'Waited' };
    } else if (action.type === 'finish') {
      return { success: true, message: action.summary };
    }
    
    return { success: false, message: "Action execution failed or action not recognized" };
  }

  private describeAction(action: AgentAction, success: boolean): string {
    const status = success ? 'SUCCESS' : 'FAIL';
    switch (action.type) {
      case 'click':
        return `[${status}] Click ${action.selector || action.elementId}`;
      case 'type':
        return `[${status}] Type "${action.text}" into ${action.selector || action.elementId}`;
      case 'scroll':
        return `[${status}] Scroll ${action.direction}`;
      case 'navigate':
        return `[${status}] Navigate to ${action.url}`;
      case 'finish':
        return `[${status}] Finish: ${action.summary}`;
      default:
        return `[${status}] Unknown action`;
    }
  }
}