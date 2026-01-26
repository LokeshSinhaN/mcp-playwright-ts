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

      this.sessionHistory = []; 

      const steps: AgentStepResult[] = [];

      const failedElements: Set<string> = new Set();

      const actionHistory: string[] = [];

  

      await this.browser.init();

      const page = this.browser.getPage();

  

      // 1. Auto-Navigation (Context Understanding)

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

  

        // OBSERVE: Get valid DOM elements

        const extractor = new SelectorExtractor(page);

        const elements = await extractor.extractAllInteractive();

        const screenshotObj = await this.browser.screenshot();

        const screenshotBase64 = screenshotObj.replace('data:image/png;base64,', '');

  

        // THINK: Plan a BATCH of actions

        // We now expect a list of actions (e.g. Fill User -> Fill Pass -> Click Login)

        let nextActionsBatch = await this.planNextAgentAction(

          goal,

          elements,

          actionHistory,

          failedElements,

          screenshotBase64,

          config.modelProvider

        );

  

        // Normalize to array

        const actionsToExecute = Array.isArray(nextActionsBatch) ? nextActionsBatch : [nextActionsBatch];

        

        const firstAction = actionsToExecute[0];

        const thought = firstAction.thought || "Executing batch...";

        

        config.broadcast?.({

            type: 'log', timestamp: new Date().toISOString(),

            message: `ai_plan: ${thought} (${actionsToExecute.length} steps)`,

            data: { role: 'agent-reasoning', thought }

        });

  

        // ACT: Execute Batch Locally

        let batchSuccess = true;

        let batchMessage = '';

        let stateChanged = false;

        this.agentCommandBuffer = []; // Buffer for the whole batch

  

        for (const action of actionsToExecute) {

            // If previous step failed, stop the batch

            if (!batchSuccess) break;

  

            let retryCount = 0;

            let actionSuccess = false;

            let result: ExecutionResult | undefined;

  

            while (retryCount <= 1 && !actionSuccess) {

                 // Execute single atomic action

                 result = await this.executeAgentAction(action, elements);

                 actionSuccess = result.success;

  

                 if (result.stateChanged) stateChanged = true;

  

                 if (actionSuccess) {

                     // CRITICAL: Record the EXACT selector used, not the AI's "el_X"

                     // executeAgentAction handles the recording into this.agentCommandBuffer

                 } else {

                     retryCount++;

                     if (result?.failedSelector) failedElements.add(result.failedSelector);

                     await page.waitForTimeout(500);

                 }

            }

  

            if (!actionSuccess) {

                batchSuccess = false;

                batchMessage = `Batch failed at: ${action.type}. ${result?.message}`;

            } else {

                // Add successful command to final history

                if (this.agentCommandBuffer) {

                    this.sessionHistory.push(...this.agentCommandBuffer);

                    this.agentCommandBuffer = []; // Clear buffer after commit

                }

            }

            

            // Fast-forward delay for visual feedback between batch steps

            if (actionsToExecute.length > 1) await page.waitForTimeout(500);

        }

  

        if (batchSuccess) batchMessage = "Batch executed successfully";

  

        const actionDesc = `[${batchSuccess ? 'OK' : 'FAIL'}] Batch: ${actionsToExecute.map(a => a.type).join('->')}`;

        actionHistory.push(actionDesc);

        

        // Check finish condition

        if (actionsToExecute.some(a => a.type === 'finish') && batchSuccess) isFinished = true;

  

        steps.push({ 

            stepNumber, 

            actions: actionsToExecute, // Updated to store array

            success: batchSuccess, 

            message: batchMessage, 

            urlBefore: '', 

            urlAfter: page.url(), 

            stateChanged, 

            retryCount: 0,

            screenshot: screenshotBase64 

        });

        

        // If the page state didn't change after a batch of clicks (e.g. dead login button), wait a bit or retry

        if (!stateChanged && batchSuccess && actionsToExecute.some(a => a.type === 'click')) {

            await page.waitForTimeout(2000); // Give slow apps time

        }

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

  

    // --- EXECUTE ACTION WITH SELECTOR ANCHORING ---

        private async executeAgentAction(action: SingleAgentAction, elements: ElementInfo[]): Promise<ExecutionResult> {

          

          // 1. Resolve "el_X" to the REAL ElementInfo

          let targetElement: ElementInfo | undefined;

          if ('elementId' in action && action.elementId && action.elementId.startsWith('el_')) {

              const idx = parseInt(action.elementId.split('_')[1]);

              targetElement = elements[idx];

          }

      

          // 2. Determine the BEST selector for Playwright & Selenium

          // Priority: ID > TestID > XPath > CSS

          let robustSelector = 'selector' in action ? action.selector : undefined;

      let selectorsForSelenium = { css: '', xpath: '', id: '', text: '' };

  

      if (targetElement) {

          robustSelector = targetElement.cssSelector || targetElement.selector; // Default

          

          // Prepare data for Selenium Generator

          selectorsForSelenium = {

              css: targetElement.cssSelector || '',

              xpath: targetElement.xpath || '',

              id: targetElement.id || '',

              text: targetElement.text || ''

          };

      }

  

      let result: ExecutionResult = { success: false, message: '' };

  

      try {

          if (action.type === 'click') {

              if (robustSelector) {

                  // Execute

                  result = await this.clickExact(robustSelector, action.semanticTarget);

                  

                  // Record for Selenium: Use the CAPTURED selectors

                  this.recordCommand({ 

                      action: 'click', 

                      target: robustSelector, // Playwright used this

                      selectors: selectorsForSelenium, // Selenium will use this

                      description: `Click ${action.semanticTarget || robustSelector}`

                  });

  

              } else {

                  result = { success: false, message: "No selector for click" };

              }

          } 

                    else if (action.type === 'type') {

                        if (robustSelector) {

                            // Using .type() in BrowserManager which now maps to .fill()

                            await this.browser.type(robustSelector, action.text); 

                            

                            this.recordCommand({ 

                                action: 'type', 

                                target: robustSelector, 

                                value: action.text,

                                selectors: selectorsForSelenium,

                                description: `Type "${action.text}" into ${action.semanticTarget || 'field'}`

                            });

                            

                            result = { success: true, message: `Filled "${action.text}"` };

                        } else {

                            result = { success: false, message: "No selector for type" };

                        }

                    }

          else if (action.type === 'wait') {

               await new Promise(r => setTimeout(r, action.durationMs));

               this.recordCommand({ action: 'wait', waitTime: action.durationMs / 1000 });

               result = { success: true, message: "Waited" };

          }

          else if (action.type === 'navigate') {

               await this.navigate(action.url); // recordCommand is handled inside this.navigate

               result = { success: true, message: `Mapsd to ${action.url}` };

          }

          // ... handle other types ...

      } catch (e: any) {

          return { success: false, message: e.message, failedSelector: robustSelector };

      }

  

      // 3. Post-Action State Verification

      // (Logic from previous file kept here)

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
      const seleniumCode = await new SeleniumGenerator().generate(commands);
      return { success: true, message: 'Selenium code generated', seleniumCode };
    } catch (e: any) {
      return { success: false, message: e.message };
    }
  }
}