// ... [Imports remain the same] ...
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

  // ... [Constructor and other methods remain the same] ...
  constructor(
    private readonly browser: BrowserManager, 
    private readonly gemini?: GenerativeModel,
    private readonly openai?: OpenAI
  ) {}

  private recordCommand(cmd: ExecutionCommand | ExecutionCommand[]): void {
    const cmds = Array.isArray(cmd) ? cmd : [cmd];
    if (this.agentCommandBuffer) {
      this.agentCommandBuffer.push(...cmds);
    } else {
      this.sessionHistory.push(...cmds);
    }
  }

  private extractStepsFromGoal(goal: string): string[] {
    const lines = goal.split('\n');
    return lines.filter(line => /^\d+\./.test(line.trim())).map(line => line.trim());
  }

  // ... [navigate, clickExact, type, observe, handleCookieBanner - KEEP AS IS] ...
  
  // --- KEEP navigate(), clickExact(), type(), observe() from previous code ---
  async navigate(url: string): Promise<ExecutionResult> {
      try {
          await this.browser.goto(url);
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

  // --- AGENT LOGIC ---

  async runAutonomousAgent(goal: string, config: AgentConfig = {}): Promise<AgentSessionResult> {
  const maxSteps = config.maxSteps ?? 30;
  const steps: AgentStepResult[] = [];
  const failedElements: Set<string> = new Set();
  const actionHistory: string[] = [];
  let errorSummary: string | undefined;
  let currentStep = 0; // Track current completed step for strict sequencing

    await this.browser.init();
    const page = this.browser.getPage();

    // 1. EXTRACT URL & NAVIGATE
    const urlInGoal = this.extractUrlFromPrompt(goal);
    this.sessionHistory = []; // Reset history for clean generation

    if (urlInGoal) {
        try {
            console.log(`[Agent] Initializing navigation to: ${urlInGoal}`);
            await this.navigate(urlInGoal);
            actionHistory.push(`[SUCCESS] Navigated to ${urlInGoal}`);
        } catch (e) {
            console.error("Navigation failed:", e);
        }
    }

    let stepNumber = 0;
    let isFinished = false;

    // ... [Agent Loop - Same as before] ...
    while (stepNumber < maxSteps && !isFinished) {
      stepNumber++;

      const extractor = new SelectorExtractor(page);
      const elements = await extractor.extractAllInteractive();
      const screenshotObj = await this.browser.screenshot();
      const screenshotBase64 = screenshotObj.replace('data:image/png;base64,', '');

      // Broadcast AI thinking (only if screenshot succeeded)
      if (config.broadcast && screenshotBase64) {
        config.broadcast({
          type: 'thought',
          timestamp: new Date().toISOString(),
          message: `AI is analyzing the current page state and planning next actions...`
        });
      }

      // Plan Action with timeout and screenshot check
      const planningTimeout = 30000; // 30 seconds timeout for AI planning
      let nextActionsBatch;
      try {
        // Skip planning if screenshot failed
        if (!screenshotBase64) {
          nextActionsBatch = [{ type: 'wait', durationMs: 1000, thought: 'Screenshot failed, waiting' } as SingleAgentAction];
        } else {
          nextActionsBatch = await Promise.race([
            this.planNextAgentAction(goal, elements, actionHistory, failedElements, screenshotBase64, config.modelProvider),
            new Promise<SingleAgentAction[]>((_, reject) =>
              setTimeout(() => reject(new Error('AI planning timed out')), planningTimeout)
            )
          ]);
        }
      } catch (error) {
        console.error('Planning timeout:', error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes('503') || errorMessage.includes('Service Unavailable') || errorMessage.includes('overloaded')) {
          errorSummary = `AI service unavailable: ${errorMessage}`;
          isFinished = true;
          if (config.broadcast) {
            config.broadcast({
              type: 'thought',
              timestamp: new Date().toISOString(),
              message: `Error: ${errorSummary}`
            });
          }
          break; // Exit the loop immediately
        } else {
          nextActionsBatch = [{ type: 'wait', durationMs: 2000, thought: 'Planning timed out, waiting' } as SingleAgentAction];
        }
      }
      const actionsToExecute = Array.isArray(nextActionsBatch) ? nextActionsBatch : [nextActionsBatch];

      // Broadcast the AI's thoughts
      if (config.broadcast && actionsToExecute.length > 0) {
        const thoughts = actionsToExecute.map(a => a.thought || 'No thought provided').join('; ');
        config.broadcast({
          type: 'thought',
          timestamp: new Date().toISOString(),
          message: `AI thought: ${thoughts}`
        });
      }

      // Execute Batch with dynamic wait times
      this.agentCommandBuffer = [];
      let batchSuccess = true;

      for (const action of actionsToExecute) {
         if (!batchSuccess) break;
         if (this.isActionRedundant(action as SingleAgentAction, this.sessionHistory.concat(this.agentCommandBuffer))) continue;

         try {
             const res = await this.executeAgentAction(action, elements);
             if (!res.success) {
                 batchSuccess = false;
                 if (res.failedSelector) failedElements.add(res.failedSelector);
             }
         } catch { batchSuccess = false; }

         // Dynamic wait: shorter for fast actions, longer if screenshot is slow
         const waitTime = action.type === 'click' || action.type === 'type' ? 300 : 800;
         await page.waitForTimeout(waitTime);
      }

      if (batchSuccess && this.agentCommandBuffer.length > 0) {
          this.sessionHistory.push(...this.agentCommandBuffer);
          actionHistory.push(`[SUCCESS] Executed steps`);
          this.agentCommandBuffer = [];

          // Broadcast actions taken
          if (config.broadcast) {
            const actionDescriptions = actionsToExecute.map(a => {
              switch (a.type) {
                case 'click':
                  const clickAction = a as { type: 'click'; elementId?: string; semanticTarget?: string };
                  return `Clicked ${clickAction.elementId || clickAction.semanticTarget || 'element'}`;
                case 'type':
                  const typeAction = a as { type: 'type'; text: string; elementId?: string; semanticTarget?: string };
                  return `Typed "${typeAction.text}" into ${typeAction.elementId || typeAction.semanticTarget || 'element'}`;
                case 'navigate':
                  const navAction = a as { type: 'navigate'; url: string };
                  return `Navigated to ${navAction.url}`;
                case 'select_option':
                  const selectAction = a as { type: 'select_option'; option: string; elementId?: string; semanticTarget?: string };
                  return `Selected "${selectAction.option}" from ${selectAction.elementId || selectAction.semanticTarget || 'dropdown'}`;
                case 'scrape_data':
                  const scrapeAction = a as { type: 'scrape_data'; instruction: string };
                  return `Scraped data: ${scrapeAction.instruction}`;
                case 'scroll':
                  const scrollAction = a as { type: 'scroll'; direction: string; elementId?: string };
                  return `Scrolled ${scrollAction.direction} on ${scrollAction.elementId || 'page'}`;
                case 'wait':
                  const waitAction = a as { type: 'wait'; durationMs: number };
                  return `Waited ${waitAction.durationMs}ms`;
                case 'finish': return 'Completed task';
                default: return 'Unknown action';
              }
            }).join('; ');
            config.broadcast({
              type: 'action_taken',
              timestamp: new Date().toISOString(),
              message: `Actions taken: ${actionDescriptions}`
            });
          }
      }

      if (actionsToExecute.some(a => a.type === 'finish') && batchSuccess) isFinished = true;
      if (batchSuccess && !isFinished) {
        // Increment currentStep only if we completed a step towards the goal
        if (actionsToExecute.some(a => a.type !== 'wait')) {
          currentStep++;
        }
        // Dynamic stability wait based on page load
        const stabilityWait = elements.length > 50 ? 2000 : 1000;
        await this.browser.waitForStability(stabilityWait);
      }
    }

    // --- CRITICAL: OPTIMIZE & GENERATE ---
    const optimizedCommands = this.optimizeHistory(this.sessionHistory);
    
    // Pass 'urlInGoal' directly to generator to force it at the top
    const seleniumCode = await new SeleniumGenerator().generate(
        optimizedCommands, 
        urlInGoal || undefined
    );

    return {
        success: isFinished,
        summary: isFinished ? 'Goal Completed' : 'Stopped',
        goal,
        totalSteps: stepNumber,
        steps,
        commands: optimizedCommands,
        seleniumCode
    };
  }

  // --- UNIVERSAL FIX: SEQUENCE DEDUPLICATOR ---
  private optimizeHistory(commands: ExecutionCommand[]): ExecutionCommand[] {
       const clean: ExecutionCommand[] = [];

       for (let i = 0; i < commands.length; i++) {
           const curr = commands[i];

           // 1. Skip tiny waits
           if (curr.action === 'wait' && (curr.waitTime || 0) < 1) continue;

           // 2. Loop Detection (A -> B -> A -> B)
           // If the last two commands in 'clean' are identical to the next two (curr, next), skip.
           if (clean.length >= 2 && i + 1 < commands.length) {
               const last1 = clean[clean.length - 1];
               const last2 = clean[clean.length - 2];
               const next = commands[i+1];

               if (this.cmdsMatch(last2, curr) && this.cmdsMatch(last1, next)) {
                   // Detected loop pattern: [Report, Patient] -> [Report, Patient]
                   // Skip 'curr' (Report) and increment i to skip 'next' (Patient)
                   i++;
                   continue;
               }
           }

           // 3. Stutter Detection (Click X -> Click X)
           if (clean.length > 0) {
               const last = clean[clean.length - 1];
               if (this.cmdsMatch(last, curr) && curr.action === 'click') {
                   continue;
               }
           }

           // 4. Dropdown Toggle Loop Detection (Open Dropdown -> Check State -> Open Dropdown -> Check State)
           // Detect repetitive dropdown opening without progress
           if (clean.length >= 3 && curr.action === 'click' && curr.description?.includes('dropdown')) {
               const lastThree = clean.slice(-3);
               const isDropdownLoop = lastThree.every(cmd =>
                   cmd.action === 'click' && cmd.description?.includes('dropdown')
               );
               if (isDropdownLoop) {
                   continue; // Skip this redundant dropdown click
               }
           }

           clean.push(curr);
       }
       return clean;
   }

  private cmdsMatch(a: ExecutionCommand, b: ExecutionCommand): boolean {
      if (a.action !== b.action) return false;
      if (a.action === 'click') {
          // Match if CSS or XPath or Target string is identical
          return (a.selectors?.css === b.selectors?.css && !!a.selectors?.css) ||
                 (a.selectors?.xpath === b.selectors?.xpath && !!a.selectors?.xpath) ||
                 (a.target === b.target);
      }
      return false;
  }

  // ... [Keep helper methods like extractUrlFromPrompt, executeAgentAction, planNextAgentAction] ...
  
  private extractUrlFromPrompt(prompt: string): string | null {
    const match = prompt.match(/https?:\/\/[^\s,;"']+/);
    if (match) return match[0];
    const domainMatch = prompt.match(/\b(?:go to|navigate to|open)\s+([a-zA-Z0-9-]+\.[a-zA-Z]{2,})\b/i);
    if (domainMatch) return `https://${domainMatch[1]}`;
    return null;
  }

  // (Paste your existing executeAgentAction / planNextAgentAction here - no changes needed there)
  // Ensure executeAgentAction still has the dropdown fix I gave in step 1.

    // --- IMPROVED PROMPT PLANNING ---

        private async planNextAgentAction(

         goal: string,

         elements: ElementInfo[],

         history: string[],

         failedElements: Set<string>,

         screenshot: string,

         provider: 'gemini' | 'openai' = 'gemini',

         currentStep: number = 0

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

  

                    name: el.attributes['name'],




                    checked: el.checked

  

                }));

  

        

  

                const prompt = `

  

            SYSTEM: You are an expert RPA Agent. Goal: "${goal}".

  

            HISTORY: ${history.slice(-5).join('; ')}

  

            

  

            UI ELEMENTS:

  

            ${JSON.stringify(simplified)}

  

        

  

            INSTRUCTIONS:

  

            1. Analyze the UI to find the next logical step(s).

  

            2. **For hierarchical navigation paths in the GOAL (indicated by arrows like "A -> B -> C"),
               treat each level as a distinct target. Once you have navigated to an intermediate level,
               focus on reaching the final destination without unnecessarily backtracking to earlier levels.**

  

            3. **SEQUENTIAL STEPS**: If the GOAL contains numbered steps (e.g., 1., 2., 3.), execute them strictly in order, one at a time. Do not skip or combine steps. Identify the next uncompleted step based on HISTORY and execute only that step. Current completed steps: ${currentStep}. Focus only on the next step (${currentStep + 1}).

   

            4. **BATCHING**: Return an ARRAY of actions for forms (e.g. Login). For sequential steps, batch only within a single step if it requires multiple actions.

  

            5. **DISTINCTION**: Look at 'label', 'placeholder', and 'type' to distinguish Username vs Password.

  

               - Username usually has type='text'

  - Password usually has type='password'




6. **CHECKBOXES**: For checkboxes (type='checkbox'), check the 'checked' field. Only click to uncheck if 'checked' is true. Do not click if already unchecked.





7. **COMPLETION**: When you have completed all steps in the goal, return a 'finish' action with an appropriate summary.





8. RETURN JSON ONLY. Format:

  

               [

  

                 { "type": "type", "elementId": "el_1", "text": "myUser", "thought": "Typing user" },

  

                 { "type": "type", "elementId": "el_2", "text": "myPass", "thought": "Typing pass" },

  { "type": "click", "elementId": "el_3", "thought": "Login" },




  { "type": "finish", "thought": "Task completed", "summary": "Logged in successfully" }




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
             // Prevent repetitive dropdown opening
             if (action.semanticTarget && action.semanticTarget.toLowerCase().includes('dropdown') &&
                 lastCmd.description && lastCmd.description.toLowerCase().includes('dropdown')) {
                 return true;
             }
          }
      }
      return false;
  }
}