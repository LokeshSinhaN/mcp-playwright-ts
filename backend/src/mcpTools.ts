import { GenerativeModel } from '@google/generative-ai';
import OpenAI from 'openai';
import { BrowserManager } from './browserManager';
import { SelectorExtractor } from './selectorExtractor';
import { SeleniumGenerator } from './seleniumGenerator';
import {
  ExecutionCommand,
  ExecutionResult,
  ElementInfo,
  SingleAgentAction,
  AgentStepResult,
  AgentSessionResult,
  AgentConfig
} from './types';
import { selectFromDropdown, selectOptionInOpenDropdown } from './dropdownUtils';

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

  // --- ROBUST URL EXTRACTION ---
  private extractUrlFromPrompt(prompt: string): string | null {
    // 1. Look for explicit HTTP/HTTPS
    const match = prompt.match(/https?:\/\/[^\s,;"']+/);
    if (match) return match[0];

    // 2. Look for "Go to X.com" pattern if http is missing
    const domainMatch = prompt.match(/\b(?:go to|navigate to|open)\s+([a-zA-Z0-9-]+\.[a-zA-Z]{2,})\b/i);
    if (domainMatch) return `https://${domainMatch[1]}`;

    return null;
  }

  private extractDomain(url: string): string {
    try { return new URL(url).hostname; } catch { return url; }
  }

  // ... [navigate, click, type, observe, handleCookieBanner methods - KEEP EXISTING IMPLEMENTATION] ...
  async navigate(url: string): Promise<ExecutionResult> {
      try {
          await this.browser.goto(url);
          // await this.browser.handleCookieBanner(); // Optional: Enable if needed
          this.recordCommand({ action: 'navigate', target: url });
          return { success: true, message: `Mapsd to ${url}` };
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
    const steps: AgentStepResult[] = [];
    const failedElements: Set<string> = new Set();
    const actionHistory: string[] = []; 

    await this.browser.init();
    const page = this.browser.getPage();

    // --- FIX 1: FORCE NAVIGATION START ---
    const urlInGoal = this.extractUrlFromPrompt(goal);
    
    // Clear history for a fresh agent run to avoid pollution
    this.sessionHistory = [];

    if (urlInGoal) {
        // ALWAYS navigate to ensure the script starts at the right place.
        // Even if the browser is technically there, we need the "driver.get()" in the script.
        try {
            console.log(`[Agent] Initializing navigation to: ${urlInGoal}`);
            await this.navigate(urlInGoal);
            actionHistory.push(`[SUCCESS] Navigated to ${urlInGoal}`);
            await page.waitForTimeout(2000); 
        } catch (e) {
            console.error("Navigation failed:", e);
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
      const stateBefore = await this.browser.getFingerprint();

      // THINK
      let nextActionsBatch = await this.planNextAgentAction(
        goal,
        elements,
        actionHistory,
        failedElements,
        screenshotBase64,
        config.modelProvider
      );

      const actionsToExecute = Array.isArray(nextActionsBatch) ? nextActionsBatch : [nextActionsBatch];
      
      const thought = (actionsToExecute[0] as any).thought || "Processing...";
      config.broadcast?.({
          type: 'log', timestamp: new Date().toISOString(),
          message: `ai_plan: ${thought}`,
          data: { role: 'agent-reasoning', thought }
      });

      // ACT
      let batchSuccess = true;
      this.agentCommandBuffer = []; 

      for (const action of actionsToExecute) {
          if (!batchSuccess) break;

          // Redundancy Check (Prevent Stuttering)
          if (this.isActionRedundant(action, this.sessionHistory.concat(this.agentCommandBuffer))) {
              continue; 
          }

          let retryCount = 0;
          let actionSuccess = false;
          let result: ExecutionResult | undefined;

          while (retryCount <= 1 && !actionSuccess) {
               // We catch errors here to prevent the agent from crashing on one bad click
               try {
                   result = await this.executeAgentAction(action, elements);
                   actionSuccess = result.success;
               } catch (e) {
                   actionSuccess = false;
               }

               if (actionSuccess) {
                   // Success! The command is already in agentCommandBuffer via recordCommand()
               } else {
                   retryCount++;
                   if (result?.failedSelector) failedElements.add(result.failedSelector);
                   await page.waitForTimeout(500);
               }
          }

          if (!actionSuccess && action.type !== 'wait') {
              batchSuccess = false;
              // Clear buffer so we don't record partial failing steps
              this.agentCommandBuffer = []; 
          } else {
              if (actionsToExecute.length > 1) await page.waitForTimeout(800);
          }
      }

      // COMMIT TO LONG-TERM MEMORY
      if (batchSuccess && this.agentCommandBuffer.length > 0) {
          this.sessionHistory.push(...this.agentCommandBuffer);
          actionHistory.push(`[SUCCESS] Executed: ${actionsToExecute.map(a => a.type).join(', ')}`);
          this.agentCommandBuffer = [];
      } else if (!batchSuccess) {
           actionHistory.push(`[FAIL] Failed to execute batch. Retrying...`);
      }
      
      // STATE CHECK
      const stateAfter = await this.browser.getFingerprint();
      const stateChanged = stateBefore.url !== stateAfter.url || stateBefore.contentHash !== stateAfter.contentHash;

      if (!stateChanged && batchSuccess) {
         // If we clicked but nothing happened, mark elements as failed to force AI to try new path
        for (const a of actionsToExecute) {
          if (a.type === 'click' && a.elementId && a.elementId.startsWith('el_')) {
            const idx = parseInt(a.elementId.split('_')[1], 10);
            if (elements[idx]?.cssSelector) failedElements.add(elements[idx].cssSelector!);
          }
        }
        actionHistory.push('[WARN] Last action had no effect; trying different elements.');
      }

      if (actionsToExecute.some(a => a.type === 'finish') && batchSuccess) isFinished = true;
      if (batchSuccess && !isFinished) await this.browser.waitForStability(2000); 
    }

    // --- FINAL CLEANUP: Optimize History for Production Code ---
    // This removes the "Failure Clicks" and "Unnecessary Steps"
    const productionCommands = this.optimizeCommands(this.sessionHistory);

    const summary = isFinished
      ? 'Process Completed! Generating production code.'
      : 'Session Ended without fully completing the goal';

    return {
        success: isFinished,
        summary,
        goal,
        totalSteps: stepNumber,
        steps,
        commands: productionCommands, // Return cleaned commands
        seleniumCode: await new SeleniumGenerator().generate(productionCommands)
    };
  }

  // --- FIX 2: PRODUCTION READY OPTIMIZER ---
  private optimizeCommands(commands: ExecutionCommand[]): ExecutionCommand[] {
      const clean: ExecutionCommand[] = [];

      for (let i = 0; i < commands.length; i++) {
          const cmd = commands[i];
          const next = commands[i + 1];
          const prev = clean.length > 0 ? clean[clean.length - 1] : null;

          // 1. Remove redundant Navigations
          // If we navigate to X, then immediately navigate to X again (or very similar), skip the second.
          if (cmd.action === 'navigate' && prev && prev.action === 'navigate' && prev.target === cmd.target) {
              continue;
          }

          // 2. Remove "Stuttering" Clicks
          // If we click the SAME selector twice in a row with no typing/navigating in between, it's usually a mistake.
          if (cmd.action === 'click' && prev && prev.action === 'click') {
              // Check if targets are identical
              if (prev.target === cmd.target || 
                  (prev.selectors?.xpath && prev.selectors.xpath === cmd.selectors?.xpath)) {
                  continue; 
              }
          }

          // 3. Consolidate Waits
          // If we have Wait(1) then Wait(2), just make it Wait(3) (or skip small redundant ones)
          if (cmd.action === 'wait') {
              if (next && next.action === 'wait') {
                  // Skip this one, let the next one handle it (or sum them if you prefer, but usually one is enough)
                  continue;
              }
              // Skip tiny waits (< 0.5s) if they are just artifacts
              if ((cmd.waitTime || 0) < 0.5) continue;
          }

          clean.push(cmd);
      }
      return clean;
  }

  // --- REDUNDANCY CHECKER (PRE-EXECUTION) ---
  private isActionRedundant(action: SingleAgentAction, history: ExecutionCommand[]): boolean {
      if (history.length === 0) return false;
      const lastCmd = history[history.length - 1];

      // Allow typing multiple times (filling form)
      if (action.type === 'type') return false;

      // Prevent selecting the exact same option twice
      if (action.type === 'select_option') {
          const opt = action.option?.toLowerCase();
          if (opt && lastCmd.description && lastCmd.description.toLowerCase().includes(opt)) {
              return true;
          }
      }

      // Prevent clicking the exact same thing twice
      if (action.type === 'click') {
          if (lastCmd.action === 'click') {
             // Strict check: if selector matches exact last target
             if (action.selector && lastCmd.target === action.selector) return true;
             // Semantic check: if we just clicked "Submit" and AI says "Click Submit" again immediately
             if (action.semanticTarget && lastCmd.description && lastCmd.description.includes(action.semanticTarget)) return true;
          }
      }
      return false;
  }

  // ... [keep executeAgentAction, planNextAgentAction, etc. exactly as they were in previous steps] ...
  
  // (Paste the executeAgentAction and planNextAgentAction from previous response here if not already present in your file)
  // Ensure 'executeAgentAction' uses the improved 'select_option' logic we discussed.

      // --- EXECUTE ACTION WITH ROBUST RECORDING ---

      private async executeAgentAction(action: SingleAgentAction, elements: ElementInfo[]): Promise<ExecutionResult> {
    // Resolve Element (if referenced by elementId)
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
        // CLICK (agent path uses BrowserManager directly to avoid double-recording)
        if (action.type === 'click') {
            if (!robustSelector) {
                return { success: false, message: 'No selector for click' };
            }

            const info = await this.browser.click(robustSelector);
            if (info) {
                selectorsForSelenium = {
                    css: info.cssSelector || selectorsForSelenium.css,
                    xpath: info.xpath || selectorsForSelenium.xpath,
                    id: info.id || selectorsForSelenium.id,
                    text: info.text || selectorsForSelenium.text
                };
            }

            this.recordCommand({ 
                action: 'click', 
                target: robustSelector,
                selectors: selectorsForSelenium, 
                description: `Click ${action.semanticTarget || targetElement?.text || 'element'}`
            });

            result = {
                success: true,
                message: `Clicked ${action.semanticTarget || targetElement?.text || robustSelector}`,
                selectors: info ? [info] : undefined
            };
        }
        
        // TYPE
        else if (action.type === 'type') {
            if (!robustSelector) {
                return { success: false, message: 'No selector for type' };
            }

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

        // NEW: SELECT_OPTION (dropdown intelligence)
        else if (action.type === 'select_option') {
            const page = this.browser.getPage();
            const optionLabel = action.option;
            const dropdownLabel =
                action.semanticTarget ||
                (targetElement?.ariaLabel ?? '') ||
                (targetElement?.placeholder ?? '') ||
                (targetElement?.text ?? '');

            // If we know which dropdown, open & select from it; otherwise assume it is already open.
            const selection = dropdownLabel
                ? await selectFromDropdown(page, dropdownLabel, optionLabel)
                : await selectOptionInOpenDropdown(page, optionLabel);

            const optionCss = selection.optionSelector;

            // --- FIX STARTS HERE ---
            // If we have a specific CSS for the option, use it.
            // If NOT (e.g. keyboard selection), we MUST force the recorder to look for the OPTION TEXT
            // otherwise it will just record a click on the "Dropdown Trigger" (selectorsForSelenium).
            let finalSelectors;
            
            if (optionCss && optionCss.trim().length > 0) {
                 finalSelectors = { css: optionCss, xpath: '', id: '', text: optionLabel };
            } else {
                 // Force text-based selection for Selenium fallback
                 finalSelectors = { 
                     css: '', 
                     xpath: `//*[contains(text(), '${optionLabel}')]`, // Explicit text fallback
                     id: '', 
                     text: optionLabel 
                 };
            }
            
            // If we didn't get a CSS selector, we must NOT use the 'robustSelector' (which is the dropdown button).
            // We use 'optionLabel' as the target name so SeleniumGenerator uses its text-matching logic.
            const targetName = (optionCss && optionCss.length > 0) ? optionCss : optionLabel;

            this.recordCommand({
                action: 'click',
                target: targetName,
                selectors: finalSelectors,
                description: `Select option "${optionLabel}"${dropdownLabel ? ` from "${dropdownLabel}" dropdown` : ''}`
            });
            // --- FIX ENDS HERE ---

            result = {
                success: true,
                message: `Selected option "${optionLabel}"`,
            };
        }

        // WAIT
        else if (action.type === 'wait') {
               await new Promise(r => setTimeout(r, action.durationMs));
               this.recordCommand({ action: 'wait', waitTime: action.durationMs / 1000 });
               result = { success: true, message: 'Waited' };
        }

        // NAVIGATE
        else if (action.type === 'navigate') {
               await this.navigate(action.url);
               result = { success: true, message: `Mapsd to ${action.url}` };
        }

        // FINISH (no browser action, just mark success)
        else if (action.type === 'finish') {
               result = {
                   success: true,
                   message: action.summary || 'Goal marked as complete by agent'
               };
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

  

            2. **For menu paths in the GOAL like "Reports -> Patients -> Patient Master List",
               treat each label as a distinct target and, once you have clicked an earlier
               label ("Reports", then "Patients"), prioritize clicking the FINAL label
               ("Patient Master List") instead of re-clicking earlier ones.**

  

            3. **BATCHING**: Return an ARRAY of actions for forms (e.g. Login).

  

            4. **DISTINCTION**: Look at 'label', 'placeholder', and 'type' to distinguish Username vs Password. 

  

               - Username usually has type='text'

  

               - Password usually has type='password'

  

            5. RETURN JSON ONLY. Format: 

  

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