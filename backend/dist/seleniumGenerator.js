"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SeleniumGenerator = void 0;
class SeleniumGenerator {
    constructor(opts = {}) {
        this.opts = opts;
    }
    generate(commands) {
        const language = this.opts.language ?? 'python';
        if (language !== 'python') {
            throw new Error('Only python generation implemented here');
        }
        return this.generatePython(commands);
    }
    generatePython(commands) {
        const testName = this.opts.testName ?? 'test_automation';
        const driverPath = this.opts.chromeDriverPath ?? 'C:\\\\hyprtask\\\\lib\\\\Chromium\\\\chromedriver.exe';
        const header = [
            'from selenium import webdriver',
            'from selenium.webdriver.common.by import By',
            'from selenium.webdriver.support.ui import WebDriverWait',
            'from selenium.webdriver.support import expected_conditions as EC',
            'import time',
            '',
            `def ${testName}():`,
            `    options = webdriver.ChromeOptions()`,
            `    # options.add_argument('--headless')  # if needed`,
            `    driver = webdriver.Chrome(executable_path=r'${driverPath}', options=options)`,
            `    wait = WebDriverWait(driver, 10)`,
            '    try:'
        ];
        const body = [];
        for (const cmd of commands) {
            switch (cmd.action.toLowerCase()) {
                case 'navigate':
                case 'goto':
                    body.push(`        driver.get("${cmd.target}")`);
                    break;
                case 'click':
                    body.push(`        elem = wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR, "${cmd.target}")))`, '        elem.click()');
                    break;
                case 'type':
                    body.push(`        elem = wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "${cmd.target}")))`, `        elem.clear()`, `        elem.send_keys("${(cmd.value ?? '').replace(/"/g, '\\"')}")`);
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
exports.SeleniumGenerator = SeleniumGenerator;
//# sourceMappingURL=seleniumGenerator.js.map