//
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
import { selectFromDropdown, selectOptionInOpenDropdown, parseDropdownInstruction, DropdownIntent } from './dropdownUtils';

interface AgentContext {
  consecutiveFailures: number;
}

export class McpTools {
  private sessionHistory: ExecutionCommand[] = [];
  private agentCommandBuffer: ExecutionCommand[] | null = null;
  private agentContext: AgentContext | null = null;

  private recordCommand(cmd: ExecutionCommand | ExecutionCommand[]): void {
    const cmds = Array.isArray(cmd) ? cmd : [cmd];
    if (this.agentCommandBuffer) {
      this.agentCommandBuffer.push(...cmds);
    } else {
      this.sessionHistory.push(...cmds);
    }
  }

  private updateAgentContext(update: Partial<AgentContext>): void {
    if (this.agentContext) {
      this.agentContext = { ...this.agentContext, ...update };
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

  async navigate(url: string): Promise<ExecutionResult> {
    await this.browser.init();
    await this.browser.goto(url);
    this.recordCommand({ action: 'navigate', target: url, description: url });
    await this.browser.handleCookieBanner();
    const screenshot = await this.browser.screenshot();
    return { success: true, message: `Mapsd to ${url}`, screenshot };
  }

  async click(target: string): Promise<ExecutionResult> {
    const dropdownIntent: DropdownIntent | null = parseDropdownInstruction(target);
    if (dropdownIntent) {
      try {
        await this.browser.init();
        const page = this.browser.getPage();
        let message: string;

        if (dropdownIntent.kind === 'open-and-select') {
          const selectionResult = await selectFromDropdown(page, dropdownIntent.dropdownLabel, dropdownIntent.optionLabel);
          this.recordCommand([
            {
              action: 'click',
              target: dropdownIntent.dropdownLabel,
              selectors: { text: dropdownIntent.dropdownLabel },
              description: `Open dropdown "${dropdownIntent.dropdownLabel}"`, 
            },
            {
              action: 'click',
              target: selectionResult.optionSelector || dropdownIntent.optionLabel,
              selectors: selectionResult.optionSelector
                ? { css: selectionResult.optionSelector, xpath: selectionResult.optionXpath, text: dropdownIntent.optionLabel } 
                : { text: dropdownIntent.optionLabel },
              description: `Select option "${dropdownIntent.optionLabel}" from dropdown "${dropdownIntent.dropdownLabel}"`, 
            },
          ]);
          message = `Selected option "${dropdownIntent.optionLabel}" from dropdown "${dropdownIntent.dropdownLabel}"`;
        } else {
          const selectionResult = await selectOptionInOpenDropdown(page, dropdownIntent.optionLabel);
          this.recordCommand({
            action: 'click',
            target: selectionResult.optionSelector || dropdownIntent.optionLabel,
            selectors: selectionResult.optionSelector
              ? { css: selectionResult.optionSelector, xpath: selectionResult.optionXpath, text: dropdownIntent.optionLabel } 
              : { text: dropdownIntent.optionLabel },
            description: `Select option "${dropdownIntent.optionLabel}" from the currently open dropdown`, 
          });
          message = `Selected option "${dropdownIntent.optionLabel}" from the currently open dropdown`;
        }
        const screenshot = await this.browser.screenshot();
        return { success: true, message, screenshot };
      } catch (err) {
        console.warn('Dropdown selection helper failed, falling back to standard click():', err);
      }
    }

    if (this.model) {
      try {
        await this.browser.init();
        const page = this.browser.getPage();
        const extractor = new SelectorExtractor(page);
        const all = await extractor.extractAllInteractive();
        const visible = all.filter((el) => el.visible !== false && el.isVisible !== false);
        const pool = visible.length > 0 ? visible : all;

        if (pool.length === 0) {
          const screenshot = await this.browser.screenshot().catch(() => undefined as any);
          return { success: false, message: 'No interactive elements found.', error: 'No interactive elements', screenshot };
        }

        const chosenIndex = await this.identifyTargetWithLLM(target, this.extractCoreLabel(target), pool);

        if (typeof chosenIndex === 'number' && chosenIndex >= 0 && chosenIndex < pool.length) {
          const chosen = pool[chosenIndex];
          const selectorToClick = chosen.selector || chosen.cssSelector || chosen.xpath;
          if (!selectorToClick) return this.clickWithHeuristics(target);

          const info = await this.browser.click(selectorToClick);
          const robustSelector = info.selector || info.cssSelector || info.xpath || selectorToClick;
          this.recordCommand({
            action: 'click',
            target: robustSelector,
            selectors: { css: info.cssSelector ?? info.selector, xpath: info.xpath, id: info.id, text: info.text },
            description: target,
          });
          await page.waitForTimeout(1000);
          const screenshot = await this.browser.screenshot();
          return { success: true, message: `Clicked ${info.roleHint || 'element'} "${info.text || target}"`, selectors: [info], screenshot, candidates: pool };
        }
        return this.clickWithHeuristics(target);
      } catch (err) {
        return this.clickWithHeuristics(target);
      }
    }
    return this.clickWithHeuristics(target);
  }

  async clickExact(selector: string, labelForHistory?: string): Promise<ExecutionResult> {
    await this.browser.init();
    const extractor = new SelectorExtractor(this.browser.getPage());
    try {
      const info = await this.browser.click(selector);
      const robustSelector = info.selector || info.cssSelector || info.xpath || selector;
      this.recordCommand({
        action: 'click',
        target: robustSelector,
        selectors: { css: info.cssSelector ?? info.selector, xpath: info.xpath, id: info.id, text: info.text },
        description: labelForHistory || selector,
      });
      const screenshot = await this.browser.screenshot();
      return { success: true, message: `Clicked ${info.roleHint || 'element'} "${info.text || labelForHistory || selector}"`, selectors: [info], screenshot };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const screenshot = await this.browser.screenshot().catch(() => undefined as any);
      let selectors;
      try { selectors = await extractor.extractAllInteractive(); } catch { selectors = undefined; }
      return { success: false, message: msg, error: msg, screenshot, selectors };
    }
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new Error(`${label} timed out after ${ms}ms`)); }, ms);
    });
    try { return await Promise.race([promise, timeout]); } finally { if (timer) clearTimeout(timer); }
  }

  private sanitizeElementsForLLM(elements: ElementInfo[]): any[] {
    return elements.map((el, idx) => ({
      id: `el_${idx}`,
      tag: el.tagName,
      text: (el.text ?? '').slice(0, 50).trim(), // Truncate to save tokens
      label: (el.ariaLabel ?? '').slice(0, 50).trim(),
      role: el.roleHint,
      scrollable: el.scrollable ? true : undefined
    }));
  }

  private extractCoreLabel(prompt: string): string {
    const raw = (prompt || '').trim();
    if (!raw) return '';
    const quoted = raw.match(/["\'“”‘’]([^"\'“”‘’]{2,})["\'“”‘’]/);
    if (quoted && quoted[1].trim().length >= 3) return quoted[1].trim();
    let core = raw;
    const lower = core.toLowerCase();
    const verbPrefixes = ['click on', 'click', 'press', 'tap', 'open', 'select', 'choose'];
    for (const v of verbPrefixes) {
      if (lower.startsWith(v + ' ')) {
        core = core.slice(v.length).trim();
        break;
      }
    }
    return core.replace(/\b(button|link|tab|field|input|dropdown|drop down|icon|menu)\b/gi, '').trim() || raw;
  }

  private async identifyTargetWithLLM(userPrompt: string, coreQuery: string, elements: ElementInfo[]): Promise<number | null> {
    if (!this.model) return null;
    const summaries = this.sanitizeElementsForLLM(elements);
    const selectionQuery = coreQuery && coreQuery.trim().length ? coreQuery : userPrompt;
    const lowerPrompt = selectionQuery.toLowerCase();
    const tokens = lowerPrompt.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
    const filteredSummaries = summaries.filter((s) => {
      const label = `${s.text} ${s.label}`.toLowerCase();
      if (!label.trim()) return false;
      if (tokens.length === 0) return true;
      return tokens.some((tok) => label.includes(tok));
    });

    if (filteredSummaries.length === 0) return null;

    const prompt = `SYSTEM: Pick the element ID for "${userPrompt}".
JSON Elements: ${JSON.stringify(filteredSummaries)}
Return ONLY JSON: {"id": "el_X"}`;

    try {
      const result = await this.withTimeout(
        this.model.generateContent({ contents: [{ role: 'user', parts: [{ text: prompt }] }] } as any),
        45000, 'LLM selector'
      );
      const raw = (result as any).response?.text?.() ?? '';
      const match = raw.match(/el_(\d+)/);
      if (!match) return null;
      const idx = Number.parseInt(match[1], 10);
      return Number.isFinite(idx) ? idx : null;
    } catch {
      return null;
    }
  }

  private async clickWithHeuristics(target: string): Promise<ExecutionResult> {
    await this.browser.init();
    const page = this.browser.getPage();
    const extractor = new SelectorExtractor(page);
    let candidates: ElementInfo[] = [];
    const coreTarget = this.extractCoreLabel(target);

    try {
      let count = 0;
      let isSelectorValid = true;
      try {
        const locator = page.locator(target);
        count = await locator.filter({ hasText: /.*/ }).count();
      } catch { isSelectorValid = false; }

      if (!isSelectorValid || count === 0) {
        candidates = await extractor.findCandidates(coreTarget || target);
        if (candidates.length > 0) {
            const preferredSelector = candidates[0].selector || candidates[0].cssSelector || candidates[0].xpath;
            if (preferredSelector) return this.clickExact(preferredSelector, target);
        }
      }
      
      const info = await this.browser.click(target);
      const robustSelector = info.selector || info.cssSelector || info.xpath || target;
      this.recordCommand({
        action: 'click',
        target: robustSelector,
        selectors: { css: info.cssSelector ?? info.selector, xpath: info.xpath, id: info.id, text: info.text },
        description: target,
      });
      await page.waitForTimeout(1000);
      return { success: true, message: `Clicked "${info.text || target}"`, selectors: [info], screenshot: await this.browser.screenshot() };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Error clicking: ${msg}`, error: msg, screenshot: await this.browser.screenshot() };
    }
  }

  async type(selector: string, text: string): Promise<ExecutionResult> {
    const page = this.browser.getPage();
    const extractor = new SelectorExtractor(page);
    try {
      const info = await this.browser.type(selector, text);
      const robustSelector = info.cssSelector || selector;
      this.recordCommand({
        action: 'type',
        target: robustSelector,
        value: text,
        selectors: { css: info.cssSelector ?? info.selector, xpath: info.xpath, id: info.id, text: info.text },
        description: selector,
      });
      return { success: true, message: `Typed into ${selector}`, screenshot: await this.browser.screenshot(), selectors: [info] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, message: msg, error: msg, screenshot: await this.browser.screenshot(), selectors: await extractor.extractAllInteractive() };
    }
  }

  async handleCookieBanner(): Promise<ExecutionResult> {
    const dismissed = await this.browser.handleCookieBanner();
    return { success: true, message: dismissed ? 'Cookie banner dismissed' : 'No cookie banner detected', screenshot: await this.browser.screenshot() };
  }

  async extractSelectors(targetSelector?: string): Promise<ExecutionResult> {
    const page = this.browser.getPage();
    const extractor = new SelectorExtractor(page);
    const selectors = targetSelector ? [await extractor.extractForSelector(targetSelector)] : await extractor.extractAllInteractive();
    selectors.forEach((s, idx) => this.browser.storeSelector(`el_${idx}`, s));
    return { success: true, message: `Extracted ${selectors.length} elements`, selectors };
  }

  async observe(targetSelector?: string): Promise<ExecutionResult> {
    const page = this.browser.getPage();
    const extractor = new SelectorExtractor(page);
    const selectors = targetSelector ? [await extractor.extractForSelector(targetSelector)] : await extractor.extractAllInteractive();
    selectors.forEach((s, idx) => this.browser.storeSelector(`observe_${idx}`, s));
    return { success: true, message: `Observed ${selectors.length} interactive elements`, screenshot: await this.browser.screenshot(), selectors };
  }

  async generateSelenium(commands?: ExecutionCommand[]): Promise<ExecutionResult> {
    const gen = new SeleniumGenerator({ language: 'python', testName: 'test_flow', chromeDriverPath: 'C:\\hyprtask\\lib\\Chromium\\chromedriver.exe' }, this.model);
    return { success: true, message: 'Generated selenium code', seleniumCode: gen.generate(commands || this.sessionHistory) };
  }

  private calculateDomFingerprint(elements: ElementInfo[]): string {
    const signature = elements.filter(el => el.visible).map(el => `${el.tagName}#${el.id || ''}.${el.className || ''}[${el.text || ''}]`).join('|');
    let hash = 0;
    for (let i = 0; i < signature.length; i++) {
        const char = signature.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
    }
    return hash.toString(16);
  }

  async runAutonomousAgent(goal: string, config: AgentConfig = {}): Promise<AgentSessionResult> {
    const maxSteps = config.maxSteps ?? 30;
    this.sessionHistory = []; 
    const steps: AgentStepResult[] = [];
    const failedElements: Set<string> = new Set();
    const actionHistory: string[] = [];
    let lastDomFingerprint = '';
    this.agentContext = { consecutiveFailures: 0 };

    await this.browser.init();
    const page = this.browser.getPage();
    const urlInGoal = this.extractUrlFromPrompt(goal);
    const currentUrl = page.url();
    if (urlInGoal && (currentUrl === 'about:blank' || !currentUrl.includes(this.extractDomain(urlInGoal)))) {
        await this.navigate(urlInGoal);
        actionHistory.push(`✓ Navigated to ${urlInGoal}`);
        await page.waitForTimeout(2000);
    }

    let stepNumber = 0;
    let isFinished = false;

    while (stepNumber < maxSteps && !isFinished) {
      stepNumber++;
      const observation = await this.observe();
      const elements = observation.selectors ?? [];
      const currentFingerprint = this.calculateDomFingerprint(elements);
      let feedbackForPlanner = '';
      
      if (lastDomFingerprint && currentFingerprint === lastDomFingerprint && stepNumber > 1) {
          feedbackForPlanner = `WARNING: The last action did NOT change the page state. DO NOT repeat it. Try a different element.`;
      }
      
      let nextAction = await this.planNextAgentAction(goal, elements, actionHistory, failedElements, feedbackForPlanner, observation.screenshot);

      // RECOVERY FROM API FAILURES (Already generic)
      if (nextAction.type === 'wait' && nextAction.thought.includes('LLM planner failed')) {
        this.updateAgentContext({ consecutiveFailures: (this.agentContext?.consecutiveFailures ?? 0) + 1 });
        if ((this.agentContext?.consecutiveFailures ?? 0) >= 2) {
            nextAction = { type: 'scroll', direction: 'down', thought: 'Fallback: scrolling after repeated LLM failures' };
            this.updateAgentContext({ consecutiveFailures: 0 });
        } else {
             await page.waitForTimeout(2000 * (this.agentContext?.consecutiveFailures || 1));
             continue;
        }
      }

      config.broadcast?.({
          type: 'log',
          timestamp: new Date().toISOString(),
          message: `ai_thought: ${nextAction.thought.slice(0, 200)}`,
          data: { role: 'agent-reasoning', thought: nextAction.thought, actionType: nextAction.type }
      });

      const urlBefore = page.url();
      let retryCount = 0;
      let actionSuccess = false;
      let actionMessage = '';
      let result;

      while (retryCount <= 2 && !actionSuccess) {
           this.agentCommandBuffer = []; 
           result = await this.executeAgentAction(nextAction, elements, retryCount, failedElements);
           actionSuccess = result.success;
           actionMessage = result.message;

           if (actionSuccess) {
               if (this.agentCommandBuffer.length > 0) this.sessionHistory.push(...this.agentCommandBuffer);
               else if (nextAction.type !== 'finish') {
                   this.sessionHistory.push({
                       action: nextAction.type as any, 
                       target: (nextAction as any).selector || (nextAction as any).url,
                       value: (nextAction as any).text,
                       description: nextAction.thought,
                       selectors: result.elementInfo ? { css: result.elementInfo.cssSelector, xpath: result.elementInfo.xpath, text: result.elementInfo.text, id: result.elementInfo.id } : undefined
                   });
               }
           }
           this.agentCommandBuffer = null;

           if (!actionSuccess) {
              retryCount++;
              if (result?.failedSelector) failedElements.add(result.failedSelector);
              await page.waitForTimeout(1000);
           }
      }

      actionHistory.push(this.describeAction(nextAction, actionSuccess));
      if (nextAction.type === 'finish' && actionSuccess) isFinished = true;
      
      steps.push({ stepNumber, action: nextAction, success: actionSuccess, message: actionMessage, urlBefore, urlAfter: page.url(), stateChanged: actionSuccess, retryCount });
      config.broadcast?.({ type: 'log', timestamp: new Date().toISOString(), message: `Step ${stepNumber}: ${actionMessage}` });
      lastDomFingerprint = currentFingerprint;
    }

    return { success: isFinished, summary: `Completed ${steps.length} steps.`, goal, totalSteps: stepNumber, steps, commands: [...this.sessionHistory], seleniumCode: await this.generateSelenium().then(r => r.seleniumCode) };
  }

  private extractBalancedJson(text: string, startIndex: number = 0): { json: string, endEndex: number } | null {
    const start = text.indexOf('{', startIndex);
    if (start === -1) return null;
    let balance = 0, inQuote = false, escape = false;
    for (let i = start; i < text.length; i++) {
      const char = text[i];
      if (char === '\\' && !escape) { escape = true; continue; }
      if (char === '"' && !escape) inQuote = !inQuote;
      escape = false;
      if (!inQuote) { if (char === '{') balance++; else if (char === '}') balance--; }
      if (balance === 0) return { json: text.substring(start, i + 1), endEndex: i + 1 };
    }
    return null;
  }

  private parseAgentActionResponse(raw: string): AgentAction {
    let clean = raw.replace(/```json\s*|\s*```/gi, '').trim().replace(/,\s*([\]}])/g, '$1');
    let finalObj: any = {};
    let foundAny = false, currentIndex = 0;

    while (true) {
        const result = this.extractBalancedJson(clean, currentIndex);
        if (!result) break;
        try {
            const parsed = JSON.parse(result.json);
            if (parsed.type || parsed.action) finalObj = { ...(finalObj.thought ? {thought: finalObj.thought} : {}), ...parsed };
            else finalObj = { ...finalObj, ...parsed };
            foundAny = true;
        } catch {}
        currentIndex = result.endEndex;
    }

    if (!foundAny) {
        try {
             const repaired = clean.replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":');
             const match = repaired.match(/\{[\s\S]*\}/);
             if (match) { finalObj = JSON.parse(match[0]); foundAny = true; }
        } catch {}
    }

    let rawType = finalObj.type || finalObj.action; 
    if (typeof rawType === 'string') {
        rawType = rawType.toLowerCase().trim();
        if (['undefined', 'null', 'none', 'unknown'].includes(rawType)) rawType = 'wait';
    }
    if (!rawType) return { type: 'wait', durationMs: 2000, thought: `AI response valid but missing "type".` };

    const thought = finalObj.thought || finalObj.reasoning || 'No reasoning provided';
    switch (rawType) {
        case 'click': case 'click_element': return { type: 'click', selector: finalObj.selector, elementId: finalObj.elementId, thought };
        case 'type': case 'fill': case 'input': return { type: 'type', selector: finalObj.selector, elementId: finalObj.elementId, text: finalObj.text || finalObj.value || '', thought };
        case 'navigate': case 'goto': return { type: 'navigate', url: finalObj.url, thought };
        case 'wait': case 'delay': return { type: 'wait', durationMs: finalObj.durationMs || 1000, thought };
        case 'finish': case 'done': case 'complete': return { type: 'finish', thought, summary: finalObj.summary || 'Task completed' };
        case 'scroll': return { type: 'scroll', direction: finalObj.direction || 'down', elementId: finalObj.elementId, thought };
        case 'select_option': return { type: 'select_option', selector: finalObj.selector, elementId: finalObj.elementId, option: finalObj.option, thought };
        default: return { type: 'wait', durationMs: 1000, thought: `Unknown action type "${rawType}".` };
    }
  }

  private async planNextAgentAction(
    goal: string,
    elements: ElementInfo[],
    actionHistory: string[],
    failedElements: Set<string>,
    feedbackForPlanner: string,
    screenshot?: string
  ): Promise<AgentAction> {
    if (!this.model) return { type: 'finish', thought: 'No AI model', summary: 'No AI' };

    // --- FIX: UNIVERSAL VISIBILITY FIX (No hardcoded strings) ---
    // 1. Sort "Priority" elements to top. Priority = Dropdowns (floating/z-index), Options, & Listboxes.
    //    This is universal: any site with a custom dropdown will use these techniques.
    const sortedElements = [...elements].sort((a, b) => {
        const aIsPriority = a.isFloating || a.roleHint === 'option' || (a.attributes?.role === 'listbox');
        const bIsPriority = b.isFloating || b.roleHint === 'option' || (b.attributes?.role === 'listbox');
        
        if (aIsPriority && !bIsPriority) return -1;
        if (!aIsPriority && bIsPriority) return 1;
        return 0;
    });

    const visibleElements = sortedElements.filter(el => 
        el.visible && 
        el.tagName !== 'script' && 
        el.tagName !== 'style' &&
        (el.tagName === 'input' || el.tagName === 'select' || el.tagName === 'textarea' || el.tagName === 'button' || el.tagName === 'a' || (el.text && el.text.length > 2) || el.scrollable || el.isFloating)
    );

    const elementList = visibleElements.slice(0, 150).map((el, idx) => ({ 
        id: `el_${idx}`,
        tag: el.tagName,
        text: (el.text || '').slice(0, 40).replace(/\s+/g, ' '),
        value: el.attributes?.['value'] || '', 
        scrollable: el.scrollable ? true : undefined, 
        label: (el.ariaLabel || el.placeholder || '').slice(0, 40),
        role: el.roleHint || el.attributes?.role,
    }));

    // --- FIX: DYNAMIC CONTEXT INJECTION ---
    const page = this.browser.getPage();
    const currentUrl = page.url();
    const pageTitle = await page.title().catch(() => '');

    // --- FIX: TRULY UNIVERSAL PROMPT (No static task names) ---
    const prompt = `
SYSTEM: You are an ultra-fast autonomous browser agent.
GOAL: ${goal}

CURRENT CONTEXT:
URL: ${currentUrl}
TITLE: ${pageTitle}

HISTORY:
${actionHistory.slice(-5).join('\n')}

LAST FEEDBACK: ${feedbackForPlanner}

AVAILABLE ELEMENTS (Top 150 - Priority given to Floating/Menu elements):
${JSON.stringify(elementList)}

RULES:
1. **CONTEXT AWARENESS:** Compare the CURRENT URL/TITLE with your GOAL. 
   - If the current page matches the destination implied by the GOAL, **DO NOT** click navigation links again. Stop navigating and focus on the page content (forms/buttons).
   - If you have successfully opened a menu/dropdown, the NEXT step is usually to click an option inside it.

2. **MISSING ELEMENTS:**
   - If your GOAL requires selecting an option (text) that is NOT in the list, look for "scrollable": true elements (lists/divs) and SCROLL them.
   - Do not assume an element is missing just because you don't see it immediately; scroll the container.

3. **PROGRESSION:**
   - If you just clicked a button that implies submission (e.g. "Go", "Search", "Submit"), WAIT for the system. Do not click it again immediately.
   - Do not toggle checkboxes repeatedly. Check their state first.

RETURN ONLY JSON:
{ "type": "click"|"type"|"scroll"|"wait"|"finish", "elementId": "el_X", "thought": "reasoning" }
`;

    try {
      let result: any;
      let attempts = 0;
      while (attempts < 3) {
        try {
            result = await this.withTimeout(
                this.model.generateContent({ contents: [{ role: 'user', parts: [{ text: prompt }] }] } as any),
                35000, 'Agent planner'
            );
            break; 
        } catch (err) {
            attempts++;
            const msg = String(err);
            if (msg.includes('429') || msg.includes('Quota') || msg.includes('fetch')) {
                console.warn(`[SmartAgent] API Quota Hit (Attempt ${attempts}). Waiting ${2000 * attempts}ms...`);
                await new Promise(r => setTimeout(r, 2000 * attempts));
            } else {
                throw err;
            }
        }
      }
      if (!result) throw new Error('LLM failed after retries');

      const response = (result as any).response?.text?.() ?? '';
      return this.parseAgentActionResponse(response);
    } catch (err) {
      console.error('[SmartAgent] Planner error:', err);
      return { type: 'wait', durationMs: 2000, thought: `LLM planner failed: ${String(err).slice(0,100)}` };
    }
  }

  // ... (executeAgentAction and describeAction remain the same) ...
  private async executeAgentAction(
    action: AgentAction,
    elements: ElementInfo[],
    attempt: number,
    failedElements: Set<string>,
  ): Promise<{ success: boolean; message: string; failedSelector?: string; elementInfo?: ElementInfo }> {
    try {
      switch (action.type) {
        case 'navigate': return await this.navigate(action.url);
        case 'click':
        case 'select_option': {
          let selectorToUse = action.selector;
          if (!selectorToUse && action.elementId) {
             // Re-map elementId using the SAME universal priority logic as the planner
             const sortedElements = [...elements].sort((a, b) => {
                const aIsPriority = a.isFloating || a.roleHint === 'option' || (a.attributes?.role === 'listbox');
                const bIsPriority = b.isFloating || b.roleHint === 'option' || (b.attributes?.role === 'listbox');
                if (aIsPriority && !bIsPriority) return -1;
                if (!aIsPriority && bIsPriority) return 1;
                return 0;
             });

             const visibleElements = sortedElements.filter(el => 
                el.visible && el.tagName !== 'script' && el.tagName !== 'style' &&
                (el.tagName === 'input' || el.tagName === 'select' || el.tagName === 'textarea' || el.tagName === 'button' || el.tagName === 'a' || (el.text && el.text.length > 2) || el.scrollable || el.isFloating)
            );
             
             const match = action.elementId.match(/^el_(\d+)$/);
             if (match) {
                 const idx = parseInt(match[1]);
                 const el = visibleElements[idx];
                 if (el) selectorToUse = el.selector || el.cssSelector;
             }
          }
          if (!selectorToUse) return { success: false, message: 'No selector found' };
          const res = await this.clickExact(selectorToUse);
          return { success: res.success, message: res.message, failedSelector: res.success ? undefined : selectorToUse, elementInfo: res.selectors?.[0] };
        }
        case 'type': {
            let selectorToUse = action.selector;
            if (!selectorToUse && action.elementId) {
                // Re-map elementId using the SAME universal priority logic
                const sortedElements = [...elements].sort((a, b) => {
                    const aIsPriority = a.isFloating || a.roleHint === 'option' || (a.attributes?.role === 'listbox');
                    const bIsPriority = b.isFloating || b.roleHint === 'option' || (b.attributes?.role === 'listbox');
                    if (aIsPriority && !bIsPriority) return -1;
                    if (!aIsPriority && bIsPriority) return 1;
                    return 0;
                });

                const visibleElements = sortedElements.filter(el => 
                    el.visible && el.tagName !== 'script' && el.tagName !== 'style' &&
                    (el.tagName === 'input' || el.tagName === 'select' || el.tagName === 'textarea' || el.tagName === 'button' || el.tagName === 'a' || (el.text && el.text.length > 2) || el.scrollable || el.isFloating)
                );
                
                const match = action.elementId.match(/^el_(\d+)$/);
                if (match) {
                    const idx = parseInt(match[1]);
                    const el = visibleElements[idx];
                    if (el) selectorToUse = el.selector || el.cssSelector;
                }
            }
            if (!selectorToUse) return { success: false, message: 'No selector found' };
            const res = await this.type(selectorToUse, action.text);
            return { success: res.success, message: res.message, failedSelector: res.success ? undefined : selectorToUse, elementInfo: res.selectors?.[0] };
        }
        case 'scroll': {
            let selectorToScroll: string | undefined;
            if (action.elementId) {
                const match = action.elementId.match(/^el_(\d+)$/);
                if (match) {
                    const sortedElements = [...elements].sort((a, b) => {
                        const aIsPriority = a.isFloating || a.roleHint === 'option' || (a.attributes?.role === 'listbox');
                        const bIsPriority = b.isFloating || b.roleHint === 'option' || (b.attributes?.role === 'listbox');
                        if (aIsPriority && !bIsPriority) return -1;
                        if (!aIsPriority && bIsPriority) return 1;
                        return 0;
                    });
                    
                    const visibleElements = sortedElements.filter(el => 
                        el.visible && el.tagName !== 'script' && el.tagName !== 'style' &&
                        (el.tagName === 'input' || el.tagName === 'select' || el.tagName === 'textarea' || el.tagName === 'button' || el.tagName === 'a' || (el.text && el.text.length > 2) || el.scrollable || el.isFloating)
                    );
                    
                    const el = visibleElements[parseInt(match[1])];
                    if (el) selectorToScroll = el.selector || el.cssSelector;
                }
            }
            return await this.browser.scroll(selectorToScroll, action.direction);
        }
        case 'wait': 
            await this.browser.getPage().waitForTimeout(action.durationMs);
            return { success: true, message: `Waited ${action.durationMs}ms` };
        case 'finish': return { success: true, message: action.summary };
        default: return { success: false, message: `Unknown action` };
      }
    } catch (err) {
      return { success: false, message: `Error: ${err}` };
    }
  }

  private describeAction(action: AgentAction, success: boolean): string {
    const status = success ? '✓' : '✗';
    switch (action.type) {
      case 'navigate': return `${status} navigate ${action.url}`;
      case 'click': return `${status} click ${action.elementId || 'element'}`;
      case 'type': return `${status} type "${action.text}"`;
      case 'scroll': return `${status} scroll ${action.direction}`;
      case 'wait': return `${status} wait`;
      case 'finish': return `${status} finish`;
      default: return `${status} action`;
    }
  }
}