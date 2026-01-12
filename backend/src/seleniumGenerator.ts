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
   * Generate Python Selenium code using the injected LLM for rich, commented,
   * production-style scripts. Falls back to the template-based generator when
   * no model is configured or the model call fails.
   */
  async generateWithLLM(commands: ExecutionCommand[]): Promise<string> {
    if (!this.model) {
      return this.generate(commands);
    }

    const stepManifestLines: string[] = [];
    commands.forEach((cmd, index) => {
      const stepNo = index + 1;
      const description = (cmd.description || cmd.target || '').replace(/"/g, '\\"');
      const sel = cmd.selectors || {};
      const id = sel.id ?? '';
      const css = sel.css ?? (cmd.target || '');
      const xpath = sel.xpath ?? '';
      const text = sel.text ?? '';

      const parts: string[] = [];
      parts.push(`Step ${stepNo}: Action="${cmd.action}"`);
      if (description) parts.push(`Description="${description}"`);
      if (id) parts.push(`Id="${id}"`);
      if (css) parts.push(`CssSelector="${css}"`);
      if (xpath) parts.push(`Xpath="${xpath}"`);
      if (text) parts.push(`Text="${text.replace(/"/g, '\\"')}"`);
      if (cmd.value && (cmd.action === 'type')) {
        parts.push(`Value="${String(cmd.value).slice(0, 80).replace(/"/g, '\\"')}"`);
      }

      stepManifestLines.push(parts.join(', '));
    });

    const stepManifest = stepManifestLines.join('\n');

    const testName = this.opts.testName ?? 'test_automation';
    const driverPath = this.opts.chromeDriverPath ?? 'C:\\\\hyprtask\\\\lib\\\\Chromium\\\\chromedriver.exe';

    const prompt = [
      'You are an expert QA Automation Engineer.',
      '',
      'Task: Convert the following execution steps into a robust, production-ready Python Selenium script.',
      '',
      'STRICT CONSTRAINTS (follow all):',
      '- You MUST treat the provided selectors as the single source of truth.',
      '- For each step, use the provided Id, CssSelector, and Xpath exactly as written. Do not invent, modify, or guess any selectors.',
      '- If an Id is provided in a step, prefer using By.ID with that exact Id.',
      '- Otherwise, when a CssSelector is provided, use By.CSS_SELECTOR with that exact selector.',
      '- Only when neither Id nor CssSelector is available, use By.XPATH with the provided Xpath.',
      '- Do NOT rewrite CSS selectors or XPaths (no trimming, reformatting, or simplification).',
      '- Do NOT introduce selectors that are not explicitly present in the step manifest.',
      '',
      'Code quality requirements:',
      `- Implement a function named ${testName}() that drives the browser.`,
      '- Use WebDriverWait for all interactions (clicks and typing). Do NOT rely on bare time.sleep for readiness.',
      '- Include concise comments above or beside each major interaction, derived from the Description field of the corresponding step.',
      '- Use a reusable helper function inject_cookies(driver, raw_cookies_json) stub so cookies can be injected by the caller.',
      '- Use a Chrome WebDriver with the given driver path.',
      '',
      'Driver path to use literally in the script:',
      driverPath,
      '',
      'STEP MANIFEST:',
      stepManifest,
      '',
      'Now generate ONLY the final Python code (no Markdown, no explanations).',
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

      const text = (result as any).response?.text?.() ?? '';
      const cleaned = text
        // Strip Markdown fences if the model ignored the "no Markdown" rule.
        .replace(/```[a-zA-Z]*[\s\S]*?```/g, (block: string) =>
          block.replace(/```[a-zA-Z]*\n?/, '').replace(/```$/, ''),
        )
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
