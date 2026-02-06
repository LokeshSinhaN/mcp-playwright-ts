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
      'from selenium.webdriver.common.keys import Keys',
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
      'def scrape_data(driver, instruction):',
      '    """Scrape data from the page based on instruction."""',
      '    try:',
      '        results = []',
      '        # Wait for page to load completely',
      '        time.sleep(3)',
      '        WebDriverWait(driver, 30).until(lambda d: d.execute_script("return document.readyState") == "complete")',
      '        ',
      '        # Try multiple generic selector patterns for data listings',
      '        selectors = [',
      '            "article, .card, .item, [class*=\\\'item\\\'], [class*=\\\'card\\\']",',
      '            "div[class*=\\\'result\\\'], div[class*=\\\'item\\\'], .result, .item",',
      '            "[class*=\\\'entry\\\'], [class*=\\\'post\\\'], .entry, .post",',
      '            "li, .list-item, [class*=\\\'list\\\']"',
      '        ]',
      '        data_elements = []',
      '        for sel in selectors:',
      '            try:',
      '                elems = driver.find_elements(By.CSS_SELECTOR, sel)',
      '                if elems and len(elems) > 1:',
      '                    data_elements = elems',
      '                    break',
      '            except:',
      '                continue',
      '        ',
      '        # If no specific selectors work, try to find repeating elements',
      '        if not data_elements:',
      '            all_divs = driver.find_elements(By.TAG_NAME, "div")',
      '            class_counts = {}',
      '            for div in all_divs:',
      '                cls = div.get_attribute("class")',
      '                if cls:',
      '                    class_counts[cls] = class_counts.get(cls, 0) + 1',
      '            for cls, count in class_counts.items():',
      '                if count > 2:',
      '                    try:',
      '                        data_elements = driver.find_elements(By.CSS_SELECTOR, f".{cls}")',
      '                        if len(data_elements) > 1:',
      '                            break',
      '                    except:',
      '                        continue',
      '        ',
      '        for element in data_elements:',
      '            try:',
      '                data = {}',
      '                # Extract common fields with multiple selector attempts',
      '                name_selectors = ["h1, h2, h3, h4, h5, h6", ".title, [class*=\'title\']", ".name, [class*=\'name\']", "strong, b", "a"]',
      '                for sel in name_selectors:',
      '                    name_elem = element.find_elements(By.CSS_SELECTOR, sel)',
      '                    if name_elem and name_elem[0].text.strip():',
      '                        data["name"] = name_elem[0].text.strip()',
      '                        break',
      '                ',
      '                place_selectors = [".address, .location, [class*=\'address\'], [class*=\'location\']", ".city, .state, .zip, [class*=\'city\'], [class*=\'state\']", "p, span, div"]',
      '                for sel in place_selectors:',
      '                    place_elem = element.find_elements(By.CSS_SELECTOR, sel)',
      '                    if place_elem and place_elem[0].text.strip():',
      '                        text = place_elem[0].text.strip()',
      '                        # Check if it looks like an address (contains commas or numbers)',
      '                        if "," in text or any(char.isdigit() for char in text):',
      '                            data["place"] = text',
      '                            break',
      '                ',
      '                phone_selectors = [".phone, [class*=\'phone\']", "a[href*=\'tel:\']", "span, p, div"]',
      '                for sel in phone_selectors:',
      '                    phone_elem = element.find_elements(By.CSS_SELECTOR, sel)',
      '                    if phone_elem and phone_elem[0].text.strip():',
      '                        text = phone_elem[0].text.strip()',
      '                        # Check if it contains phone-like patterns',
      '                        if any(char.isdigit() for char in text) and ("(" in text or ")" in text or "-" in text):',
      '                            data["phone"] = text',
      '                            break',
      '                ',
      '                website_selectors = ["a[href*=\'http\']", "a:not([href*=\'tel:\'])", ".website, [class*=\'website\']"]',
      '                for sel in website_selectors:',
      '                    website_elem = element.find_elements(By.CSS_SELECTOR, sel)',
      '                    if website_elem:',
      '                        href = website_elem[0].get_attribute("href")',
      '                        if href and "http" in href and "tel:" not in href and "javascript:" not in href:',
      '                            data["website"] = href',
      '                            break',
      '                ',
      '                if data: results.append(data)',
      '            except:',
      '                continue',
      '        ',
      '        # Save to CSV if data found',
      '        if results:',
      '            import csv',
      '            with open("scraped_data.csv", "w", newline="", encoding="utf-8") as f:',
      '                if results:',
      '                    writer = csv.DictWriter(f, fieldnames=results[0].keys())',
      '                    writer.writeheader()',
      '                    writer.writerows(results)',
      '            print(f"Scraped {len(results)} records and saved to scraped_data.csv")',
      '        else:',
      '            print("No data found to scrape")',
      '        ',
      '        return results',
      '    except Exception as e:',
      '        print(f"Scraping failed: {e}")',
      '        import traceback',
      '        traceback.print_exc()',
      '        return []',
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

    // 3. GENERATE BODY - Ensure navigation comes first
    let hasNavigation = false;
    let scrapedData: any[] = [];

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
              hasNavigation = true;
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
            // Special handling for dropdown selections - generate multiple attempts like working demo.py
            if (cmd.description && cmd.description.toLowerCase().includes('dropdown')) {
              // Generate 3 type attempts for dropdown selections (matching working demo.py pattern)
              for (let i = 0; i < 3; i++) {
                rawBodyLines.push(
                  `        elem = wait.until(EC.presence_of_element_located(${selectorCode}))`,
                  `        safe_clear(elem)`,
                  `        elem.send_keys("${(cmd.value ?? '').replace(/"/g, '\\"')}")`,
                  '        time.sleep(0.5)'
                );
              }
            } else {
              rawBodyLines.push(
                `        elem = wait.until(EC.presence_of_element_located(${selectorCode}))`,
                `        safe_clear(elem)`,
                `        elem.send_keys("${(cmd.value ?? '').replace(/"/g, '\\"')}")`,
                '        time.sleep(0.5)'
              );
            }
          break;

        case 'examine':
          // Handle scraping commands
          if (cmd.description && cmd.description.toLowerCase().includes('scrape data')) {
            const instruction = cmd.description.replace(/^Scrape data:\s*/i, '');
            rawBodyLines.push(
              `        # Scrape data: ${instruction}`,
              `        scraped_data = scrape_data(driver, "${instruction.replace(/"/g, '\\"')}")`,
              `        print("Scraped data:", scraped_data)`,
              `        # Save scraped data to CSV`,
              `        if scraped_data:`,
              `            import csv`,
              `            with open('scraped_data.csv', 'w', newline='', encoding='utf-8') as csvfile:`,
              `                if scraped_data:`,
              `                    fieldnames = scraped_data[0].keys()`,
              `                    writer = csv.DictWriter(csvfile, fieldnames=fieldnames)`,
              `                    writer.writeheader()`,
              `                    writer.writerows(scraped_data)`,
              `            print(f"Saved {len(scraped_data)} records to scraped_data.csv")`
            );
          }
          break;

        case 'wait':
          const t = (cmd.waitTime && !isNaN(cmd.waitTime)) ? cmd.waitTime : 1;
          // Cap max wait to 2s to keep tests fast
          const safeWait = Math.min(t, 2);
          if (safeWait > 0.1) rawBodyLines.push(`        time.sleep(${safeWait})`);
          break;
      }
    }

    // If no navigation was added and we have a starting URL, add it at the beginning
    if (!hasNavigation && startingUrl) {
      const navLines = [
        `        # Navigate to Initial URL`,
        `        driver.get("${startingUrl}")`,
        `        time.sleep(3)`
      ];
      rawBodyLines.unshift(...navLines);
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