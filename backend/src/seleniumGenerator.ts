import { GenerativeModel } from '@google/generative-ai';
import OpenAI from 'openai';
import { ExecutionCommand } from './types';
import { parseSopText, SopStep } from './sopParser';

export class SeleniumGenerator {
  constructor(
    private readonly opts: {
      language?: 'python';
      testName?: string;
      chromeDriverPath?: string;
    } = {},
    private readonly gemini?: GenerativeModel,
    private readonly openai?: OpenAI,
  ) {}

  generate(commands: ExecutionCommand[], startingUrl?: string): string {
    return this.generatePython(commands, startingUrl);
  }

  private extractUrlFromPrompt(prompt: string): string | null {
    const sanitize = (u: string) => u.replace(/[\]\[\)\}\{\"'”“’.,;:]+$/g, '');

    const match = prompt.match(/https?:\/\/[^\s,;"']+/);
    if (match) return sanitize(match[0]);

    const domainMatch = prompt.match(/\b(?:go to|navigate to|open)\s+([a-zA-Z0-9-]+\.[a-zA-Z]{2,})\b/i);
    if (domainMatch) return `https://${sanitize(domainMatch[1])}`;

    return null;
  }

  private validatePythonOutput(
    python: string,
    allowed: { css: string[]; xpath: string[]; id: string[] },
    wantsGDriveUpload: boolean,
    expectedTargetUrl?: string
  ): string[] {
    const issues: string[] = [];

    if (!wantsGDriveUpload) {
      // Only flag if it looks like Google Drive API usage (not just the word "drive" in a comment).
      if (/googleapiclient|google\.oauth2|service_account\.credentials|build\(['\"]drive['\"]\s*,\s*['\"]v3['\"]/i.test(python)) {
        issues.push('Google Drive upload code detected but SOP does not request upload.');
      }
    }

    // Enforce URL correctness so the generated script always starts at the SOP URL.
    if (expectedTargetUrl) {
      const targetUrlLine = python.match(/^\s*TARGET_URL\s*=\s*['\"]([^'\"]+)['\"]\s*$/m);
      if (!targetUrlLine) {
        issues.push('Missing required TARGET_URL assignment.');
      } else if (targetUrlLine[1] !== expectedTargetUrl) {
        issues.push(`TARGET_URL mismatch: expected "${expectedTargetUrl}" but got "${targetUrlLine[1]}".`);
      }

      // If we know the target URL is not example.com, block accidental example.com leftovers.
      if (expectedTargetUrl !== 'https://example.com' && /https:\/\/example\.com/i.test(python)) {
        issues.push('Script still contains https://example.com but SOP specifies a different site.');
      }

      // Encourage using the constant for the first navigation.
      if (!/driver\.get\(\s*TARGET_URL\s*\)/.test(python)) {
        // Not a hard error, but it correlates strongly with wrong-base-url failures.
        issues.push('Script does not use driver.get(TARGET_URL) for initial navigation.');
      }
    }

    // Ensure find_one is not "clickable-only" (clickable can fail for hover menus / overlays / hidden-but-clickable elements).
    if (/def\s+find_one\s*\(/.test(python)) {
      const hasClickable = /element_to_be_clickable/.test(python);
      const hasPresence = /presence_of_element_located/.test(python);
      if (hasClickable && !hasPresence) {
        issues.push('find_one() uses element_to_be_clickable only; it must fall back to presence_of_element_located for menu/dropdown elements.');
      }
    }

    const allowedCss = new Set((allowed.css || []).map(s => s.trim()).filter(Boolean));
    const allowedXpath = new Set((allowed.xpath || []).map(s => s.trim()).filter(Boolean));

    const cssRe = /By\.CSS_SELECTOR\s*,\s*(['\"])(.*?)\1/g;
    const xpRe = /By\.XPATH\s*,\s*(['\"])(.*?)\1/g;

    const disallowedCss = new Set<string>();
    const disallowedXpath = new Set<string>();

    for (const m of python.matchAll(cssRe)) {
      const sel = (m[2] || '').trim();
      if (!sel) continue;
      if (!allowedCss.has(sel)) disallowedCss.add(sel);
    }

    for (const m of python.matchAll(xpRe)) {
      const sel = (m[2] || '').trim();
      if (!sel) continue;
      if (!allowedXpath.has(sel)) disallowedXpath.add(sel);
    }

    const maxList = 15;
    if (disallowedCss.size > 0) {
      issues.push(`Disallowed CSS selectors found (must be from allowedSelectors): ${Array.from(disallowedCss).slice(0, maxList).join(', ')}`);
    }
    if (disallowedXpath.size > 0) {
      issues.push(`Disallowed XPath selectors found (must be from allowedSelectors): ${Array.from(disallowedXpath).slice(0, maxList).join(', ')}`);
    }

    return issues;
  }

  private collectAllowedSelectors(
    history: ExecutionCommand[],
    scrapeSpecs: any[]
  ): { css: string[]; xpath: string[]; id: string[] } {
    const css = new Set<string>();
    const xpath = new Set<string>();
    const id = new Set<string>();

    const add = (set: Set<string>, v: unknown) => {
      if (typeof v !== 'string') return;
      const s = v.trim();
      if (!s) return;
      set.add(s);
    };

    for (const cmd of history) {
      add(css, cmd.selectors?.css);
      add(xpath, cmd.selectors?.xpath);
      add(id, cmd.selectors?.id);

      // Some commands store a CSS selector directly in target.
      if (cmd.action === 'click' || cmd.action === 'type') {
        if (typeof cmd.target === 'string' && /^(#|\.|\[|[a-zA-Z])/.test(cmd.target.trim())) {
          add(css, cmd.target);
        }
      }
    }

    for (const spec of scrapeSpecs || []) {
      if (!spec || typeof spec !== 'object') continue;
      add(css, (spec as any).rootSelector);
      add(css, (spec as any).itemSelector);
      add(css, (spec as any)?.pagination?.nextSelector);
      add(css, (spec as any)?.pagination?.loadMoreSelector);

      const inferred = (spec as any).inferred;
      if (inferred && typeof inferred === 'object') {
        for (const k of Object.keys(inferred)) {
          add(css, inferred[k]);
        }
      }
    }

    // Add derived-but-still-real selectors to improve robustness without hallucinating.
    // Example: if a recorded selector is "#menu-item-19279 > a.some-class", also allow "#menu-item-19279".
    for (const sel of Array.from(css)) {
      for (const m of sel.matchAll(/#([a-zA-Z0-9_-]+)/g)) {
        css.add(`#${m[1]}`);
      }
    }

    // Keep these bounded so prompts don't explode.
    const bounded = (arr: string[], max: number) => arr.slice(0, max);

    return {
      css: bounded(Array.from(css), 350),
      xpath: bounded(Array.from(xpath), 150),
      id: bounded(Array.from(id), 150)
    };
  }

  private inferLoopHints(history: ExecutionCommand[]): Array<{
    action: string;
    selectorKind: 'css' | 'xpath';
    baseSelector: string;
    startIndex: number;
    endIndex: number;
    count: number;
    examples: string[];
  }> {
    const hints: Array<{
      action: string;
      selectorKind: 'css' | 'xpath';
      baseSelector: string;
      startIndex: number;
      endIndex: number;
      count: number;
      examples: string[];
    }> = [];

    const cssNth = /^(.*?):nth-of-type\((\d+)\)(.*)$/;
    const xpathIdx = /^(.*)\[(\d+)\]$/;

    type Candidate = {
      action: string;
      selectorKind: 'css' | 'xpath';
      baseSelector: string;
      index: number;
      full: string;
    };

    const candidates: Candidate[] = [];
    for (const cmd of history) {
      if (cmd.action !== 'click') continue;

      const css = cmd.selectors?.css || '';
      const xpath = cmd.selectors?.xpath || '';

      const cm = css.match(cssNth);
      if (cm) {
        candidates.push({
          action: cmd.action,
          selectorKind: 'css',
          baseSelector: `${cm[1]}:nth-of-type({i})${cm[3]}`,
          index: Number(cm[2]),
          full: css
        });
        continue;
      }

      const xm = xpath.match(xpathIdx);
      if (xm) {
        candidates.push({
          action: cmd.action,
          selectorKind: 'xpath',
          baseSelector: `${xm[1]}[{i}]`,
          index: Number(xm[2]),
          full: xpath
        });
      }
    }

    // Group consecutive indices by base selector.
    const byBase = new Map<string, Candidate[]>();
    for (const c of candidates) {
      const k = `${c.selectorKind}|${c.baseSelector}`;
      const arr = byBase.get(k) || [];
      arr.push(c);
      byBase.set(k, arr);
    }

    for (const [k, arr] of byBase.entries()) {
      arr.sort((a, b) => a.index - b.index);

      let runStart = 0;
      for (let i = 1; i <= arr.length; i++) {
        const prev = arr[i - 1];
        const curr = arr[i];
        const runBreak = !curr || curr.index !== prev.index + 1;
        if (runBreak) {
          const run = arr.slice(runStart, i);
          if (run.length >= 3) {
            const [selectorKind, baseSelector] = k.split('|') as ['css' | 'xpath', string];
            hints.push({
              action: run[0].action,
              selectorKind,
              baseSelector,
              startIndex: run[0].index,
              endIndex: run[run.length - 1].index,
              count: run.length,
              examples: run.slice(0, 3).map(r => r.full)
            });
          }
          runStart = i;
        }
      }
    }

    return hints.slice(0, 20);
  }

  // --- LLM-DRIVEN CODE SYNTHESIS (SOP + TRACE + SELECTORS) ---
  async generateSmartAutomationCode(
    goal: string,
    history: ExecutionCommand[],
    provider: 'gemini' | 'openai' = 'gemini'
  ): Promise<string> {
    const sop = parseSopText(goal);
    const extractedUrl = this.extractUrlFromPrompt(goal) || sop.targetUrl || 'https://example.com';
    const wantsGDriveUpload = !!sop.wantsGDriveUpload;

    // Heuristic loop hints for the LLM (keeps output dynamic, avoids repeated hardcoded blocks)
    const loopHints = this.inferLoopHints(history);

    const scrapeSpecs = history
      .filter(h => h.action === 'scrape_data')
      .map(h => h.data)
      .filter(Boolean);

    const allowedSelectors = this.collectAllowedSelectors(history, scrapeSpecs);

    const traceWindow = history.length <= 400
      ? history
      : [...history.slice(0, 100), ...history.slice(-300)];

    const traceForPrompt = traceWindow.map(h => ({
      action: h.action,
      target: h.target,
      value: h.value,
      description: h.description,
      selectors: h.selectors,
      url: h.url,
      elementMeta: h.elementMeta,
      // Keep data for ALL actions (e.g., dropdown selection hints) to keep codegen dynamic.
      data: h.data
    }));

    // CRITICAL: Validate execution trace contains all SOP steps
    const missingSteps: string[] = [];
    for (const step of sop.steps) {
      // Skip non-interactive steps
      if (step.kind === 'save_excel' || step.kind === 'upload_gdrive' || step.kind === 'other') continue;
      
      // Check if step is in execution trace
      const stepText = step.raw.toLowerCase();
      const found = history.some(cmd => {
        const desc = (cmd.description || '').toLowerCase();
        const value = (cmd.value || '').toLowerCase();
        
        // For select steps, check both dropdown name and option
        if (step.kind === 'select') {
          const dropdownMatch = stepText.match(/\b(\w+)\s+drop\s*down/);
          const optionMatch = stepText.match(/select\s+["']?([\w\s]+)["']?(?:\s+option)?/);
          const dropdownName = dropdownMatch ? dropdownMatch[1].toLowerCase() : '';
          const optionValue = optionMatch ? optionMatch[1].toLowerCase().trim() : '';
          
          const hasDropdown = dropdownName && (desc.includes(dropdownName) || value.includes(dropdownName));
          const hasOption = optionValue && (desc.includes(optionValue) || value.includes(optionValue));
          
          return hasDropdown && hasOption;
        }
        
        // For other steps, basic keyword matching
        return desc.includes(step.kind) || value.includes(step.kind);
      });
      
      if (!found) {
        missingSteps.push(`Step ${step.index + 1}: ${step.raw}`);
      }
    }

    const automationSpec = {
      preferences: {
        selectorPriority: 'recorded-only',
        // User requested: only real-time selectors (no invented fallbacks)
        allowBetterFallbackSelectors: false,
        output: {
          singlePythonFile: true,
          ...(wantsGDriveUpload ? { googleDriveUpload: { method: 'service_account' } } : {})
        }
      },
      sop: {
        raw: goal,
        parsed: sop,
        missingSteps: missingSteps.length > 0 ? missingSteps : undefined
      },
      targetUrl: extractedUrl,
      allowedSelectors,
      loopHints,
      scrapeSpecs,
      executionTrace: traceForPrompt,
    };

    const prompt = `
ROLE: You are a Senior Python Automation Architect.

TASK:
Generate ONE single-file, production-ready Python Selenium script that follows the SOP exactly.
- Do NOT add any extra steps beyond the SOP.
- Use ONLY the real-time selectors provided in INPUT_SPEC_JSON.allowedSelectors and executionTrace[*].selectors.
- Do NOT invent or "improve" selectors beyond the allowed list.
- Enforce execution flow: steps that must happen once (navigate, set filters, click FILTER) must appear once.
- Detect repetition patterns and emit loops (do NOT duplicate blocks).
- Implement non-web steps only if explicitly required by the SOP (e.g., Excel output; Google Drive upload only if SOP says upload).

CRITICAL:
- The base URL is: ${extractedUrl}
- You MUST include this exact line near the top of the script:
  TARGET_URL = "${extractedUrl}"
- Output MUST be valid Python only. No markdown.

INPUT_SPEC_JSON:
${JSON.stringify(automationSpec, null, 2)}

REQUIREMENTS:
1) Selenium setup:
- Use webdriver_manager (ChromeDriverManager) and ChromeOptions.
- Use WebDriverWait + expected_conditions; avoid arbitrary sleeps except for tiny UI settling.

2) ROBUST CLICK HANDLING (CRITICAL - prevents "element not interactable" errors):
- Create a helper function safe_click(driver, element) that:
  a) First scrolls the element into view using: driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", element)
  b) Waits a tiny moment (0.3s) for scroll to complete
  c) Tries regular element.click()
  d) If that fails (ElementClickInterceptedException, TimeoutException, StaleElementReferenceException), falls back to JavaScript click: driver.execute_script("arguments[0].click();", element)
- Use safe_click() for ALL click operations, NOT element.click() directly.
- IMPORTANT (universal): for nav/menu/dropdown triggers, elements may be present but not "clickable" yet.
  Your find_one() MUST try element_to_be_clickable first, and if it times out, fall back to presence_of_element_located.

3) Navigation (IMPORTANT):
- You MUST navigate using the TARGET_URL constant:
  driver.get(TARGET_URL)
- Do NOT hardcode the base URL in driver.get("...") if it equals TARGET_URL.

4) Dropdown selection (IMPORTANT):
- If executionTrace contains a typing step that indicates an Enter press (either data.pressEnter==true or the description contains "press Enter"), treat it as a dropdown selection.
- Implement as: click/focus the dropdown element -> send_keys(<value>) -> send_keys(Keys.ENTER).
- Import Keys only when needed.
- IMPORTANT: Before interacting with dropdowns, scroll them into view using: driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", dropdown)

5) Locator strategy (must be implemented as code):
- Create helper functions like find_one(driver, candidates) where candidates is a list of (By, selector).
- find_one MUST be robust:
  - It must attempt EC.element_to_be_clickable((By, selector)) briefly.
  - If that fails, it must fall back to EC.presence_of_element_located((By, selector)) and return the element.
  - This is required for hover menus / sticky headers / overlays where Selenium's "clickable" heuristic fails.
- For each action, try recorded CSS, then recorded XPath, then recorded id.
- IMPORTANT: Do not generate any new selectors. Use only selectors present in allowedSelectors/executionTrace/scrapeSpecs.

6) Scraping:
- If SOP includes a scrape step, you MUST use scrapeSpecs (captured from the real DOM) for scraping.
- Prefer scrapeSpecs[0].rootSelector to scope scraping to the directory results area (avoid header/nav).
- Prefer scrapeSpecs[0].itemSelector for finding items and iterate over ALL items.
- Pagination:
  - If scrapeSpecs[0].pagination.nextSelector exists, click it in a loop until it is absent/disabled.
  - Else if scrapeSpecs[0].pagination.loadMoreSelector exists, click it until no new items appear.
- Extract ONLY the requested fields into a list of dicts.

4) Excel:
- Save data to an .xlsx using pandas.

${wantsGDriveUpload ? `5) Google Drive upload (service account):
- Implement upload_file_to_gdrive_service_account(file_path, folder_id=None).
- Use google.oauth2.service_account + googleapiclient.discovery.build('drive','v3').
- Credential path should be configurable via SERVICE_ACCOUNT_FILE env var.
` : `5) Google Drive upload:
- NOT REQUESTED by the SOP. Do NOT include any Google Drive / gdrive code.
`}

OUTPUT:
Return ONLY the Python code.
`;

    const runOnce = async (p: string): Promise<string> => {
      if (provider === 'openai' && this.openai) {
        const completion = await this.openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: 'You are a Python Code Generator.' },
            { role: 'user', content: p }
          ]
        });
        return completion.choices[0].message.content || '';
      }

      if (this.gemini) {
        const res = await this.gemini.generateContent({
          contents: [{ role: 'user', parts: [{ text: p }] }]
        });
        return res.response.text();
      }

      return '# Error: No AI provider configured for code generation.';
    };

    let code = await runOnce(prompt);

    // Basic validation: do not allow unwanted features (like GDrive) and do not allow selector hallucination.
    // Also enforce correct TARGET_URL and robust find_one behavior.
    const cleanedOnce = code.replace(/```python|```/g, '').trim();
    const issues = this.validatePythonOutput(cleanedOnce, allowedSelectors, wantsGDriveUpload, extractedUrl);

    if (issues.length > 0) {
      const repairPrompt = `${prompt}\n\nVALIDATION_ERRORS:\n${issues.map(i => `- ${i}`).join('\n')}\n\nREPAIR_INSTRUCTIONS:\n- Regenerate the FULL python script.\n- Fix ALL validation errors.\n- Output only python code.`;
      code = await runOnce(repairPrompt);
    }

    // Normalize critical invariants defensively (makes output stable even if the LLM partially ignores instructions).
    const normalized = this.normalizeSmartPythonOutput(code, extractedUrl);

    // Strip markdown if the LLM ignores instructions
    return normalized.replace(/```python|```/g, '').trim();
  }

  private normalizeSmartPythonOutput(raw: string, targetUrl: string): string {
    const stripMd = (s: string) => s.replace(/```python|```/g, '').trim();
    let code = stripMd(raw);

    const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Ensure TARGET_URL exists and matches.
    if (/^\s*TARGET_URL\s*=\s*/m.test(code)) {
      code = code.replace(/^\s*TARGET_URL\s*=\s*['\"][^'\"]*['\"]\s*$/m, `TARGET_URL = "${targetUrl}"`);
    } else {
      // Insert after the import block for readability.
      const lines = code.split(/\r?\n/);
      let insertAt = 0;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (/^\s*(import|from)\s+/.test(l)) {
          insertAt = i + 1;
          continue;
        }
        // Stop at first non-import-ish line after seeing imports.
        if (insertAt > 0 && l.trim() !== '') break;
      }
      lines.splice(insertAt, 0, '', `TARGET_URL = "${targetUrl}"`, '');
      code = lines.join('\n');
    }

    // Prefer driver.get(TARGET_URL) over hardcoded URLs (keeps base URL in one place).
    const targetUrlRe = new RegExp(`driver\\.get\\(\\s*['\"]${escapeRegExp(targetUrl)}['\"]\\s*\\)`, 'g');
    code = code.replace(targetUrlRe, 'driver.get(TARGET_URL)');

    // If the model leaked example.com, map it to TARGET_URL (only when targetUrl is not example.com).
    if (targetUrl !== 'https://example.com') {
      code = code.replace(/driver\.get\(\s*['\"]https:\/\/example\.com['\"]\s*\)/g, 'driver.get(TARGET_URL)');
    }

    return code;
  }

  private generatePython(commands: ExecutionCommand[], startingUrl?: string): string {
    const testName = this.opts.testName ?? 'test_flow';
    const driverPath = this.opts.chromeDriverPath ?? 'C:\\\\hyprtask\\\\lib\\\\Chromium\\\\chromedriver.exe';

    const needsKeys = commands.some(c => {
      if (c.action !== 'type') return false;
      const data: any = (c as any).data;
      if (data && typeof data === 'object' && data.pressEnter === true) return true;
      return typeof c.value === 'string' && /\n\s*$/.test(c.value);
    });

    // 1. ROBUST HEADER & SAFE_CLICK
    // We switched safe_click to use JS immediately if standard click fails,
    // and added scrollIntoView to handle headers covering elements.
    const header = [
      'from selenium import webdriver',
      'from selenium.webdriver.common.by import By',
      ...(needsKeys ? ['from selenium.webdriver.common.keys import Keys'] : []),
      'from selenium.webdriver.support.ui import WebDriverWait',
      'from selenium.webdriver.support import expected_conditions as EC',
      'from selenium.webdriver.chrome.service import Service',
      'from selenium.common.exceptions import ElementClickInterceptedException, TimeoutException, StaleElementReferenceException, InvalidElementStateException',
      'import json',
      'import time',
      '',
      'def inject_cookies(driver, raw_cookies_json):',
      '    try:',
      '        cookies = json.loads(raw_cookies_json)',
      '        for c in cookies:',
      '            driver.add_cookie(c)',
      '    except:',
      '        pass',
      '',
      'def safe_click(driver, element):',
      '    """Universal robust click: handles hover menus, overlays, and hidden elements."""',
      '    try:',
      '        # 1. Try scrolling into view first',
      '        driver.execute_script("arguments[0].scrollIntoView({block: \'center\'});", element)',
      '        time.sleep(0.5)',
      '        element.click()',
      '    except (ElementClickInterceptedException, TimeoutException, StaleElementReferenceException):',
      '        # 2. Fallback to JS click (Works on hidden/hover-only elements)',
      '        try:',
      '            driver.execute_script("arguments[0].click();", element)',
      '        except:',
      '            pass',
      '',
      'def safe_clear(element):',
      '    """Safely clear element content, handling invalid element state exceptions."""',
      '    try:',
      '        element.clear()',
      '    except (InvalidElementStateException, StaleElementReferenceException):',
      '        # Element is read-only, disabled, or not an input field - skip clearing',
      '        pass',
      '',
      `def ${testName}():`,
      `    options = webdriver.ChromeOptions()`,
      `    options.add_argument('--start-maximized')`,
      `    options.add_argument('--ignore-certificate-errors')`,
      `    service = Service(r'${driverPath}')`,
      `    driver = webdriver.Chrome(service=service, options=options)`,
      `    wait = WebDriverWait(driver, 10)`, // Reduced timeout for speed
      '    try:'
    ];

    const rawBodyLines: string[] = [];

    // 2. FORCE NAVIGATION (Universal Fix)
    // If a URL is provided (from prompt), it is ALWAYS the first line.
    if (startingUrl) {
        rawBodyLines.push(`        # Navigate to Initial URL`);
        rawBodyLines.push(`        driver.get("${startingUrl}")`);
        rawBodyLines.push(`        time.sleep(3)`);
    }

    const getSelectorCode = (cmd: ExecutionCommand): string => {
      // 1. Prefer CSS (Cleanest)
      if (cmd.selectors?.css && cmd.selectors.css.trim().length > 2) {
        return `(By.CSS_SELECTOR, "${cmd.selectors.css.replace(/"/g, '\\"')}")`;
      }
      // 2. Prefer XPath
      if (cmd.selectors?.xpath && cmd.selectors.xpath.trim().length > 2) {
        return `(By.XPATH, "${cmd.selectors.xpath.replace(/"/g, '\\"')}")`;
      }
      // 3. Prefer ID
      if (cmd.selectors?.id && cmd.selectors.id.trim()) {
        return `(By.ID, "${cmd.selectors.id.replace(/"/g, '\\"')}")`;
      }

      // 4. Text Fallback
      const textHint = cmd.selectors?.text || cmd.description?.replace(/^Click\s+/i, '') || cmd.target;
      const safeText = (textHint || '').trim().replace(/'/g, "\\'");
      if (safeText && !safeText.includes('el_') && !safeText.startsWith('#') && !safeText.startsWith('.')) {
          return `(By.XPATH, "//*[contains(text(), '${safeText}') or contains(@aria-label, '${safeText}')]")`;
      }

      // 5. Raw Target
      return `(By.CSS_SELECTOR, "${(cmd.target || '').replace(/"/g, '\\"')}")`;
    };

    // 3. GENERATE BODY
    for (const cmd of commands) {
      if (['click', 'type'].includes(cmd.action) &&
          !cmd.selectors?.css && !cmd.selectors?.xpath && !cmd.selectors?.id && !cmd.target) {
          continue;
      }

      // Skip navigation commands if we already handled the start URL (prevents duplicates)
      if (cmd.action === 'navigate' && startingUrl && cmd.target === startingUrl) continue;

      if (cmd.description && !cmd.description.startsWith('Start at')) {
        rawBodyLines.push(`        # ${cmd.description.replace(/\n/g, ' ')}`);
      }

      const selectorCode = getSelectorCode(cmd);

      switch (cmd.action.toLowerCase()) {
        case 'navigate':
          if (!startingUrl) { // Only add if not already forced at start
              rawBodyLines.push(`        driver.get("${cmd.target}")`);
              rawBodyLines.push(`        time.sleep(2)`);
          }
          break;

        case 'click':
            // CRITICAL FIX FOR MENUS:
            // Use 'presence_of_element_located' instead of 'element_to_be_clickable'.
            // 'clickable' fails if the menu item is hidden (needs hover).
            // 'presence' finds it, and our new safe_click handles the JS trigger.
            rawBodyLines.push(
              `        elem = wait.until(EC.presence_of_element_located(${selectorCode}))`,
              '        safe_click(driver, elem)',
              '        time.sleep(1)'
            );
          break;

        case 'type': {
            const rawValue = String(cmd.value ?? '');
            const data: any = (cmd as any).data;
            const pressEnter = (data && typeof data === 'object' && data.pressEnter === true) || /\n\s*$/.test(rawValue);
            const value = pressEnter ? rawValue.replace(/\n\s*$/, '') : rawValue;

            // DYNAMIC DROPDOWN DETECTION:
            // If pressEnter is true, this is likely a dropdown selection.
            // We need to handle both native <select> and custom dropdowns.
            if (pressEnter) {
              const escapedValue = value.replace(/"/g, '\\"');
              const lowerValue = escapedValue.toLowerCase();
              rawBodyLines.push(
                `        elem = wait.until(EC.presence_of_element_located(${selectorCode}))`,
                `        # Dropdown selection - handle both native <select> and custom dropdowns`,
                `        elem_tag = elem.tag_name.lower()`,
                `        if elem_tag == 'select':`,
                `            # Native <select> element - use Select class`,
                `            from selenium.webdriver.support.ui import Select`,
                `            select = Select(elem)`,
                `            try:`,
                `                # Try by visible text first (most reliable)`,
                `                select.select_by_visible_text("${escapedValue}")`,
                `            except:`,
                `                try:`,
                `                    # Fallback: try by value attribute`,
                `                    select.select_by_value("${escapedValue}")`,
                `                except:`,
                `                    try:`,
                `                        # Final fallback: partial text match`,
                `                        for option in select.options:`,
                `                            if "${lowerValue}" in option.text.lower():`,
                `                                select.select_by_value(option.get_attribute('value'))`,
                `                                break`,
                `                    except:`,
                `                        pass`,
                `        else:`,
                `            # Custom dropdown - use keyboard input`,
                `            safe_click(driver, elem)`,
                `            time.sleep(0.3)`,
                `            elem.send_keys("${escapedValue}")`,
                `            elem.send_keys(Keys.ENTER)`,
                `        time.sleep(0.5)`
              );
            } else {
              // Regular text input (not a dropdown)
              rawBodyLines.push(
                `        elem = wait.until(EC.presence_of_element_located(${selectorCode}))`,
                `        safe_clear(elem)`,
                `        elem.send_keys("${value.replace(/"/g, '\\"')}")`,
                '        time.sleep(0.5)'
              );
            }
          break;
        }

        case 'wait':
          const t = (cmd.waitTime && !isNaN(cmd.waitTime)) ? cmd.waitTime : 1;
          // Cap max wait to 2s to keep tests fast
          const safeWait = Math.min(t, 2);
          if (safeWait > 0.1) rawBodyLines.push(`        time.sleep(${safeWait})`);
          break;
      }
    }

    const footer = [
      '    finally:',
      '        driver.quit()',
      '',
      "if __name__ == '__main__':",
      `    ${testName}()`
    ];
    return [...header, ...rawBodyLines, ...footer].join('\n');
  }
}