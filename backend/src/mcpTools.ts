// ... [Imports remain the same] ...
import { GenerativeModel } from '@google/generative-ai';
import OpenAI from 'openai';
import { BrowserManager } from './browserManager';
import { SelectorExtractor } from './selectorExtractor';
import { SeleniumGenerator } from './seleniumGenerator';
import { parseSopText, ParsedSop } from './sopParser';
import {
  ExecutionCommand,
  ExecutionResult,
  ElementInfo,
  SingleAgentAction,
  AgentStepResult,
  AgentSessionResult,
  AgentConfig,
  WebSocketMessage
} from './types';
import { selectFromDropdown, selectOptionInOpenDropdown, parseDropdownInstruction, DropdownIntent } from './dropdownUtils';

export class McpTools {
  private sessionHistory: ExecutionCommand[] = [];
  private agentCommandBuffer: ExecutionCommand[] | null = null;
  private processedItems: Set<string> = new Set(); // Track processed items for state awareness
  private seleniumGenerator: SeleniumGenerator;
  private currentSop: ParsedSop | null = null;
  
  // NEW: Loop detection and progress tracking
  private actionRetryCount: Map<string, number> = new Map();
  private lastBroadcastAction: string = '';
  private consecutiveNoActionCount: number = 0;
  private currentSopStep: number = 0;
  private readonly MAX_RETRIES_PER_ACTION = 3;
  private readonly MAX_CONSECUTIVE_NO_ACTION = 5;

  // ... [Constructor and other methods remain the same] ...
  constructor(
    private readonly browser: BrowserManager,
    private readonly gemini?: GenerativeModel,
    private readonly openai?: OpenAI
  ) {
    this.seleniumGenerator = new SeleniumGenerator({}, gemini, openai);
  }
  
  // NEW: Reset progress tracking for new session
  private resetProgressTracking(): void {
    this.actionRetryCount.clear();
    this.lastBroadcastAction = '';
    this.consecutiveNoActionCount = 0;
    this.currentSopStep = 0;
  }
  
  // NEW: Detect and handle action loops
  private checkForLoop(action: SingleAgentAction, config: AgentConfig): { isLoop: boolean; message: string } {
    // Get action identifier based on action type (type-safe)
    let actionId = '';
    if (action.type === 'click' || action.type === 'type') {
      actionId = action.elementId || ('semanticTarget' in action ? action.semanticTarget || '' : '');
    } else if (action.type === 'select_option') {
      actionId = 'option' in action ? (action.option || '') : '';
      if (!actionId) actionId = 'semanticTarget' in action ? (action.semanticTarget || '') : '';
    } else if (action.type === 'navigate') {
      actionId = action.url || '';
    } else if (action.type === 'scrape_data') {
      actionId = action.instruction || '';
    } else if (action.type === 'scroll') {
      actionId = action.direction || '';
    } else if (action.type === 'wait') {
      actionId = String(action.durationMs);
    }
    
    const actionKey = `${action.type}_${actionId}`;
    const currentCount = this.actionRetryCount.get(actionKey) || 0;
    
    // Track consecutive "no action" states (thinking but not executing)
    if (action.type === 'wait' || action.thought?.includes('analyzing')) {
      this.consecutiveNoActionCount++;
    } else {
      this.consecutiveNoActionCount = 0;
    }
    
    // Check if we're repeating the same action
    if (actionKey === this.lastBroadcastAction) {
      const newCount = currentCount + 1;
      this.actionRetryCount.set(actionKey, newCount);
      
      if (newCount >= this.MAX_RETRIES_PER_ACTION) {
        return {
          isLoop: true,
          message: `⚠️ LOOP DETECTED: Same action "${action.type}" repeated ${newCount} times. `
        };
      }
    } else {
      this.actionRetryCount.set(actionKey, 1);
    }
    
    this.lastBroadcastAction = actionKey;
    
    // Check for consecutive no-action state
    if (this.consecutiveNoActionCount >= this.MAX_CONSECUTIVE_NO_ACTION) {
      return {
        isLoop: true,
        message: `⚠️ STALLED: No actions executed for ${this.consecutiveNoActionCount} consecutive iterations. `
      };
    }
    
    return { isLoop: false, message: '' };
  }
  
  // UNIVERSAL: Update and broadcast SOP progress - dynamically from parsed SOP
  private updateSopProgress(action: SingleAgentAction, broadcast?: (msg: WebSocketMessage) => void): void {
    if (!this.currentSop?.steps?.length) return;
    
    // Universal step detection based on action type and semanticTarget
    const actionType = action.type;
    // Handle semanticTarget safely
    const semanticTarget = 'semanticTarget' in action ? (action.semanticTarget || '') : '';
    const optionValue = 'option' in action ? (action.option || '') : '';
    
    // Map action types to SOP steps dynamically
    let matchedStepIndex = -1;
    
    for (let i = 0; i < this.currentSop.steps.length; i++) {
      const step = this.currentSop.steps[i];
      const stepText = step.raw.toLowerCase();
      const actionText = `${actionType} ${semanticTarget} ${optionValue}`.toLowerCase();
      
      // Check if action matches this step
      if (step.kind === 'navigate' && actionType === 'navigate') {
        matchedStepIndex = i;
        break;
      }
      if (step.kind === 'click' && actionType === 'click') {
        if (semanticTarget && stepText.includes(semanticTarget.toLowerCase())) {
          matchedStepIndex = i;
          break;
        }
      }
      if (step.kind === 'select' && (actionType === 'select_option' || actionType === 'click')) {
        if (optionValue && stepText.includes(optionValue.toLowerCase())) {
          matchedStepIndex = i;
          break;
        }
      }
      if (step.kind === 'scrape' && actionType === 'scrape_data') {
        matchedStepIndex = i;
        break;
      }
    }
    
    if (matchedStepIndex >= 0 && matchedStepIndex !== this.currentSopStep) {
      this.currentSopStep = matchedStepIndex;
      if (broadcast) {
        const stepInfo = this.currentSop.steps[matchedStepIndex];
        broadcast({
          type: 'progress',
          timestamp: new Date().toISOString(),
          message: `📍 Step ${matchedStepIndex + 1}/${this.currentSop.steps.length}: ${stepInfo.raw}`
        });
      }
    }
  }
  
  // NEW: Broadcast retry warning
  private broadcastRetryWarning(action: SingleAgentAction, retryCount: number, config: AgentConfig): void {
    if (!config.broadcast) return;
    
    config.broadcast({
      type: 'warning',
      timestamp: new Date().toISOString(),
      message: `🔄 RETRY ${retryCount}/${this.MAX_RETRIES_PER_ACTION}: Trying alternative approach for "${action.type}" action...`
    });
  }
  
  // NEW: Broadcast execution status
  private broadcastExecutionStatus(action: SingleAgentAction, success: boolean, config: AgentConfig): void {
    if (!config.broadcast) return;
    
    const status = success ? '✅' : '❌';
    const actionDesc = this.getActionDescription(action);
    config.broadcast({
      type: success ? 'action_success' : 'action_failed',
      timestamp: new Date().toISOString(),
      message: `${status} ${actionDesc}`
    });
  }
  
  private getActionDescription(action: SingleAgentAction): string {
    switch (action.type) {
      case 'click': return `Clicked: ${action.semanticTarget || action.elementId || 'element'}`;
      case 'type': return `Typed in: ${action.semanticTarget || action.elementId || 'field'}`;
      case 'select_option': return `Selected: ${action.option} from ${action.semanticTarget || 'dropdown'}`;
      case 'scrape_data': return `Scraping: ${action.instruction}`;
      case 'navigate': return `Navigated to: ${action.url}`;
      case 'wait': return `Waited: ${action.durationMs}ms`;
      case 'finish': return 'Task completed';
      default: return `Action: ${action.type}`;
    }
  }

  private recordCommand(cmd: ExecutionCommand | ExecutionCommand[]): void {
    const cmds = Array.isArray(cmd) ? cmd : [cmd];
    if (this.agentCommandBuffer) {
      this.agentCommandBuffer.push(...cmds);
    } else {
      this.sessionHistory.push(...cmds);
    }
  }

  // ... [navigate, clickExact, type, observe, handleCookieBanner - KEEP AS IS] ...
  
  // --- KEEP navigate(), clickExact(), type(), observe() from previous code ---
  async navigate(url: string): Promise<ExecutionResult> {
      try {
          await this.browser.goto(url);
          this.recordCommand({ action: 'navigate', target: url, timestampMs: Date.now(), url });
          return { success: true, message: `Mapsd to ${url}` };
      } catch (e: any) { return { success: false, message: e.message }; }
  }
  
  async clickExact(selector: string, desc?: string): Promise<ExecutionResult> {
      try {
          const info = await this.browser.click(selector);
          this.recordCommand({
            action: 'click',
            target: selector,
            description: desc,
            selectors: {
              css: info.cssSelector || selector,
              xpath: info.xpath || '',
              id: info.id || '',
              text: info.text || ''
            },
            timestampMs: Date.now(),
            url: this.browser.getPage().url(),
            elementMeta: {
              tagName: info.tagName,
              ariaLabel: info.ariaLabel,
              placeholder: info.placeholder,
              roleHint: info.roleHint,
              boundingBox: info.boundingBox
            }
          });
          return { success: true, message: `Clicked ${desc || selector}`, selectors: [info] };
      } catch (e: any) { return { success: false, message: e.message }; }
  }

  async type(selector: string, text: string): Promise<ExecutionResult> {
    try {
      await this.browser.type(selector, text);
      this.recordCommand({ action: 'type', target: selector, value: text, timestampMs: Date.now(), url: this.browser.getPage().url() });
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

    await this.browser.init();
    const page = this.browser.getPage();

    // Parse SOP early so the agent can follow the execution flow strictly.
    const parsedSop: ParsedSop = parseSopText(goal);
    this.currentSop = parsedSop;
    
    // Reset progress tracking for new session
    this.resetProgressTracking();
    
    // Broadcast SOP start
    if (config.broadcast) {
      config.broadcast({
        type: 'progress',
        timestamp: new Date().toISOString(),
        message: `🚀 Starting SOP execution: ${goal.substring(0, 100)}...`
      });
    }

    // 1. EXTRACT URL & NAVIGATE
    const urlInGoal = this.extractUrlFromPrompt(goal) || parsedSop.targetUrl;
    this.sessionHistory = []; // Reset history for clean generation
    this.processedItems.clear(); // Reset processed items for new session

    if (urlInGoal) {
        try {
            console.log(`[Agent] Initializing navigation to: ${urlInGoal}`);
            await this.navigate(urlInGoal);
            actionHistory.push(`[SUCCESS] Navigated to ${urlInGoal}`);
        } catch (e) {
            console.error("Navigation failed:", e);
        }
    }

    // Pre-parse any dropdown instructions from the goal text so we can fall back to a deterministic action
    const dropdownIntent: DropdownIntent | null = parseDropdownInstruction(goal);
    let dropdownSatisfied = false;

    let stepNumber = 0;
    let isFinished = false;

    // ... [Agent Loop - Same as before] ...
    while (stepNumber < maxSteps && !isFinished) {
      stepNumber++;

      const extractor = new SelectorExtractor(page);
      const elements = await extractor.extractAllInteractive();
      const screenshotObj = await this.browser.screenshot();
      const screenshotBase64 = screenshotObj.replace('data:image/png;base64,', '');

      // Broadcast AI thinking
      if (config.broadcast) {
        config.broadcast({
          type: 'thought',
          timestamp: new Date().toISOString(),
          message: `AI is analyzing the current page state and planning next actions...`
        });
      }

      // Plan Action
      let nextActionsBatch = await this.planNextAgentAction(
        goal,
        parsedSop,
        elements,
        actionHistory,
        failedElements,
        screenshotBase64,
        config.modelProvider
      );
      let actionsToExecute = Array.isArray(nextActionsBatch) ? nextActionsBatch : [nextActionsBatch];

      // --- DROPDOWN FAILSAFE -------------------------------------------------
      // In cases like logs-1 where the LLM wants to "finish" early because it cannot
      // see the dropdown element in the extracted list, we synthesize a deterministic
      // select_option action based purely on the textual instructions.
      if (dropdownIntent && !dropdownSatisfied) {
        const wantsToFinishOnly =
          actionsToExecute.length === 1 && actionsToExecute[0].type === 'finish';

        const hasExplicitDropdownAction = actionsToExecute.some(a =>
          a.type === 'select_option' ||
          (a.type === 'click' && a.semanticTarget && /drop\s*down/i.test(a.semanticTarget)) ||
          (a.type === 'type' && a.semanticTarget && /drop\s*down/i.test(a.semanticTarget))
        );

        if (wantsToFinishOnly && !hasExplicitDropdownAction) {
          const optionLabel = dropdownIntent.optionLabel;
          const dropdownLabel = dropdownIntent.kind === 'open-and-select'
            ? dropdownIntent.dropdownLabel
            : undefined;

          actionsToExecute = [{
            type: 'select_option',
            semanticTarget: dropdownLabel,
            option: optionLabel,
            thought: `Selecting dropdown option "${optionLabel}" based on goal instructions before finishing.`
          }];
        }
      }

      // Broadcast the AI's thoughts
      if (config.broadcast) {
        const thoughts = actionsToExecute.map(a => a.thought || 'No thought provided').join('; ');
        config.broadcast({
          type: 'thought',
          timestamp: new Date().toISOString(),
          message: `AI thought: ${thoughts}`
        });
      }
      
      // Execute Batch - SEQUENTIAL with proper waits like a human
      // CRITICAL: When clicking dropdown triggers, execute ONLY ONE action then re-analyze
      this.agentCommandBuffer = [];
      let batchSuccess = true;
      let dropdownJustOpened: { name: string; action: SingleAgentAction } | null = null;
      
      for (let actionIdx = 0; actionIdx < actionsToExecute.length; actionIdx++) {
        const action = actionsToExecute[actionIdx];
        
        if (!batchSuccess) break;
        if (this.isActionRedundant(action, this.sessionHistory.concat(this.agentCommandBuffer))) continue;

        // Update SOP progress + loop detection only for actions we're actually executing
        this.updateSopProgress(action, config.broadcast);
        const loopCheck = this.checkForLoop(action, config);
        if (loopCheck.isLoop && config.broadcast) {
          config.broadcast({
            type: 'warning',
            timestamp: new Date().toISOString(),
            message: loopCheck.message
          });
        }

        try {
            const res = await this.executeAgentAction(action, elements);
            
            // Track if we just opened a dropdown - detect by semanticTarget containing common dropdown words
            if (action.type === 'click' && action.semanticTarget) {
              const target = action.semanticTarget.toLowerCase();
              const isDropdownTrigger = /dropdown|select|filter|sort/i.test(target);
              
              if (isDropdownTrigger) {
                dropdownJustOpened = { name: action.semanticTarget, action };
                // After clicking dropdown, BREAK - must re-analyze to find options!
                if (!res.success) {
                  batchSuccess = false;
                  if (res.failedSelector) failedElements.add(res.failedSelector);
                }
                break;
              }
            }
            
            if (!res.success) {
                batchSuccess = false;
                if (res.failedSelector) failedElements.add(res.failedSelector);
            }
        } catch { batchSuccess = false; }
      }
      
      // UNIVERSAL FALLBACK: If we just opened a dropdown, wait for options to appear before continuing
      if (dropdownJustOpened && batchSuccess) {
        // Wait specifically for dropdown options to be visible
        try {
          await page.waitForFunction(() => {
            const options = Array.from(document.querySelectorAll('[role="option"], [role="menuitem"], .dropdown-item, .MuiMenuItem-root, .ant-select-item-option-content, li:has(a), a, button, span, div'));
            for (const option of options) {
              const style = window.getComputedStyle(option);
              const htmlElement = option as HTMLElement;
              if (style.display !== 'none' && style.visibility !== 'hidden' && htmlElement.offsetWidth > 0 && htmlElement.offsetHeight > 0) {
                const text = (option.textContent || '').trim();
                if (text.length > 0 && text.length < 100) {
                  return true;
                }
              }
            }
            return false;
          }, { timeout: 3000 });
        } catch {
          // Options didn't appear, continue anyway
        }

        // Just broadcast that dropdown was opened so user knows what's happening
        if (config.broadcast) {
          config.broadcast({
            type: 'action_taken',
            timestamp: new Date().toISOString(),
            message: `📂 Opened dropdown: ${dropdownJustOpened.name} - waiting for options to appear...`
          });
        }
      }

      if (batchSuccess && this.agentCommandBuffer.length > 0) {
          this.sessionHistory.push(...this.agentCommandBuffer);
          actionHistory.push(`[SUCCESS] Executed steps`);
          this.agentCommandBuffer = [];

          // If we just recorded a command that selected the desired dropdown option,
          // mark the dropdown intent as satisfied so we do not keep forcing it.
          if (dropdownIntent && !dropdownSatisfied) {
            const opt = dropdownIntent.optionLabel.toLowerCase();
            dropdownSatisfied = this.sessionHistory.some(cmd =>
              (cmd.description && cmd.description.toLowerCase().includes(opt)) ||
              (cmd.selectors?.text && cmd.selectors.text.toLowerCase().includes(opt))
            );
          }

          // Broadcast actions taken
          if (config.broadcast) {
            const actionDescriptions = actionsToExecute.map(a => {
              switch (a.type) {
                case 'click': return `Clicked ${a.elementId || a.semanticTarget || 'element'}`;
                case 'type': return `Typed "${a.text}" into ${a.elementId || a.semanticTarget || 'element'}`;
                case 'navigate': return `Navigated to ${a.url}`;
                case 'select_option': return `Selected "${a.option}" from ${a.elementId || a.semanticTarget || 'dropdown'}`;
                case 'scrape_data': return `Scraped data: ${a.instruction}`;
                case 'scroll': return `Scrolled ${a.direction} on ${a.elementId || 'page'}`;
                case 'wait': return `Waited ${a.durationMs}ms`;
                case 'finish': return 'Completed task';
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
      if (batchSuccess && !isFinished) await this.browser.waitForStability(1500); 
    }

    // --- CRITICAL: INTELLIGENT GENERATION ---
    // We pass the raw history to the LLM so it can detect patterns (loops) that a deduplicator might hide.
    const seleniumCode = await this.seleniumGenerator.generateSmartAutomationCode(goal, this.sessionHistory, config.modelProvider);

    return {
        success: isFinished,
        summary: isFinished ? 'Goal Completed' : 'Stopped',
        goal,
        totalSteps: stepNumber,
        steps,
        commands: this.sessionHistory,
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

          sop: ParsedSop,

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

  

                    name: el.attributes['name'],




                    checked: el.checked

  

                }));

  

        

  

                const processedItemsList = Array.from(this.processedItems).join(', ');

                const prompt = `
            SYSTEM: You are an expert RPA Agent that behaves exactly like a human interacting with a browser.
            You MUST follow the SOP steps in order. Do not skip steps. Do not repeat steps that should happen once.

            GOAL (raw SOP text): "${goal}"

            SOP (structured): ${JSON.stringify(sop.steps)}

            HISTORY: ${history.slice(-8).join('; ')}

            PROCESSED ITEMS: ${processedItemsList || 'None'}

            UI ELEMENTS:
            ${JSON.stringify(simplified)}

            CRITICAL DROPDOWN INSTRUCTIONS:
            When a SOP step says "Click the [dropdown name] dropdown and select [option]", you MUST use ONE action:
            
            - Use type: "select_option"
              - semanticTarget: the dropdown name (label)
              - option: the option text to select
              - The engine will perform: click dropdown → type the option text (typeahead) → press Enter.
              - This avoids loops when dropdown values are inside a single container (native <select> / listbox).
            
            Example format for dropdown selection:
            [
              { "type": "select_option", "semanticTarget": "[dropdown name]", "option": "[option to select]", "thought": "Select dropdown option via type + Enter" }
            ]

            IMPORTANT: Do NOT batch multiple dropdown operations together. Process ONE dropdown at a time.

            INSTRUCTIONS:
            1. Analyze the UI to find the next logical step(s) required by the SOP. Avoid repeating actions on already processed items.
            2. When the SOP requires scraping/extracting data, you MUST return a { "type": "scrape_data", "instruction": "..." } action before finishing.

            3. **For hierarchical navigation paths in the GOAL (indicated by arrows like "A -> B -> C"),
               treat each level as a distinct target. Once you have navigated to an intermediate level,
               focus on reaching the final destination without unnecessarily backtracking to earlier levels.**



            3. **BATCHING**: For dropdowns, NEVER batch - do ONE dropdown at a time.



            4. **DISTINCTION**: Look at 'label', 'placeholder', and 'type' to distinguish Username vs Password.



               - Username usually has type='text'
  - Password usually has type='password'




5. **CHECKBOXES**: For checkboxes (type='checkbox'), check the 'checked' field. Only click to uncheck if 'checked' is true. Do not click if already unchecked.





6. **STATE AWARENESS**: Do not click on or interact with items that are listed in PROCESSED ITEMS. If all relevant items on the page have been processed, navigate back or finish the task.





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

      const dummyGoal = 'Automate the actions performed in the recorded trace efficiently.';
      const seleniumCode = await this.seleniumGenerator.generateSmartAutomationCode(
        dummyGoal,
        commandsToUse,
        'gemini'
      );

      return { success: true, message: 'Selenium code generated', seleniumCode };
    } catch (e: any) {
      return { success: false, message: e.message };
    }
  }

    // --- EXECUTE ACTION WITH ROBUST RECORDING ---

      private async executeAgentAction(action: SingleAgentAction, elements: ElementInfo[]): Promise<ExecutionResult> {
    const page = this.browser.getPage();

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

            // Mark item as processed for state awareness
            const itemIdentifier = action.semanticTarget || targetElement?.text || info?.text || robustSelector;
            if (itemIdentifier) {
                this.processedItems.add(itemIdentifier);
            }

            this.recordCommand({
                action: 'click',
                target: robustSelector,
                selectors: selectorsForSelenium,
                description: `Click ${action.semanticTarget || targetElement?.text || 'element'}`,
                timestampMs: Date.now(),
                url: page.url(),
                elementMeta: targetElement ? {
                  tagName: targetElement.tagName,
                  ariaLabel: targetElement.ariaLabel,
                  placeholder: targetElement.placeholder,
                  roleHint: targetElement.roleHint,
                  boundingBox: targetElement.boundingBox
                } : undefined
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
                description: `Type "${action.text}" into ${action.semanticTarget || 'field'}`,
                timestampMs: Date.now(),
                url: page.url(),
                elementMeta: targetElement ? {
                  tagName: targetElement.tagName,
                  ariaLabel: targetElement.ariaLabel,
                  placeholder: targetElement.placeholder,
                  roleHint: targetElement.roleHint,
                  boundingBox: targetElement.boundingBox
                } : undefined
            });
            result = { success: true, message: `Filled "${action.text}"` };
        }

        // NEW: SELECT_OPTION (dropdown intelligence)
        else if (action.type === 'select_option') {
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

            // Mark item as processed for state awareness
            if (dropdownLabel || optionLabel) {
                this.processedItems.add(`dropdown:${dropdownLabel}|option:${optionLabel}`);
            }

            // Prefer recording the CONTROL selector (so Selenium can reproduce "click + type + Enter").
            const controlCss = selection.controlSelector || robustSelector || selectorsForSelenium.css || '';
            const controlSelectors = {
                css: controlCss || selectorsForSelenium.css,
                xpath: selectorsForSelenium.xpath,
                id: selectorsForSelenium.id,
                text: dropdownLabel || selectorsForSelenium.text
            };

            // If the selection happened via keyboard/typeahead (common for native <select>),
            // record it as: click dropdown -> type option -> press Enter.
            if (selection.method === 'keyboard') {
                if (dropdownLabel || controlCss) {
                    this.recordCommand({
                        action: 'click',
                        target: controlCss || dropdownLabel,
                        selectors: controlSelectors,
                        description: `Open dropdown ${dropdownLabel ? `"${dropdownLabel}"` : ''}`.trim(),
                        timestampMs: Date.now(),
                        url: page.url()
                    });
                }

                this.recordCommand({
                    action: 'type',
                    target: controlCss || dropdownLabel,
                    value: optionLabel,
                    selectors: controlSelectors,
                    description: `Type "${optionLabel}" and press Enter${dropdownLabel ? ` in "${dropdownLabel}" dropdown` : ''}`,
                    timestampMs: Date.now(),
                    url: page.url(),
                    data: {
                        kind: 'dropdown_select',
                        dropdownLabel,
                        optionLabel,
                        typedQuery: selection.typedQuery,
                        pressEnter: true
                    }
                });
            } else {
                // Fallback: clicked an explicit option element (non-typeahead dropdowns)
                const optionCss = selection.optionSelector;
                const finalSelectors = optionCss && optionCss.trim().length > 0
                    ? { css: optionCss, xpath: '', id: '', text: optionLabel }
                    : { css: '', xpath: `//*[contains(text(), '${optionLabel}')]`, id: '', text: optionLabel };

                const targetName = (optionCss && optionCss.length > 0) ? optionCss : optionLabel;

                this.recordCommand({
                    action: 'click',
                    target: targetName,
                    selectors: finalSelectors,
                    description: `Select option "${optionLabel}"${dropdownLabel ? ` from "${dropdownLabel}" dropdown` : ''}`,
                    timestampMs: Date.now(),
                    url: page.url()
                });
            }

            result = {
                success: true,
                message: `Selected option "${optionLabel}"`,
            };
        }

        // SCRAPE_DATA (records a scrape spec for downstream Selenium codegen)
        else if (action.type === 'scrape_data') {
              const instruction = action.instruction;
              const fieldsFromSop = this.currentSop?.scrapeFields ?? [];

              const scrapeSpec = await page.evaluate(
                ({ instr, fields }: { instr: string; fields: string[] }) => {
                  const escapeCss = (s: string): string => {
                    try { return CSS.escape(String(s)); } catch { return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }
                  };

                  const isVisible = (el: Element): boolean => {
                    const rect = (el as HTMLElement).getBoundingClientRect?.();
                    if (!rect) return true;
                    if (rect.width <= 0 || rect.height <= 0) return false;
                    const style = window.getComputedStyle(el as any);
                    if (style && (style.visibility === 'hidden' || style.display === 'none')) return false;
                    return true;
                  };

                  const cssPathWithin = (root: Element, el: Element): string | null => {
                    // If there's an ID anywhere in the chain, prefer it.
                    if ((el as any).id) return `#${escapeCss((el as any).id)}`;

                    const parts: string[] = [];
                    let cur: Element | null = el;
                    let safety = 0;

                    while (cur && cur !== root && safety++ < 12) {
                      const tag = cur.tagName.toLowerCase();
                      const id = (cur as any).id as string | undefined;
                      if (id) {
                        parts.unshift(`#${escapeCss(id)}`);
                        break;
                      }

                      const clsRaw = (cur.getAttribute('class') || '').trim();
                      const cls = clsRaw.split(/\s+/).filter(Boolean).slice(0, 2);
                      let seg = tag;
                      if (cls.length) seg += `.${cls.map(escapeCss).join('.')}`;

                      // Disambiguate among same-tag siblings
                      const parent = cur.parentElement;
                      if (parent) {
                        const same = Array.from(parent.children).filter(c => (c as Element).tagName.toLowerCase() === tag);
                        if (same.length > 1) {
                          const idx = same.indexOf(cur) + 1;
                          seg += `:nth-of-type(${idx})`;
                        }
                      }

                      parts.unshift(seg);
                      cur = cur.parentElement;
                    }

                    if (!parts.length) return null;
                    return parts.join(' > ');
                  };

                  // UNIVERSAL: Find the actual content container (not header/nav/footer)
                  // Try to find a main content area, or fall back to body
                  const root =
                    document.querySelector('main') ||
                    document.querySelector('[role="main"]') ||
                    document.querySelector('.content, .main-content, .container, .results, .listing') ||
                    document.body;

                  const rootSelector = (root as any).id
                    ? `#${escapeCss((root as any).id)}`
                    : cssPathWithin(document.body, root) || null;

                  // 1) UNIVERSAL: Identify item selector dynamically
                  // Find elements that appear multiple times (likely list items)
                  let itemSelector: string | null = null;
                  
                  // Get all potential container elements
                  const containerTags = ['article', 'li', 'div', 'section'];
                  for (const tag of containerTags) {
                    const candidates = Array.from(root.querySelectorAll(tag))
                      .filter(el => isVisible(el))
                      .filter(el => {
                        // Must have substantial text content
                        const txt = (el.textContent || '').trim();
                        return txt.length > 50;
                      });
                    
                    // Group by class to find common patterns
                    const classGroups = new Map<string, Element[]>();
                    for (const el of candidates) {
                      const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean)[0];
                      if (!cls) continue;
                      const arr = classGroups.get(cls) || [];
                      arr.push(el);
                      classGroups.set(cls, arr);
                    }
                    
                    // Find class with 3+ items (likely our list items)
                    for (const [cls, els] of classGroups) {
                      if (els.length >= 3) {
                        itemSelector = `${tag}.${escapeCss(cls)}`;
                        break;
                      }
                    }
                    
                    if (itemSelector) break;
                  }

                  // 2) Heuristic fallback if we didn't match known patterns
                  if (!itemSelector) {
                    const candidates = Array.from(root.querySelectorAll('article, li, div'))
                      .filter((el) => {
                        if (!isVisible(el)) return false;
                        const cls = (el.getAttribute('class') || '').trim();
                        const txt = (el.textContent || '').trim();
                        if (!cls) return false;
                        if (txt.length < 60) return false;
                        // try to ensure we are in the directory body (avoid header/footer)
                        const nearNav = el.closest('header, nav, footer');
                        if (nearNav) return false;

                        // if we have expected fields, require at least one keyword hint
                        if (Array.isArray(fields) && fields.length) {
                          const lower = txt.toLowerCase();
                          const hits = fields
                            .map(f => String(f).toLowerCase())
                            .filter(f => f.length >= 3)
                            .filter(f => lower.includes(f)).length;
                          if (hits === 0) {
                            // still allow, but require some address-like shape
                            if (!/\b\d{5}(?:-\d{4})?\b/.test(txt) && !/\b[A-Z]{2}\b/.test(txt)) return false;
                          }
                        }

                        return true;
                      })
                      .slice(0, 2500);

                    const groups = new Map<string, Element[]>();
                    for (const el of candidates) {
                      const tag = el.tagName.toLowerCase();
                      const firstClass = (el.className || '').toString().trim().split(/\s+/)[0];
                      if (!firstClass) continue;
                      const k = `${tag}|${firstClass}`;
                      const arr = groups.get(k) || [];
                      arr.push(el);
                      groups.set(k, arr);
                    }

                    let bestKey: string | null = null;
                    let bestScore = -1;
                    for (const [k, arr] of groups.entries()) {
                      const n = arr.length;
                      if (n < 3 || n > 300) continue;
                      const avgLen = arr.slice(0, 10).reduce((sum: number, e: Element) => sum + ((e.textContent || '').trim().length), 0) / Math.min(arr.length, 10);
                      const score = n * Math.min(avgLen, 250);
                      if (score > bestScore) {
                        bestScore = score;
                        bestKey = k;
                      }
                    }

                    if (bestKey) {
                      const [tag, firstClass] = bestKey.split('|');
                      itemSelector = `${tag}.${escapeCss(firstClass)}`;
                    }
                  }

                  const firstItem = itemSelector ? root.querySelector(itemSelector) : null;

                  // 3) Capture pagination controls (real selectors)
                  const paginationCandidates = [
                    '[rel="next"]',
                    'a.next',
                    'a.page-numbers.next',
                    '.pagination a.next',
                    'a:has-text("Next")',
                  ];

                  const findNextEl = (): Element | null => {
                    // Prefer rel=next / class=next
                    const direct = root.querySelector('[rel="next"], a.next, a.page-numbers.next, .pagination a.next');
                    if (direct && isVisible(direct)) return direct;

                    // Text-based fallback (unicode arrows included)
                    const links = Array.from(root.querySelectorAll('a, button')).filter(isVisible);
                    const nextText = ['next', '›', '»', '→'];
                    for (const el of links) {
                      const t = (el.textContent || '').trim().toLowerCase();
                      if (nextText.some(x => t === x || t.includes(x))) return el;
                      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
                      if (aria.includes('next')) return el;
                    }
                    return null;
                  };

                  const findLoadMoreEl = (): Element | null => {
                    const btns = Array.from(root.querySelectorAll('button, a')).filter(isVisible);
                    for (const el of btns) {
                      const t = (el.textContent || '').trim().toLowerCase();
                      if (t.includes('load more') || t.includes('show more') || t === 'more') return el;
                      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
                      if (aria.includes('load more') || aria.includes('show more')) return el;
                    }
                    return null;
                  };

                  const nextEl = findNextEl();
                  const loadMoreEl = findLoadMoreEl();

                  const pagination = {
                    nextSelector: nextEl ? (cssPathWithin(root, nextEl) || cssPathWithin(document.body, nextEl)) : null,
                    loadMoreSelector: loadMoreEl ? (cssPathWithin(root, loadMoreEl) || cssPathWithin(document.body, loadMoreEl)) : null,
                  };

                  // 4) Field selectors within item - FULLY DYNAMIC based on actual content analysis
                  // The system analyzes element text content to determine what field it represents
                  const inferred: Record<string, string | null> = {};
                  if (firstItem && fields && fields.length > 0) {
                    // Get all potential text/link elements from the item
                    const allElements = Array.from(firstItem.querySelectorAll('h1, h2, h3, h4, h5, h6, p, span, li, div, a[href], strong, em'));
                    
                    for (const field of fields) {
                      const fieldLower = String(field).toLowerCase();
                      let bestSelector: string | null = null;
                      let bestScore = 0;
                      
                      // Analyze each element to see if it matches the field based on content patterns
                      for (const el of allElements) {
                        if (!isVisible(el)) continue;
                        
                        const text = (el.textContent || '').trim();
                        if (!text || text.length < 2) continue;
                        
                        let score = 0;
                        
                        // DYNAMIC: Score element based on content analysis
                        // Check if text content matches field name or contains field-related keywords
                        if (fieldLower.includes('name') || fieldLower.includes('business') || fieldLower.includes('company')) {
                          // Look for heading elements or links with substantial text (likely names)
                          const isHeading = /^h[1-6]$/i.test(el.tagName);
                          const isLink = el.tagName.toLowerCase() === 'a';
                          if (isHeading || isLink) {
                            score = text.length > 3 ? 10 : 0;
                          }
                        }
                        
                        if (fieldLower.includes('address') || fieldLower.includes('city') || fieldLower.includes('state') || fieldLower.includes('zip') || fieldLower.includes('location')) {
                          // Look for patterns: ZIP codes, state abbreviations, address keywords
                          const hasZip = /\b\d{5}(?:-\d{4})?\b/.test(text);
                          const hasState = /\b[A-Z]{2}\b/.test(text);
                          const hasAddressKeyword = /\b(?:address|street|ave|rd|drive|ln|blvd)\b/i.test(text);
                          if (hasZip || hasState || hasAddressKeyword) {
                            score = 20;
                          }
                        }
                        
                        if (fieldLower.includes('website') || fieldLower.includes('url') || fieldLower.includes('link')) {
                          // Look for anchor tags with href
                          if (el.tagName.toLowerCase() === 'a') {
                            const href = (el as HTMLAnchorElement).href || '';
                            if (href.startsWith('http')) {
                              score = 15;
                            }
                          }
                        }
                        
                        // Select best match
                        if (score > bestScore) {
                          bestScore = score;
                          bestSelector = cssPathWithin(firstItem, el);
                        }
                      }
                      
                      // Store if we found a match with reasonable confidence
                      if (bestScore > 0) {
                        const fieldKey = String(field).replace(/\s+/g, '');
                        inferred[fieldKey + 'Selector'] = bestSelector;
                      }
                    }
                  }

                  const rootText = ((root as any).innerText || root.textContent || '').toString();
                  const sampleText = firstItem
                    ? (firstItem.textContent || '').trim().slice(0, 1500)
                    : rootText.slice(0, 2000);

                  return {
                    instruction: instr,
                    fields,
                    rootSelector,
                    itemSelector,
                    pagination,
                    inferred,
                    sampleText,
                    itemCountOnFirstView: itemSelector ? root.querySelectorAll(itemSelector).length : 0,
                  };
                },
                { instr: instruction, fields: fieldsFromSop }
              );

              this.recordCommand({
                action: 'scrape_data',
                description: `Scrape data: ${instruction}`,
                timestampMs: Date.now(),
                url: page.url(),
                data: scrapeSpec
              });

              result = { success: true, message: 'Captured scrape specification for code generation', data: scrapeSpec };
        }

        // WAIT
        else if (action.type === 'wait') {
               await new Promise(r => setTimeout(r, action.durationMs));
               this.recordCommand({ action: 'wait', waitTime: action.durationMs / 1000, timestampMs: Date.now(), url: page.url() });
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
          }
      }
      return false;
  }
  
}
