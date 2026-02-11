import { GenerativeModel } from '@google/generative-ai';
import OpenAI from 'openai';
import { ExecutionCommand } from './types';

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
    const match = prompt.match(/https?:\/\/[^\s,;"']+/);
    if (match) return match[0];
    const domainMatch = prompt.match(/\b(?:go to|navigate to|open)\s+([a-zA-Z0-9-]+\.[a-zA-Z]{2,})\b/i);
    if (domainMatch) return `https://${domainMatch[1]}`;
    return null;
  }

  // --- NEW: LLM-DRIVEN CODE SYNTHESIS ---
  async generateSmartAutomationCode(
    goal: string,
    history: ExecutionCommand[],
    provider: 'gemini' | 'openai' = 'gemini'
  ): Promise<string> {
    const extractedUrl = this.extractUrlFromPrompt(goal) || 'https://example.com';
    const prompt = `
    ROLE: You are a Senior Python SDET (Software Development Engineer in Test) and Automation Architect.

    TASK:
    Generate a robust, production-ready Python Selenium script based on the User's SOP (Goal) and the recorded Execution Trace.
    The script must handle both the web automation parts and any "other actions" (data processing, API calls, file handling) described in the SOP.

    **CRITICAL INSTRUCTION FOR URL:**
    The base URL from the SOP is: ${extractedUrl}
    In the generated Python code, you MUST include this exact line at the top:
    TARGET_URL = "${extractedUrl}"
    Do NOT use any other URL or placeholder. Use "${extractedUrl}" for all navigation.

    INPUTS:
    1. SOP / GOAL: "${goal}"
    2. EXECUTION TRACE: ${JSON.stringify(history.map(h => ({ action: h.action, target: h.target, value: h.value, description: h.description, selectors: h.selectors })))}

    GUIDELINES:
    1. **URL Handling**:
       - Always use TARGET_URL = "${extractedUrl}" at the top of the script.
       - For navigation, use driver.get(TARGET_URL) or similar.

    2. **Pattern Recognition & Loops**:
       - Analyze the TRACE. If you see repetitive actions (e.g., clicking row 1, then row 2, then row 3), DO NOT hardcode them.
       - Write a dynamic loop (e.g., finding all elements by a common class and iterating).

    3. **Flow Optimization**:
       - The Agent might have made mistakes or backtracked. Filter out these redundant steps.
       - Only include actions necessary to achieve the SOP.

    4. **Hybrid Automation (Web + Non-Web)**:
       - If the SOP says "Download Excel and filter it" or "Upload to GDrive":
       - Write the Selenium code to do the download.
       - Write the Python code (using pandas, requests, google-auth, etc.) to perform the filtering or uploading.
       - If exact APIs are unknown, write structured placeholder functions with clear TODO comments.

    5. **Code Quality**:
       - Use 'webdriver_manager' for driver setup.
       - Use 'WebDriverWait' and 'expected_conditions' for stability.
       - Use the specific CSS/XPath selectors found in the TRACE, but generalize them if inside a loop.
       - Include error handling (try/except) where appropriate.

    OUTPUT:
    - Return ONLY the Python code. Do not use markdown formatting (no \`\`\`).
    `;

    let code = '';

    if (provider === 'openai' && this.openai) {
        const completion = await this.openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                { role: "system", content: "You are a Python Code Generator." },
                { role: "user", content: prompt }
            ]
        });
        code = completion.choices[0].message.content || '';
    } else if (this.gemini) {
        const res = await this.gemini.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }]
        });
        code = res.response.text();
    } else {
        return "# Error: No AI provider configured for code generation.";
    }

    // Strip markdown if the LLM ignores instructions
    return code.replace(/```python|```/g, '').trim();
  }

  private generatePython(commands: ExecutionCommand[], startingUrl?: string): string {
    const testName = this.opts.testName ?? 'test_flow';
    const driverPath = this.opts.chromeDriverPath ?? 'C:\\\\hyprtask\\\\lib\\\\Chromium\\\\chromedriver.exe';

    // 1. ROBUST HEADER & SAFE_CLICK
    // We switched safe_click to use JS immediately if standard click fails,
    // and added scrollIntoView to handle headers covering elements.
    const header = [
      'from selenium import webdriver',
      'from selenium.webdriver.common.by import By',
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

        case 'type':
            rawBodyLines.push(
              `        elem = wait.until(EC.presence_of_element_located(${selectorCode}))`,
              `        safe_clear(elem)`,
              `        elem.send_keys("${(cmd.value ?? '').replace(/"/g, '\\"')}")`,
              '        time.sleep(0.5)'
            );
          break;

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