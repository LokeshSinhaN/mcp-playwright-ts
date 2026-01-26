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
  SingleAgentAction,
  AgentStepResult,
  AgentSessionResult,
  AgentConfig,
  StateFingerprint
} from './types';

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
    
    // 1. INTELLIGENT INITIALIZATION
    // We do NOT wipe sessionHistory here to allow multi-turn conversations.
    // However, we must ensure the "Navigate" command is recorded if this is a fresh start.
    
    const steps: AgentStepResult[] = [];
    const failedElements: Set<string> = new Set();
    const actionHistory: string[] = []; // Natural language log for the AI prompt

    await this.browser.init();
    const page = this.browser.getPage();

    // 2. CONTEXT AWARE NAVIGATION (Fixes "Missing URL in Code")
    const urlInGoal = this.extractUrlFromPrompt(goal);
    if (urlInGoal) {
        const currentUrl = page.url();
        // If we need to go there, go there.
        if (currentUrl === 'about:blank' || !currentUrl.includes(this.extractDomain(urlInGoal))) {
             await this.navigate(urlInGoal); // This records to sessionHistory internally
             actionHistory.push(`[SUCCESS] Navigated to ${urlInGoal}`);
             await page.waitForTimeout(2000); // Allow full load
        } else {
             // CRITICAL FIX: If we are *already* there (e.g. from a previous test),
             // we MUST still record this navigation event for the Selenium code generator
             // or the script will be missing the "driver.get()" line.
             const alreadyThereCmd: ExecutionCommand = { 
                 action: 'navigate', 
                 target: urlInGoal,
                 description: `Start at ${urlInGoal}`
             };
             // Only add if not already the last command
             const last = this.sessionHistory[this.sessionHistory.length - 1];
             if (!last || last.action !== 'navigate') {
                 this.sessionHistory.push(alreadyThereCmd);
             }
        }
    }

    let stepNumber = 0;
    let isFinished = false;

    // 3. MAIN EXECUTION LOOP
    while (stepNumber < maxSteps && !isFinished) {
      stepNumber++;

      // OBSERVE
      const extractor = new SelectorExtractor(page);
      const elements = await extractor.extractAllInteractive();
      const screenshotObj = await this.browser.screenshot();
      const screenshotBase64 = screenshotObj.replace('data:image/png;base64,', '');

      // THINK
      // (We pass the 'actionHistory' so the AI knows "I just clicked Reports")
      let nextActionsBatch = await this.planNextAgentAction(
        goal,
        elements,
        actionHistory,
        failedElements,
        screenshotBase64,
        config.modelProvider
      );

      // Normalize
      const actionsToExecute = Array.isArray(nextActionsBatch) ? nextActionsBatch : [nextActionsBatch];
      
      // LOGGING (Fixes "Typing User" appearing late)
      // We log what we *plan* to do, not just what we did.
      const thought = (actionsToExecute[0] as any).thought || "Processing...";
      config.broadcast?.({
          type: 'log', timestamp: new Date().toISOString(),
          message: `ai_plan: ${thought} (${actionsToExecute.length} steps)`,
          data: { role: 'agent-reasoning', thought }
      });

      // ACT
      let batchSuccess = true;
      let batchMessage = '';
      this.agentCommandBuffer = []; 

      for (const action of actionsToExecute) {
          if (!batchSuccess) break;

          // INTELLIGENT FILTER: Prevent "Stuttering" (Repeating the same click)
          if (this.isActionRedundant(action, this.sessionHistory.concat(this.agentCommandBuffer))) {
              console.log("Skipping redundant action:", action);
              continue; 
          }

          let retryCount = 0;
          let actionSuccess = false;
          let result: ExecutionResult | undefined;

          while (retryCount <= 1 && !actionSuccess) {
               result = await this.executeAgentAction(action, elements);
               actionSuccess = result.success;

               if (actionSuccess) {
                   // command is recorded into agentCommandBuffer inside executeAgentAction
               } else {
                   retryCount++;
                   if (result?.failedSelector) failedElements.add(result.failedSelector);
                   await page.waitForTimeout(500);
               }
          }

          if (!actionSuccess) {
              // If a non-essential step fails (like a hover), we might want to continue,
              // but for now, we fail the batch to force a re-think.
              if (action.type !== 'wait') {
                  batchSuccess = false;
                  batchMessage = `Failed: ${action.type}`;
                  this.agentCommandBuffer = []; 
              }
          } else {
              // Visual Pacing
              if (actionsToExecute.length > 1) await page.waitForTimeout(800);
          }
      }

      // COMMIT TO LONG-TERM MEMORY
      if (batchSuccess && this.agentCommandBuffer.length > 0) {
          const cleanCommands = this.optimizeCommands(this.agentCommandBuffer);
          this.sessionHistory.push(...cleanCommands);
          
          // Add to natural language history for the AI prompt
          const summary = `[SUCCESS] Executed: ${actionsToExecute.map(a => a.type).join(', ')}`;
          actionHistory.push(summary);
          
          this.agentCommandBuffer = [];
      } else if (!batchSuccess) {
           actionHistory.push(`[FAIL] Failed to execute batch. Retrying...`);
      }
      
      // Check finish
      if (actionsToExecute.some(a => a.type === 'finish') && batchSuccess) isFinished = true;

      // ... [Step recording logic remains the same] ...
      
      // STABILITY WAIT
      if (batchSuccess && !isFinished) {
          await this.browser.waitForStability(2000); 
      }
    }

    return { 
        success: isFinished, 
        summary: "Session Ended", 
        goal, 
        totalSteps: stepNumber, 
        steps, 
        commands: this.sessionHistory, 
        seleniumCode: await new SeleniumGenerator().generate(this.sessionHistory)
    };
  }

  // --- NEW: REDUNDANCY CHECKER ---
  // Returns true if we are about to click the same thing we JUST clicked.
  private isActionRedundant(action: SingleAgentAction, history: ExecutionCommand[]): boolean {
      if (history.length === 0) return false;
      const lastCmd = history[history.length - 1];

      // If we are typing, it's rarely redundant (could be filling multiple fields)
      if (action.type === 'type') return false;

      // If we are clicking
      if (action.type === 'click') {
          // Check if we just clicked the exact same selector
          if (lastCmd.action === 'click' && action.selector && lastCmd.target === action.selector) {
              return true; 
          }
          // Check if we just clicked the same semantic target (e.g. "Reports")
          if (lastCmd.description && action.semanticTarget && lastCmd.description.includes(action.semanticTarget)) {
              return true;
          }
      }
      return false;
  }

  // --- NEW HELPER: CLEAN UP COMMANDS ---
  private optimizeCommands(commands: ExecutionCommand[]): ExecutionCommand[] {
      return commands.filter((cmd, index) => {
          // 1. Remove failed actions (if any slipped through)
          // (Logic mostly handled by batch success check, but good safety net)
          
          // 2. Remove redundant waits (e.g., consecutive waits)
          if (cmd.action === 'wait') {
              const next = commands[index + 1];
              if (next && next.action === 'wait') return false; // Skip this wait if next is also wait
          }
          
          return true;
      });
  }

  

      // --- EXECUTE ACTION WITH ROBUST RECORDING ---

  

      private async executeAgentAction(action: SingleAgentAction, elements: ElementInfo[]): Promise<ExecutionResult> {
    // Resolve Element
    let targetElement: ElementInfo | undefined;
    if ('elementId' in action && action.elementId && action.elementId.startsWith('el_')) {
        const idx = parseInt(action.elementId.split('_')[1]);
        targetElement = elements[idx];
    }

    let robustSelector = 'selector' in action ? action.selector : undefined;
    
    // Prepare Full Selenium Data
    let selectorsForSelenium = { css: '', xpath: '', id: '', text: '' };
    if (targetElement) {
        robustSelector = targetElement.cssSelector || targetElement.selector;
        selectorsForSelenium = {
            css: targetElement.cssSelector || '',
            xpath: targetElement.xpath || '',
            id: targetElement.id || '',
            text: targetElement.text || ''
        };
    } else if (action.type === 'click' && action.semanticTarget) {
        selectorsForSelenium.text = action.semanticTarget;
    }

    let result: ExecutionResult = { success: false, message: '' };

    try {
        if (action.type === 'click') {
            if (robustSelector) {
                 result = await this.clickExact(robustSelector, action.semanticTarget);
                 // Record with FULL DATA
                 this.recordCommand({ 
                     action: 'click', 
                     target: robustSelector,
                     selectors: selectorsForSelenium, 
                     description: `Click ${action.semanticTarget || targetElement?.text || 'element'}`
                 });
            } else {
                 result = { success: false, message: "No selector for click" };
            }
        }
        else if (action.type === 'type') {
            if (robustSelector) {
                 await this.browser.type(robustSelector, action.text);
                 this.recordCommand({ 
                     action: 'type', 
                     target: robustSelector, 
                     value: action.text,
                     selectors: selectorsForSelenium,
                     description: `Type "${action.text}" into ${action.semanticTarget || 'field'}`
                 });
                 result = { success: true, message: `Filled "${action.text}"` };
            }
        }
        else if (action.type === 'wait') {
               await new Promise(r => setTimeout(r, action.durationMs));
               this.recordCommand({ action: 'wait', waitTime: action.durationMs / 1000 });
               result = { success: true, message: "Waited" };
        }
        else if (action.type === 'navigate') {
               await this.navigate(action.url);
               result = { success: true, message: `Navigated to ${action.url}` };
        }
    } catch (e: any) {
        return { success: false, message: e.message, failedSelector: robustSelector };
    }
    return result;
  }

  

    // --- IMPROVED PROMPT PLANNING ---

        private async planNextAgentAction(

          goal: string,

          elements: ElementInfo[],

          history: string[],

          failedElements: Set<string>,

          screenshot: string,

          provider: 'gemini' | 'openai' = 'gemini'

        ): Promise<SingleAgentAction | SingleAgentAction[]> {

        

        const visibleEl = elements.filter(el => 

            el.visible && !failedElements.has(el.cssSelector || '')

        );

  

                const simplified = visibleEl.slice(0, 200).map((el, i) => ({

  

                    id: `el_${i}`,

  

                    tag: el.tagName,

  

                    // CRITICAL: Send input type (password/text) so LLM isn't blind

  

                    type: el.attributes['type'] || 'text', 

  

                    text: (el.text || '').slice(0, 50),

  

                    label: el.ariaLabel || el.placeholder || '',

  

                    name: el.attributes['name']

  

                }));

  

        

  

                const prompt = `

  

            SYSTEM: You are an expert RPA Agent. Goal: "${goal}".

  

            HISTORY: ${history.slice(-5).join('; ')}

  

            

  

            UI ELEMENTS:

  

            ${JSON.stringify(simplified)}

  

        

  

            INSTRUCTIONS:

  

            1. Analyze the UI to find the next logical step(s).

  

            2. **BATCHING**: Return an ARRAY of actions for forms (e.g. Login).

  

            3. **DISTINCTION**: Look at 'label', 'placeholder', and 'type' to distinguish Username vs Password. 

  

               - Username usually has type='text'

  

               - Password usually has type='password'

  

            4. RETURN JSON ONLY. Format: 

  

               [

  

                 { "type": "type", "elementId": "el_1", "text": "myUser", "thought": "Typing user" },

  

                 { "type": "type", "elementId": "el_2", "text": "myPass", "thought": "Typing pass" },

  

                 { "type": "click", "elementId": "el_3", "thought": "Login" }

  

               ]

  

            `;

  

        // ... [LLM Call Logic (Gemini/OpenAI) - Same as before] ...

        // Assume 'responseText' is fetched here

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

        

        return this.parseAgentActionResponse(responseText);

    }

  

    private parseAgentActionResponse(raw: string): SingleAgentAction | SingleAgentAction[] {

        // Clean markdown

        let clean = raw.replace(/```json\s*|\s*```/gi, '').trim();

        const start = clean.indexOf('[');

        const startObj = clean.indexOf('{');

        

        // Heuristic to detect array vs object

        const isArray = start !== -1 && (startObj === -1 || start < startObj);

        

        try {

            if (isArray) {

                const parsed = JSON.parse(clean);

                return parsed;

            } else {

                // Try parsing as object, if fails, might be wrapped in garbage

                const s = clean.indexOf('{');

                const e = clean.lastIndexOf('}');

                if (s !== -1 && e !== -1) clean = clean.substring(s, e + 1);

                return JSON.parse(clean);

            }

        } catch {

             return { type: 'wait', durationMs: 2000, thought: 'Failed to parse JSON' };

        }

    }

  async generateSelenium(commands: ExecutionCommand[]): Promise<ExecutionResult> {
    try {
      // If the frontend sends empty commands (common bug), use the server's persistent history
      const commandsToUse = (commands && commands.length > 0) 
                            ? commands 
                            : this.sessionHistory;

      if (commandsToUse.length === 0) {
          return { success: false, message: 'No actions recorded to generate code from.' };
      }

      const seleniumCode = await new SeleniumGenerator().generate(commandsToUse);
      return { success: true, message: 'Selenium code generated', seleniumCode };
    } catch (e: any) {
      return { success: false, message: e.message };
    }
  }
}