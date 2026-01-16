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
    
    // Helper to determine selector strategy dynamically
    const getSelectorCode = (target: string) => {
      // 1. Handle XPath explicitly
      if (target.startsWith('xpath=') || target.startsWith('//') || target.startsWith('(')) {
        const val = target.replace(/^xpath=/, '');
        return `(By.XPATH, "${val.replace(/"/g, '\\"')}")`;
      }
      // 2. Handle Text (pseudo-selector for robust matching)
      if (target.startsWith('text=')) {
        const val = target.replace(/^text=/, '');
        return `(By.XPATH, "//*[contains(text(), '${val.replace(/'/g, "\\'")}')]")`;
      }
      // 3. Default to CSS
      return `(By.CSS_SELECTOR, "${target.replace(/"/g, '\\"')}")`;
    };

    for (const cmd of commands) {
      if (cmd.description) {
        body.push(`        # ${cmd.description.replace(/\n/g, ' ')}`);
      }

      const target = cmd.target || '';
      const selectorCode = getSelectorCode(target);

      switch (cmd.action.toLowerCase()) {
        case 'navigate':
        case 'goto':
          body.push(`        driver.get("${target}")`);
          break;

        case 'click':
          body.push(
            `        elem = wait.until(EC.element_to_be_clickable(${selectorCode}))`,
            '        safe_click(driver, elem)'
          );
          break;

        case 'type':
          body.push(
            `        elem = wait.until(EC.presence_of_element_located(${selectorCode}))`,
            `        elem.clear()`,
            `        elem.send_keys("${(cmd.value ?? '').replace(/"/g, '\\"')}")`
          );
          break;
        
        case 'select_option': 
          // Fallback if the recording didn't catch the 2-step click
          body.push(
             `        # Fallback for select_option: Click element with text "${cmd.value}"`,
             `        elem = wait.until(EC.element_to_be_clickable((By.XPATH, "//*[contains(text(), '${cmd.value}')]")))`,
             '        safe_click(driver, elem)'
          );
          break;

        case 'scrape':
        case 'examine':
        case 'scrape_data': // Support all variations
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
