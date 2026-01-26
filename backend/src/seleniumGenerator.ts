import { GenerativeModel } from '@google/generative-ai';
import { ExecutionCommand } from './types';

export class SeleniumGenerator {
  constructor(
    private readonly opts: {
      language?: 'python';
      testName?: string;
      chromeDriverPath?: string;
    } = {},
    private readonly model?: GenerativeModel,
  ) {}

  generate(commands: ExecutionCommand[], startingUrl?: string): string {
    return this.generatePython(commands, startingUrl);
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
      'from selenium.common.exceptions import ElementClickInterceptedException, TimeoutException, StaleElementReferenceException',
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
              `        elem.clear()`,
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