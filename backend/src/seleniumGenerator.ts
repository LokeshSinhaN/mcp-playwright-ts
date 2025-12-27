import { ExecutionCommand } from './types';

export class SeleniumGenerator {
  constructor(
    private readonly opts: {
      language?: 'python';
      testName?: string;
      chromeDriverPath?: string;
    } = {}
  ) {}

  generate(commands: ExecutionCommand[]): string {
    const language = this.opts.language ?? 'python';
    if (language !== 'python') {
      throw new Error('Only python generation implemented here');
    }
    return this.generatePython(commands);
  }

  private generatePython(commands: ExecutionCommand[]): string {
    const testName = this.opts.testName ?? 'test_automation';
    const driverPath = this.opts.chromeDriverPath ?? 'C:\\\\hyprtask\\\\lib\\\\Chromium\\\\chromedriver.exe';

    const header = [
      'from selenium import webdriver',
      'from selenium.webdriver.common.by import By',
      'from selenium.webdriver.support.ui import WebDriverWait',
      'from selenium.webdriver.support import expected_conditions as EC',
      'import json',
      'import time',
      '',
      'def inject_cookies(driver, raw_cookies_json):',
      '    """Inject cookies given a raw JSON string dumped from the browser.',
      '',
      '    The JSON is expected to be a list of cookie dicts in the standard',
      '    Selenium/add_cookie format. This keeps cookie handling explicit and',
      '    reusable across generated scripts without having to edit the core',
      '    test body. Pass the raw JSON string through your prompt context or',
      '    load it from disk before calling this function.',
      '    """',
      '    cookies = json.loads(raw_cookies_json)',
      '    for c in cookies:',
      '        driver.add_cookie(c)',
      '',
      `def ${testName}():`,
      `    options = webdriver.ChromeOptions()`,
      `    # options.add_argument('--headless')  # if needed`,
      `    driver = webdriver.Chrome(executable_path=r'${driverPath}', options=options)`,
      `    wait = WebDriverWait(driver, 10)`,
      '    try:'
    ];

    const body: string[] = [];
    for (const cmd of commands) {
      switch (cmd.action.toLowerCase()) {
        case 'navigate':
        case 'goto':
          body.push(`        driver.get("${cmd.target}")`);
          break;
        case 'click':
          body.push(
            `        elem = wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR, "${cmd.target}")))`,
            '        elem.click()'
          );
          break;
        case 'type':
          body.push(
            `        elem = wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "${cmd.target}")))`,
            `        elem.clear()`,
            `        elem.send_keys("${(cmd.value ?? '').replace(/"/g, '\\"')}")`
          );
          break;
        case 'wait':
          body.push(`        time.sleep(${cmd.waitTime ?? 1})`);
          break;
        default:
          body.push(`        # TODO: implement action "${cmd.action}"`);
      }
    }

    const footer = [
      '    finally:',
      '        driver.quit()',
      '',
      "if __name__ == '__main__':",
      `    ${testName}()`
    ];

    return [...header, ...body, ...footer].join('\n');
  }
}
