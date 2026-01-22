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

  // --- NAVIGATION WITH STABILITY CHECK ---
  async navigate(url: string): Promise<ExecutionResult> {
    try {
      console.log(`[Navigating] ${url}`);
      await this.browser.goto(url);
      
      const page = this.browser.getPage();
      await page.waitForLoadState('domcontentloaded');
      
      // Heuristic: Wait for visual stability
      await page.waitForTimeout(2000); 
      
      return { success: true, message: `Mapsd to ${url}` };
    } catch (error: any) {
      return { success: false, message: error.message };
    }
  }

  // --- ROBUST CLICK ---
  async clickExact(selector: string, description?: string): Promise<ExecutionResult> {
    const command: ExecutionCommand = {
      action: 'click',
      target: selector,
      description: description || `Clicked element ${selector}`,
    };
    try {
      // Use BrowserManager's robust click (handles frames/hover)
      await this.browser.click(selector);
      this.agentCommandBuffer?.push(command);
      return { success: true, message: `Clicked ${selector}` };
    } catch (error: any) {
      return { success: false, message: error.message };
    }
  }

  async type(selector: string, text: string): Promise<ExecutionResult> {
    const command: ExecutionCommand = {
      action: 'type',
      target: selector,
      value: text,
      description: `Typed "${text}" into ${selector}`,
    };

    try {
      await this.browser.type(selector, text);
      this.agentCommandBuffer?.push(command);
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
    
    // Use the Extractor to find elements (pierces Shadow DOM/Frames)
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

  async clickWithHeuristics(prompt: string, candidates: any[]): Promise<ExecutionResult> {
    const tokens = prompt.toLowerCase().split(/\s+/).filter(t => t.length > 3);
    const best = candidates.find(c => {
        const text = (c.text || c.ariaLabel || '').toLowerCase();
        return tokens.some(t => text.includes(t));
    });

    if (best && best.selector) {
        return this.clickExact(best.selector);
    }
    return { success: false, message: `Could not confidently identify an element for "${prompt}"` };
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
        .map(el => `${el.tagName}|${(el.text||'').slice(0,10)}|${el.roleHint}`)
        .join(';');
    
    let hash = 0;
    for (let i = 0; i < signature.length; i++) {
        const char = signature.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
    }
    return hash.toString(16);
  }

  // --- IMPROVED: Deterministic Planner (Loop-Proof & Context Aware) ---
  private tryDeterministicPlan(goal: string, elements: ElementInfo[], currentTitle: string, currentUrl: string): AgentAction | null {
      const lowerGoal = goal.toLowerCase();
      
      const potentialTargets = elements.filter(el => {
          const text = (el.text || '').toLowerCase();
          const label = (el.ariaLabel || '').toLowerCase();
          const context = (el.context || '').toLowerCase(); // Critical for "Insurance" label
          
          if (text.length > 2 && lowerGoal.includes(text)) return true;
          if (label.length > 2 && lowerGoal.includes(label)) return true;
          // Context match (e.g. goal "Insurance", context "Insurance")
          if (context.length > 2 && lowerGoal.includes(context)) return true;
          
          return false;
      });

      // Filter matches
      const bestTargets = potentialTargets.sort((a, b) => (b.text?.length || 0) - (a.text?.length || 0));

      if (bestTargets.length > 0) {
          const best = bestTargets[0];
          const bestText = (best.text || best.context || best.ariaLabel || '').toLowerCase().trim();

          // --- FIX 1: GLOBAL SESSION HISTORY CHECK (The Loop Killer) ---
          // If we have EVER clicked this specific text in this session, assume it's done.
          const alreadyClickedInSession = this.sessionHistory.some(cmd => {
              const desc = (cmd.description || '').toLowerCase();
              return desc.includes(`"${bestText}"`) || desc.includes(` ${bestText} `) || desc.includes(`'${bestText}'`);
          });
          
          if (alreadyClickedInSession) {
             console.log(`[Deterministic] Skipping "${bestText}" - already interacted in this session.`);
             return null; // YIELD TO LLM
          }

          // --- FIX 2: GOAL AWARENESS (The Context Fix) ---
          // If the page Title or URL already contains the navigation target, stop clicking nav links.
          // Example: Goal "Navigate to Patient Master List" and Title is "Patient Master List".
          if (lowerGoal.includes('navigate') && bestText.length > 4) {
             const titleClean = currentTitle.toLowerCase();
             const urlClean = currentUrl.toLowerCase();
             
             // If the button text (e.g. "Patient Master List") is already in the title/url, we are likely THERE.
             if (titleClean.includes(bestText) || urlClean.includes(bestText.replace(/\s/g, ''))) {
                  console.log(`[Deterministic] Skipping "${bestText}" - seems we are already on this page.`);
                  return null; // YIELD TO LLM (It will move to step 2)
             }
          }
          // ----------------------------------------

          if (lowerGoal.includes('click') || lowerGoal.includes('navigate') || lowerGoal.includes('open')) {
              return {
                  type: 'click',
                  selector: best.selector || best.cssSelector,
                  semanticTarget: bestText, // Pass this so we can log it properly
                  thought: `Deterministic: Found exact text match "${best.text || best.context}" for goal. Skipping AI.`
              };
          }
          if (lowerGoal.includes('type') || lowerGoal.includes('enter')) {
              const match = goal.match(/["']([^"']+)["']/);
              if (match) {
                  return {
                      type: 'type',
                      selector: best.selector || best.cssSelector,
                      text: match[1],
                      thought: `Deterministic: Found input "${bestText}" and text "${match[1]}". Skipping AI.`
                  };
              }
          }
      }
      
      return null; // Fallback to AI
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
    
    // 1. Initial Navigation (Explicit Step 1)
    let stepNumber = 0;
    if (urlInGoal) {
        const currentUrl = page.url();
        const targetDomain = this.extractDomain(urlInGoal);
        
        // Only navigate if we aren't already there
        if (currentUrl === 'about:blank' || !currentUrl.includes(targetDomain)) {
            stepNumber++;
            config.broadcast?.({ type: 'log', timestamp: new Date().toISOString(), message: `ai_thought: Navigating to ${urlInGoal} as the start of the session.` });
            
            await this.navigate(urlInGoal);
            
            // Record this as a step
            const navAction: AgentAction = { type: 'navigate', url: urlInGoal, thought: 'Initial navigation' };
            steps.push({ stepNumber, action: navAction, success: true, message: `Mapsd to ${urlInGoal}`, urlBefore: 'about:blank', urlAfter: urlInGoal, stateChanged: true, retryCount: 0 });
            
            // Log explicitly to UI
            config.broadcast?.({ type: 'log', timestamp: new Date().toISOString(), message: `Step ${stepNumber}: Navigated to ${urlInGoal}` });
            
            // Add to history so LLM knows we did it
            this.sessionHistory.push({ action: 'navigate', target: urlInGoal, description: `Mapsd to ${urlInGoal}` });
            
            // Wait for Login fields if relevant
            if (goal.toLowerCase().includes('login')) {
                 try { await page.waitForSelector('input', { timeout: 4000 }); } catch {}
            }
        }
    }

    let isFinished = false;
    let lastFingerprint = '';

    while (stepNumber < maxSteps && !isFinished) {
      stepNumber++;
      
      // 2. Observation (With Retry for Empty Pages)
      let observation = await this.observe(true);
      if (!observation.selectors || observation.selectors.length === 0) {
          await page.waitForTimeout(2000);
          observation = await this.observe(true);
      }

      const elements = observation.selectors ?? [];
      const currentFingerprint = this.calculateDomFingerprint(elements);
      const currentTitle = observation.title || '';
      const currentUrl = observation.url || '';
      
      // 3. Loop Detection
      let feedbackForPlanner = '';
      if (stepNumber > 1 && lastFingerprint === currentFingerprint) {
          const lastAction = steps[steps.length - 1]?.action;
          if (lastAction && (lastAction.type === 'click' || lastAction.type === 'navigate')) {
              // Extract what we tried to click
              const lastCmd = this.sessionHistory[this.sessionHistory.length - 1];
              const match = lastCmd?.description?.match(/"([^"]+)"/);
              const burnedLabel = match ? match[1] : null;

              if (burnedLabel && burnedLabel.length > 2) {
                  this.agentContext.ineffectivePhrases.add(burnedLabel);
                  feedbackForPlanner = `CRITICAL: Clicking "${burnedLabel}" did nothing. DO NOT click it again. Try a different element.`; 
              } else {
                  feedbackForPlanner = `CRITICAL: Last action had NO EFFECT. Choose a different action.`; 
              }
          }
      }

      // 4. Inject Login Awareness
      const hasPasswordField = elements.some(el => 
        (el.attributes?.type === 'password') || 
        (el.text?.toLowerCase().includes('password')) ||
        (el.placeholder?.toLowerCase().includes('password'))
      );
      if (hasPasswordField && stepNumber < 5) {
          feedbackForPlanner += "\nCRITICAL: You are on a LOGIN PAGE. Fill Username & Password first.";
      }

      // 5. Plan Next Move
      let nextAction = await this.planNextAgentAction(
          goal, 
          elements, 
          this.agentContext.pastActions, 
          feedbackForPlanner, 
          this.agentContext.ineffectivePhrases,
          currentTitle,
          currentUrl,
          observation.screenshot
      );

      // Log thought to UI
      config.broadcast?.({
          type: 'log',
          timestamp: new Date().toISOString(),
          message: `ai_thought: ${nextAction.thought}`,
          data: { role: 'agent-reasoning', thought: nextAction.thought }
      });

      // 6. Execute
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
               if (this.agentCommandBuffer.length > 0) {
                   this.sessionHistory.push(...this.agentCommandBuffer);
               }
           } else {
               retryCount++;
               await page.waitForTimeout(1000);
           }
      }

      const actionDesc = this.describeAction(nextAction, actionSuccess);
      this.agentContext.pastActions.push(actionDesc);
      if (this.agentContext.pastActions.length > 5) this.agentContext.pastActions.shift();

      // LOG STEP TO UI (The "Step X: Clicked..." log)
      if (actionSuccess) {
           config.broadcast?.({ 
               type: 'log', 
               timestamp: new Date().toISOString(), 
               message: `Step ${stepNumber}: ${actionDesc.replace('[SUCCESS] ', '')}` 
           });
      }

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
      
      // Safety Valve: Force scroll if stuck
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

  // --- PARSING ---
  private parseAgentActionResponse(responseText: string): AgentAction {
    let clean = responseText.replace(/```json\s*|\s*```/gi, '').trim();
    const jsonStr = this.extractBalancedJson(clean);
    
    if (!jsonStr) {
       return { type: 'wait', durationMs: 1000, thought: responseText.slice(0, 100) };
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

  // --- PLANNER ---
  private async planNextAgentAction(
    goal: string,
    elements: ElementInfo[],
    actionHistory: string[],
    feedbackForPlanner: string,
    ineffectivePhrases: Set<string>,
    currentTitle: string,
    currentUrl: string,
    screenshot?: string
  ): Promise<AgentAction> {
    
    // 1. Fail Fast
    if (elements.length === 0) {
        return { type: 'wait', durationMs: 3000, thought: 'CRITICAL: No interactive elements found. Page likely loading.' };
    }

    // --- NEW: Try Deterministic Plan First ---
    // Pass current title/URL to help it avoid navigation loops
    if (this.agentContext.consecutiveFailures === 0 && !feedbackForPlanner.includes('CRITICAL')) {
        const deterministicAction = this.tryDeterministicPlan(goal, elements, currentTitle, currentUrl);
        if (deterministicAction) {
            return deterministicAction;
        }
    }
    // ----------------------------------------

    if (!this.model) return { type: 'finish', thought: 'No AI model', summary: 'No AI' };

    // 2. Filter & Map Elements
    const validElements = elements.filter(el => {
        const text = (el.text || '').trim();
        const label = (el.ariaLabel || '').trim();
        if (ineffectivePhrases.has(text) || ineffectivePhrases.has(label)) return false;
        for (const bad of ineffectivePhrases) {
            if (text.includes(bad) || label.includes(bad)) return false;
        }
        return true;
    });

    const elementList = validElements.slice(0, 100).map((el, idx) => ({
        id: `el_${idx}`,  
        tag: el.tagName,
        text: (el.text || '').slice(0, 50).replace(/\s+/g, ' '),
        role: el.roleHint,
        label: (el.ariaLabel || '').slice(0, 50),
        ph: (el.placeholder || ''),
        type: el.attributes?.type
    }));

    const prompt = `
SYSTEM: Intelligent Web Agent.
GOAL: ${goal}

HISTORY:
${actionHistory.slice(-5).join('\n')}

FEEDBACK: ${feedbackForPlanner || "None."}
DEAD ENDS: ${Array.from(ineffectivePhrases).join(', ')}

ELEMENTS:
${JSON.stringify(elementList)}

INSTRUCTIONS:
1. **Login:** If you see username/password fields, FILL THEM.
2. **Type:** Use { "type": "type", "elementId": "el_X", "text": "...", "thought": "..." }
3. **Click:** Use { "type": "click", "elementId": "el_X", "thought": "..." }
4. **Retry:** If "el_X" failed before, choose a different one.

RETURN ONLY JSON.
`;

    try {
        let response = '';
        let attempts = 0;
        while (attempts < 3) {
            try {
                const result = await this.model.generateContent({ contents: [{ role: 'user', parts: [{ text: prompt }] }] } as any);
                response = (result as any).response?.text?.() ?? '';
                break;
            } catch (e) {
                attempts++;
                await new Promise(r => setTimeout(r, 2000));
                if (attempts === 3) throw e;
            }
        }

        const parsed = this.parseAgentActionResponse(response);
        
        if ((parsed.type === 'click' || parsed.type === 'type' || parsed.type === 'select_option') && parsed.elementId) {
            const match = parsed.elementId.match(/el_(\d+)/);
            if (match) {
                const idx = parseInt(match[1]);
                const el = validElements[idx];
                if (el) {
                    parsed.selector = el.cssSelector || el.selector || el.xpath;
                } else {
                     return { type: 'wait', durationMs: 2000, thought: `AI hallucinated ID ${parsed.elementId}. Waiting.` };
                }
            }
        }
        return parsed;

    } catch (err: any) {
        console.error('[Planner Error]', err.message);
        return { 
            type: 'wait', 
            durationMs: 3000, 
            thought: `Planner API Error: ${err.message}. Retrying...` 
        };
    }
  }

  private async executeAgentAction(action: AgentAction, elements: ElementInfo[]): Promise<any> {
    // --- FIX: ENHANCED DESCRIPTION FOR HISTORY TRACKING ---
    // We construct a descriptive string (e.g., "Clicked 'Patients'") so the
    // Deterministic Planner can see "Patients" in the history later.
    const desc = (action as any).semanticTarget 
        ? `${action.type === 'type' ? 'Typed into' : 'Clicked'} "${(action as any).semanticTarget}"`
        : undefined;

    if (action.type === 'click') {
      if (action.selector) {
        return await this.clickExact(action.selector, desc);
      }
      return { success: false, message: "Missing selector for click" };
    } 
    else if (action.type === 'type') {
      if (action.selector) {
        return await this.type(action.selector, action.text);
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

  private describeAction(action: AgentAction, success: boolean): string {
    const status = success ? 'SUCCESS' : 'FAIL';
    
    let tgt = 'page';
    if (action.type === 'click' || action.type === 'type' || action.type === 'select_option') {
        tgt = (action as any).semanticTarget || action.selector || action.elementId || 'page';
    }

    if (action.type === 'type') return `[${status}] Type "${action.text}" into ${tgt}`;
    if (action.type === 'click') return `[${status}] Click ${tgt}`;
    if (action.type === 'navigate') return `[${status}] Navigate to ${action.url}`;
    
    return `[${status}] ${action.type}`;
  }
}