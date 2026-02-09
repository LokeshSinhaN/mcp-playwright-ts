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

  async generate(commands: ExecutionCommand[], startingUrl?: string, goal?: string): Promise<string> {
    return this.generatePython(commands, startingUrl, goal);
  }

  private async generatePython(commands: ExecutionCommand[], startingUrl?: string, goal?: string): Promise<string> {
    const testName = this.opts.testName ?? 'test_flow';
    const driverPath = this.opts.chromeDriverPath ?? 'C:\\\\hyprtask\\\\lib\\\\Chromium\\\\chromedriver.exe';
    const hasScrape = goal && goal.toLowerCase().includes('scrape');

    let code = `import time
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, ElementClickInterceptedException
${hasScrape ? 'import pandas as pd\n' : ''}

def safe_click(driver, selector_type, selector_value, wait_time=10):
    """
    Attempts to click an element by waiting for its presence,
    then trying a standard click followed by a JavaScript click if necessary.
    """
    try:
        # Using presence_of_element_located as per instructions
        element = WebDriverWait(driver, wait_time).until(
            EC.presence_of_element_located((selector_type, selector_value))
        )
        
        # Ensure element is in view
        driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", element)
        time.sleep(0.5)
        
        try:
            # Try standard Selenium click
            element.click()
        except (ElementClickInterceptedException, Exception):
            # Fallback to JavaScript click
            driver.execute_script("arguments[0].click();", element)
    except TimeoutException:
        print(f"Error: Element with {selector_type} '{selector_value}' not found within {wait_time}s.")
        raise

def ${testName}():
    """
    Main function to execute the automation flow based on the provided commands.
    """
    # Chrome WebDriver Setup
    chrome_driver_path = r"${driverPath}"
    service = Service(chrome_driver_path)
    options = Options()
    
    # Optional: Add arguments for stability
    options.add_argument("--start-maximized")
    options.add_argument("--disable-extensions")
    
    driver = webdriver.Chrome(service=service, options=options)
    
    try:
`;

    if (startingUrl) {
      code += `        driver.get("${startingUrl}")
        time.sleep(2)
`;
    }

    for (const cmd of commands) {
      if (cmd.action === 'navigate') {
        code += `        driver.get("${cmd.target}")
        time.sleep(2)
`;
      } else if (cmd.action === 'click') {
        const sel = cmd.selectors;
        let selectorType = 'By.XPATH';
        let selectorValue = `"//*[contains(text(), '${sel?.text || cmd.target}')]`;
        if (sel?.css) {
          selectorType = 'By.CSS_SELECTOR';
          selectorValue = `"${sel.css}"`;
        } else if (sel?.xpath) {
          selectorType = 'By.XPATH';
          selectorValue = `"${sel.xpath}"`;
        } else if (sel?.id) {
          selectorType = 'By.ID';
          selectorValue = `"${sel.id}"`;
        }
        code += `        # Action: ${cmd.description || 'click'}
        safe_click(driver, ${selectorType}, ${selectorValue})
`;
      } else if (cmd.action === 'type') {
        const sel = cmd.selectors;
        let selectorType = 'By.CSS_SELECTOR';
        let selectorValue = `"${sel?.css || sel?.xpath || '#' + sel?.id}"`;
        if (sel?.xpath) {
          selectorType = 'By.XPATH';
          selectorValue = `"${sel.xpath}"`;
        } else if (sel?.id) {
          selectorType = 'By.ID';
          selectorValue = `"${sel.id}"`;
        }
        code += `        # Action: ${cmd.description || 'type'}
        element = WebDriverWait(driver, 10).until(EC.presence_of_element_located((${selectorType}, ${selectorValue})))
        element.clear()
        element.send_keys("${cmd.value}")
`;
      } else if (cmd.action === 'wait') {
        code += `        time.sleep(${cmd.waitTime || 1})
`;
      }
    }

    if (hasScrape) {
      code += `
        # Scrape the data
        data = []
        try:
            items = driver.find_elements(By.CSS_SELECTOR, '.member-item, .directory-item, li, .result')
            for item in items:
                name = item.find_element(By.CSS_SELECTOR, '.name, h3, .business-name').text if item.find_elements(By.CSS_SELECTOR, '.name, h3, .business-name') else ''
                address = item.find_element(By.CSS_SELECTOR, '.address').text if item.find_elements(By.CSS_SELECTOR, '.address') else ''
                city = item.find_element(By.CSS_SELECTOR, '.city').text if item.find_elements(By.CSS_SELECTOR, '.city') else ''
                state = item.find_element(By.CSS_SELECTOR, '.state').text if item.find_elements(By.CSS_SELECTOR, '.state') else ''
                zip_code = item.find_element(By.CSS_SELECTOR, '.zip').text if item.find_elements(By.CSS_SELECTOR, '.zip') else ''
                website = item.find_element(By.CSS_SELECTOR, 'a').get_attribute('href') if item.find_elements(By.CSS_SELECTOR, 'a') else ''
                data.append({'Business Name': name, 'Address': address, 'City': city, 'State': state, 'Zip Code': zip_code, 'Website': website})
        except Exception as e:
            print(f"Error scraping: {e}")
        # Save to Excel
        df = pd.DataFrame(data)
        df.to_excel('scraped_data.xlsx', index=False)
        print("Data saved to scraped_data.xlsx")
`;
    }

    code += `
        print("Task completed successfully.")
    except Exception as e:
        print(f"An error occurred during the execution flow: {e}")
    
    finally:
        # Cleanup block to ensure browser closes
        print("Closing the browser...")
        time.sleep(3)
        driver.quit()

if __name__ == "__main__":
    # Ensure dependencies are available: 
    # pip install selenium${hasScrape ? ' pandas openpyxl' : ''}
    ${testName}()
`;

    return code;
  }
}
