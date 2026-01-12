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
    const language = this.opts.language ?? 'python';
    if (language !== 'python') {
      throw new Error('Only python generation implemented here');
    }
    return this.generatePython(commands);
  }

  /**
   * Generate Python Selenium code using the injected LLM, using a strictly
   * formatted step manifest so the model cannot "guess" selector strategies.
   * Falls back to the template-based generator when no model is configured or
   * the model call fails.
   */
  async generateWithLLM(commands: ExecutionCommand[]): Promise<string> {
    if (!this.model) {
      return this.generate(commands);
    }

    // 1. Build a strict manifest of steps with explicit selector details.
    const stepsContext = commands
      .map((cmd, index) => {
        const stepNum = index + 1;
        const description = cmd.description || 'Perform action';
        const value = cmd.value ?? 'None';

        let selectorInfo = 'No selectors (Navigation, Wait, or Examine step)';
        if (cmd.selectors) {
          const css = cmd.selectors.css || 'N/A';
          const xpath = cmd.selectors.xpath || 'N/A';
          const id = cmd.selectors.id || 'N/A';
          const text = cmd.selectors.text || '';

          selectorInfo = [
            `- Available CSS: ${css}`,
            `- Available XPath: ${xpath}`,
            `- Available ID: ${id}`,
            `- Target Text: "${text}"`,
          ].join('\n');
        }

        return [
          `### STEP ${stepNum}:`,
          `Action: ${cmd.action}`,
          `Description: ${description}`,
          `Input Value: ${value}`,
          'SELECTORS (STRICT USE ONLY):',
          selectorInfo,
          '---------------------------------------------------',
        ].join('\n');
      })
      .join('\n');

    const testName = this.opts.testName ?? 'test_automation';
    const driverPath = this.opts.chromeDriverPath ?? 'C:\\\\hyprtask\\\\lib\\\\Chromium\\\\chromedriver.exe';

    // 2. Anti-hallucination prompt.
    const prompt = [
      'You are a Senior QA Automation Engineer. I need a robust Python Selenium script based on the execution log below.',
      '',
      '### CRITICAL RULES (Follow these exactly):',
      '1. SELECTOR SAFETY:',
      '   - If the "Available CSS" value starts with "//" or "/", treat it as an XPath and use By.XPATH, not By.CSS_SELECTOR.',
      '   - If you use the XPath string, you MUST use By.XPATH.',
      '   - If you use the CSS string, you MUST use By.CSS_SELECTOR.',
      '   - NEVER put an XPath string inside By.CSS_SELECTOR.',
      '   - Do NOT invent new selectors; only use the ones listed in the SELECTORS block for each step.',
      '',
      '2. VISIBILITY / DEMO FRIENDLINESS:',
      '   - The user wants to SEE the bot working.',
      '   - Add time.sleep(2) after every action (navigate, click, type, scroll, examine).',
      '   - At the very end of the script, add: input("Press Enter to close the browser...") so the browser window stays open.',
      '',
      '3. ROBUSTNESS:',
      '   - Always use WebDriverWait(driver, 10) before interacting with elements.',
      '   - Use proper By strategy for each selector as per the SELECTOR SAFETY rules.',
      '',
      '4. DRIVER SETUP (MANDATORY PATTERN):',
      '   - Use this exact pattern for the driver setup (with the given driver path):',
      '       from selenium.webdriver.chrome.service import Service',
      `       service = Service(r'${driverPath}')`,
      '       options = webdriver.ChromeOptions()',
      "       driver = webdriver.Chrome(service=service, options=options)",
      '',
      '5. COOKIES HELPER:',
      '   - Include an inject_cookies(driver, raw_cookies_json) helper that loops over json.loads(raw_cookies_json) and calls driver.add_cookie.',
      '',
      '### EXECUTION LOG (SOURCE OF TRUTH):',
      stepsContext,
      '',
      '### OUTPUT FORMAT:',
      `- Implement a function named ${testName}() that performs the steps in order.`,
      '- Return ONLY valid Python code (no Markdown, no backticks).',
      '- Include all necessary imports (webdriver, By, WebDriverWait, expected_conditions as EC, Service, json, time).',
      '- Follow all CRITICAL RULES strictly.',
    ].join('\n');

    try {
      const result = await this.model.generateContent({
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }],
          },
        ],
      } as any);

      const raw = (result as any).response?.text?.() ?? '';
      const cleaned = raw
        .replace(/```python/g, '')
        .replace(/```/g, '')
        .trim();

      return cleaned || this.generatePython(commands);
    } catch (err) {
      console.warn('SeleniumGenerator.generateWithLLM failed, falling back to template generator:', err);
      return this.generatePython(commands);
    }
  }

  private generatePython(commands: ExecutionCommand[]): string {
    const testName = this.opts.testName ?? 'test_automation';
    const driverPath = this.opts.chromeDriverPath ?? 'C:\\\\hyprtask\\\\lib\\\\Chromium\\\\chromedriver.exe';

    const header = [
      'from selenium import webdriver',
      'from selenium.webdriver.common.by import By',
      'from selenium.webdriver.support.ui import WebDriverWait',
      'from selenium.webdriver.support import expected_conditions as EC',
      'from selenium.webdriver.chrome.service import Service',
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
      `    service = Service(r'${driverPath}')`,
      `    driver = webdriver.Chrome(service=service, options=options)`,
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
