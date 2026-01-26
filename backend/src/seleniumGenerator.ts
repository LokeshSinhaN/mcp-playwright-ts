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

  generate(commands: ExecutionCommand[]): string {
    return this.generatePython(commands);
  }

  private generatePython(commands: ExecutionCommand[]): string {
    const testName = this.opts.testName ?? 'test_flow';
    const driverPath = this.opts.chromeDriverPath ?? 'C:\\\\hyprtask\\\\lib\\\\Chromium\\\\chromedriver.exe';

    const header = [
      'from selenium import webdriver',
      'from selenium.webdriver.common.by import By',
      'from selenium.webdriver.support.ui import WebDriverWait',
      'from selenium.webdriver.support import expected_conditions as EC',
      'from selenium.webdriver.chrome.service import Service',
      'from selenium.common.exceptions import ElementClickInterceptedException, TimeoutException',
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
      '    """Robust click that handles obstructions and overlays automatically."""',
      '    try:',
      '        element.click()',
      '    except (ElementClickInterceptedException, TimeoutException):',
      '        print("    ! Standard click intercepted/failed, attempting JS click...")',
      '        driver.execute_script("arguments[0].click();", element)',
      '',
      `def ${testName}():`,
      `    options = webdriver.ChromeOptions()`,
      `    options.add_argument('--start-maximized')`,
      `    # options.add_argument('--headless')`,
      `    service = Service(r'${driverPath}')`,
      `    driver = webdriver.Chrome(service=service, options=options)`,
      `    wait = WebDriverWait(driver, 15)`,
      '    try:'
    ];
    
    // We will build the body into a list first, then clean it.
    const rawBodyLines: string[] = [];

    const getSelectorCode = (cmd: ExecutionCommand): string => {
       // 1. Prefer real CSS (Best for unique IDs)
      if (cmd.selectors?.css && cmd.selectors.css.trim().length > 2) {
        return `(By.CSS_SELECTOR, "${cmd.selectors.css.replace(/"/g, '\\"')}")`;
      }
      
      // 2. Prefer real XPath (Robust for structure)
      if (cmd.selectors?.xpath && cmd.selectors.xpath.trim().length > 2) {
        return `(By.XPATH, "${cmd.selectors.xpath.replace(/"/g, '\\"')}")`;
      }
      
      // 3. Prefer ID (Fastest)
      if (cmd.selectors?.id && cmd.selectors.id.trim()) {
        return `(By.ID, "${cmd.selectors.id.replace(/"/g, '\\"')}")`;
      }
      
      // 4. UNIVERSAL FALLBACK: Text-based XPath
      // FIX: Ensure we don't treat CSS selectors (starting with # or .) as visible text.
      // This prevents the bug: contains(text(), "#ctl00_...")
      const textHint = cmd.selectors?.text || cmd.description?.replace(/^Click\s+/i, '') || cmd.target;
      
      const isLikelySelector = textHint && (
          textHint.trim().startsWith('#') || 
          textHint.trim().startsWith('.') || 
          textHint.includes('>') ||
          textHint.includes('ctl00') 
      );

      if (textHint && !textHint.includes('el_') && !textHint.includes('xpath=') && !isLikelySelector) {
          const safeText = textHint.trim().replace(/'/g, "\\'");
          // Matches text OR aria-label OR title
          return `(By.XPATH, "//*[contains(text(), '${safeText}') or contains(@aria-label, '${safeText}') or @title='${safeText}']")`;
      }

      // 5. Raw Target Fallback (Valid CSS/XPath)
      const target = cmd.target || '';
      if (target.startsWith('//') || target.startsWith('xpath=')) {
          return `(By.XPATH, "${target.replace(/^xpath=/, '').replace(/"/g, '\\"')}")`;
      }

      // Default to CSS for everything else (IDs, classes)
      return `(By.CSS_SELECTOR, "${target.replace(/"/g, '\\"')}")`;
    };

    for (const cmd of commands) {
      // SKIP INVALID COMMANDS
      if (['click', 'type'].includes(cmd.action) && 
          !cmd.selectors?.css && !cmd.selectors?.xpath && !cmd.selectors?.id && !cmd.target) {
          continue; 
      }

      // COMMENT GENERATION
      if (cmd.description && !cmd.description.startsWith('Start at')) {
        rawBodyLines.push(`        # ${cmd.description.replace(/\n/g, ' ')}`);
      }

      const selectorCode = getSelectorCode(cmd);

      switch (cmd.action.toLowerCase()) {
        case 'navigate':
        case 'goto':
          rawBodyLines.push(`        driver.get("${cmd.target}")`);
          rawBodyLines.push(`        time.sleep(2)`); 
          break;

        case 'click':
            rawBodyLines.push(
              `        elem = wait.until(EC.element_to_be_clickable(${selectorCode}))`,
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
          // FIX: Handle NaN or undefined wait times
          const t = (cmd.waitTime && !isNaN(cmd.waitTime)) ? cmd.waitTime : 1;
          rawBodyLines.push(`        time.sleep(${t})`);
          break;
      }
    }

    // INTELLIGENT CODE CLEANUP (Deduplication)
    // We remove consecutive identical blocks to fix the "Click Reports 3x" issue
    const cleanBody: string[] = [];
    let lastBlockSignature = '';

    for (let i = 0; i < rawBodyLines.length; i++) {
        const line = rawBodyLines[i];
        
        // Identify the start of a block (usually "elem = ...")
        if (line.trim().startsWith('elem =')) {
            // Construct a "signature" of this action block (next 3 lines usually)
            const signature = line + (rawBodyLines[i+1] || '') + (rawBodyLines[i+2] || '');
            
            if (signature === lastBlockSignature) {
                // Duplicate block detected! Skip the lines associated with it.
                // We skip lines until we hit a sleep or comment
                while(i < rawBodyLines.length && !rawBodyLines[i].includes('time.sleep')) {
                    i++;
                }
                continue; 
            }
            lastBlockSignature = signature;
        }
        
        cleanBody.push(line);
    }

    const footer = [
      '    finally:',
      '        # input("Press Enter to close...")',
      '        driver.quit()',
      '',
      "if __name__ == '__main__':",
      `    ${testName}()`
    ];
    return [...header, ...cleanBody, ...footer].join('\n');
  }
}
