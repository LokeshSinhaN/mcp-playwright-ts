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

    const body: string[] = [];
    
    /**
     * Helper to determine selector strategy dynamically.
     * PRIORITY ORDER (production-ready, no hallucination):
     *   1. cmd.selectors.css (real selector captured from DOM)
     *   2. cmd.selectors.xpath (real XPath captured from DOM)
     *   3. cmd.selectors.id (element ID for #id selector)
     *   4. cmd.target (fallback - only if it looks like a valid selector)
     * 
     * This ensures we NEVER use hallucinated/guessed selectors when real
     * DOM-captured selectors are available.
     */
    const getSelectorCode = (cmd: ExecutionCommand): string => {
      // 1. Prefer real CSS selector from captured selectors
      if (cmd.selectors?.css && cmd.selectors.css.trim()) {
        const css = cmd.selectors.css;
        return `(By.CSS_SELECTOR, "${css.replace(/"/g, '\\"')}")`;
      }
      
      // 2. Prefer real XPath from captured selectors
      if (cmd.selectors?.xpath && cmd.selectors.xpath.trim()) {
        const xpath = cmd.selectors.xpath;
        return `(By.XPATH, "${xpath.replace(/"/g, '\\"')}")`;
      }
      
      // 3. Prefer ID-based selector if available
      if (cmd.selectors?.id && cmd.selectors.id.trim()) {
        return `(By.ID, "${cmd.selectors.id.replace(/"/g, '\\"')}")`;
      }
      
      // 4. Use semantic text with robust XPath (when we only have text, not a real selector)
      // This is better than blindly treating text as CSS
      if (cmd.selectors?.text && cmd.selectors.text.trim() && !cmd.selectors?.css && !cmd.selectors?.xpath) {
        const text = cmd.selectors.text.trim();
        const escaped = text.replace(/'/g, "\\'");
        // Generate a robust XPath that matches visible text or aria-label
        return `(By.XPATH, "//*[contains(normalize-space(text()), '${escaped}') or contains(@aria-label, '${escaped}') or @title='${escaped}']")`;
      }
      
      // 5. Fallback to target field (legacy/semantic)
      const target = cmd.target || '';
      
      // Handle XPath explicitly
      if (target.startsWith('xpath=') || target.startsWith('//') || target.startsWith('(//')) {
        const val = target.replace(/^xpath=/, '');
        return `(By.XPATH, "${val.replace(/"/g, '\\"')}")`;
      }
      
      // Handle Text pseudo-selector for robust matching
      if (target.startsWith('text=')) {
        const val = target.replace(/^text=/, '');
        return `(By.XPATH, "//*[contains(text(), '${val.replace(/'/g, "\\'")}')]")`;
      }
      
      // Detect if target looks like semantic text (not a valid CSS selector)
      // Valid CSS patterns: contains [, #, ., >, :, or starts with tag name followed by selector chars
      const looksLikeValidCss = /^[a-z]+[#.\[:]|^[#.\[]|^[a-z]+$/i.test(target.trim());
      
      if (!looksLikeValidCss && target.trim().length > 0) {
        // Convert semantic text to XPath text contains (last resort)
        const escaped = target.replace(/'/g, "\\'");
        console.warn(`[SeleniumGenerator] WARNING: Using semantic text fallback for "${target}". This may be unreliable.`);
        return `(By.XPATH, "//*[contains(normalize-space(text()), '${escaped}') or contains(@aria-label, '${escaped}')]")`;
      }
      
      // Default to CSS
      return `(By.CSS_SELECTOR, "${target.replace(/"/g, '\\"')}")`;
    };
    
    /**
     * Legacy wrapper for backward compatibility when only a string target is available.
     * Creates a minimal ExecutionCommand to pass through the priority logic.
     */
    const getSelectorCodeFromTarget = (target: string): string => {
      return getSelectorCode({ action: 'click', target } as ExecutionCommand);
    };

    for (const cmd of commands) {
      if (cmd.description) {
        body.push(`        # ${cmd.description.replace(/\n/g, ' ')}`);
      }

      const target = cmd.target || '';
      // Use the new priority-based selector resolver that prefers real DOM selectors
      const selectorCode = getSelectorCode(cmd);

      switch (cmd.action.toLowerCase()) {
        case 'navigate':
        case 'goto':
          body.push(`        driver.get("${target}")`);
          break;

        case 'click':
          // Validate we have a usable selector before generating code
          if (!cmd.selectors?.css && !cmd.selectors?.xpath && !cmd.selectors?.id && !target) {
            body.push(`        # WARNING: No valid selector captured for this click action`);
            body.push(`        # Original intent: ${cmd.description || 'unknown'}`);
          } else {
            body.push(
              `        elem = wait.until(EC.element_to_be_clickable(${selectorCode}))`,
              '        safe_click(driver, elem)'
            );
          }
          break;

        case 'type':
          if (!cmd.selectors?.css && !cmd.selectors?.xpath && !cmd.selectors?.id && !target) {
            body.push(`        # WARNING: No valid selector captured for this type action`);
          } else {
            body.push(
              `        elem = wait.until(EC.presence_of_element_located(${selectorCode}))`,
              `        elem.clear()`,
              `        elem.send_keys("${(cmd.value ?? '').replace(/"/g, '\\"')}")`
            );
          }
          break;
        
        case 'select_option': {
          // select_option should have been recorded as 2 click commands during execution.
          // If we still get a select_option here, it means the dropdown helper used
          // keyboard selection and we don't have a real selector.
          // Generate a robust fallback using aria-label or text matching.
          const optionValue = cmd.value || '';
          const escapedOption = optionValue.replace(/'/g, "\\'");
          body.push(
             `        # Dropdown option selection (fallback - prefer recording as 2 clicks)`,
             `        # Looking for option: "${optionValue}"`,
             `        elem = wait.until(EC.element_to_be_clickable((By.XPATH, "//*[@role='option' or @role='menuitem' or @role='listitem'][contains(normalize-space(.), '${escapedOption}')] | //li[contains(normalize-space(.), '${escapedOption}')] | //*[contains(@aria-label, '${escapedOption}')]")))`  ,
             '        safe_click(driver, elem)'
          );
          break;
        }

        case 'scrape':
        case 'examine':
        case 'scrape_data': {
          const intent = (cmd.description || '').toLowerCase();
          if (intent.includes('link') || intent.includes('href') || intent.includes('url')) {
            body.push(
              '        print("\\n--- Scraped Links ---")',
              '        links = driver.find_elements(By.TAG_NAME, "a")',
              '        for link in links:',
              '            href = link.get_attribute("href")',
              '            if href and href.startswith("http"):',
              '                print(href)',
              '        print("---------------------")'
            );
          } else {
            body.push(
              '        print("\\n--- Scraped Text ---")',
              '        print(driver.find_element(By.TAG_NAME, "body").text[:2000])',
              '        print("... (truncated) ...")'
            );
          }
          break;
        }

        case 'wait':
          body.push(`        time.sleep(${cmd.waitTime ?? 1})`);
          break;

        default:
          body.push(`        # Action "${cmd.action}" not fully implemented in generator`);
      }
      body.push('        time.sleep(1)');
    }

    const footer = [
      '    finally:',
      '        # input("Press Enter to close...")',
      '        driver.quit()',
      '',
      "if __name__ == '__main__':",
      `    ${testName}()`
    ];

    return [...header, ...body, ...footer].join('\n');
  }
}
