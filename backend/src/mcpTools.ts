import { GenerativeModel } from '@google/generative-ai';
import { BrowserManager } from './browserManager';
import { SelectorExtractor } from './selectorExtractor';
import { SeleniumGenerator } from './seleniumGenerator';
import {
  ExecutionCommand,
  ExecutionResult,
  ElementInfo,
  AgentAction,
  AgentStepResult,
  AgentSessionResult,
  AgentConfig,
} from './types';
import { selectFromDropdown, selectOptionInOpenDropdown, parseDropdownInstruction, DropdownIntent } from './dropdownUtils';

export class McpTools {
  private sessionHistory: ExecutionCommand[] = [];

  constructor(private readonly browser: BrowserManager, private readonly model?: GenerativeModel) {}

  async navigate(url: string): Promise<ExecutionResult> {
    await this.browser.init();
    await this.browser.goto(url);

    // Record a high-level navigation step; description is the raw URL or prompt.
    this.sessionHistory.push({
      action: 'navigate',
      target: url,
      description: url,
    });

    // Best-effort cookie/consent banner handling so subsequent
    // clicks (e.g. LOGIN, ACCEPT) are less likely to time out.
    await this.browser.handleCookieBanner();

    const screenshot = await this.browser.screenshot();
    return { success: true, message: `Navigated to ${url}`, screenshot };
  }

/**
   * Use the injected LLM to select the best element to click based on the
   * user's natural-language request. Tiered flow:
   *   1) LLM selection over sanitized elements.
   *   2) Heuristic fallback when the LLM is unavailable, fails, or is
   *      ambiguous.
   */
  async click(target: string): Promise<ExecutionResult> {
    // First, detect natural-language dropdown selection intents such as:
    //   "Click on the Contact us drop down button and select Facebook option" or
    //   "select the 'Payment Posting' from the drop down menu".
    // When detected, we handle the interaction using a robust, keyboard-aware
    // helper instead of trying to treat the request as a single "click" on a
    // specific option element.
    const dropdownIntent: DropdownIntent | null = parseDropdownInstruction(target);
    if (dropdownIntent) {
      try {
        await this.browser.init();
        const page = this.browser.getPage();
        
        let message: string;

        if (dropdownIntent.kind === 'open-and-select') {
          await selectFromDropdown(page, dropdownIntent.dropdownLabel, dropdownIntent.optionLabel);

          // Record this as two high-level steps for downstream Selenium
          // generation: open dropdown (click) + select via keyboard.
          this.sessionHistory.push(
            {
              action: 'click',
              target: dropdownIntent.dropdownLabel,
              description: `Open dropdown "${dropdownIntent.dropdownLabel}"`,
            },
            {
              action: 'type',
              target: dropdownIntent.dropdownLabel,
              value: dropdownIntent.optionLabel,
              description: `Select option "${dropdownIntent.optionLabel}" from dropdown "${dropdownIntent.dropdownLabel}"`,
            },
          );

          message = `Selected option "${dropdownIntent.optionLabel}" from dropdown "${dropdownIntent.dropdownLabel}"`;
        } else {
          // Dropdown already open; just select the option.
          await selectOptionInOpenDropdown(page, dropdownIntent.optionLabel);

          this.sessionHistory.push({
            action: 'type',
            target: 'dropdown-option',
            value: dropdownIntent.optionLabel,
            description: `Select option "${dropdownIntent.optionLabel}" from currently open dropdown`,
          });

          message = `Selected option "${dropdownIntent.optionLabel}" from the currently open dropdown`;
        }

        const screenshot = await this.browser.screenshot();
        return {
          success: true,
          message,
          screenshot,
        };
      } catch (err) {
        // If anything fails (e.g., parsing was over-eager for this prompt),
        // log and fall back to the standard click heuristics below.
        console.warn('Dropdown selection helper failed, falling back to standard click():', err);
      }
    }

    // Tier 1: LLM-driven selection when a model is configured.
    if (this.model) {
      try {
        await this.browser.init();
        const page = this.browser.getPage();
        const extractor = new SelectorExtractor(page);

        const all = await extractor.extractAllInteractive();
        const visible = all.filter((el) => el.visible !== false && el.isVisible !== false);
        const pool = visible.length > 0 ? visible : all;

        if (pool.length === 0) {
          const screenshot = await this.browser.screenshot().catch(() => undefined as any);
          return {
            success: false,
            message: 'No interactive elements were found on the page to satisfy the click request.',
            error: 'No interactive elements',
            screenshot
          };
        }

        // Prefer any explicitly quoted label (e.g., "Select a role...") as the
        // primary semantic key, so filler instructions like "next to X button"
        // don't dilute matching.
        const coreTarget = this.extractCoreLabel(target);

        // --- Tier 1a: deterministic semantic preselection (no LLM) ---
        // If we can find a single, clearly best-matching element using the
        // same scoring logic as the heuristic path, we click it directly and
        // completely bypass the LLM. This ensures prompts like
        //   "Click on \"Select a role...\" drop down button next to Start Hiring button"
        // behave identically to shorter variants that only mention the label.
        let directChosen: ElementInfo | undefined;
        let semanticCandidates: ElementInfo[] | undefined;
        try {
          semanticCandidates = await extractor.findCandidates(coreTarget || target);
          semanticCandidates = semanticCandidates.filter((el) =>
            this.elementMatchesPrompt(coreTarget || target, el),
          );

          if (semanticCandidates.length > 0) {
            const scored = semanticCandidates
              .map((info) => ({ info, score: extractor.scoreForQuery(info, coreTarget || target) }))
              .filter(({ score }) => score > 0)
              .sort((a, b) => b.score - a.score);

            if (scored.length > 0) {
              const bestScore = scored[0].score;
              const AMBIGUITY_BAND = 10;
              const topTier = scored
                .filter(({ score }) => bestScore - score <= AMBIGUITY_BAND)
                .map(({ info }) => info);

              if (topTier.length === 1) {
                directChosen = topTier[0];
              }
            }
          }
        } catch {
          // If semantic preselection fails for any reason, we simply fall
          // back to the LLM path below.
          directChosen = undefined;
        }

        if (directChosen) {
          const selectorToClick =
            directChosen.selector || directChosen.cssSelector || directChosen.xpath;
          if (selectorToClick) {
            const info = await this.browser.click(selectorToClick);
            const robustSelector = info.selector || info.cssSelector || info.xpath || selectorToClick;
            this.sessionHistory.push({
              action: 'click',
              target: robustSelector,
              selectors: {
                css: info.cssSelector ?? info.selector,
                xpath: info.xpath,
                id: info.id,
                text: info.text,
              },
              description: target,
            });

            // Give the UI time to animate (e.g., open dropdowns) before capturing
            // a screenshot that the LLM will use for its next decision.
            await page.waitForTimeout(1000);
            const screenshot = await this.browser.screenshot();
            const baseMessage = `Clicked ${info.roleHint || 'element'} \"${info.text || target}\"`;

            return {
              success: true,
              message: baseMessage,
              selectors: [info],
              screenshot,
              candidates: semanticCandidates ?? pool,
            };
          }
        }

        // --- Tier 1b: LLM-based selection when deterministic matching was
        // ambiguous or inconclusive.
        const chosenIndex = await this.identifyTargetWithLLM(target, coreTarget, pool);

        if (typeof chosenIndex === 'number' && chosenIndex >= 0 && chosenIndex < pool.length) {
          const chosen = pool[chosenIndex];
          const selectorToClick = chosen.selector || chosen.cssSelector || chosen.xpath;
          if (!selectorToClick) {
            console.warn('LLM selected element without usable selector, falling back to heuristics.');
            return this.clickWithHeuristics(target);
          }

          const info = await this.browser.click(selectorToClick);
          const robustSelector = info.selector || info.cssSelector || info.xpath || selectorToClick;
          this.sessionHistory.push({
            action: 'click',
            target: robustSelector,
            selectors: {
              css: info.cssSelector ?? info.selector,
              xpath: info.xpath,
              id: info.id,
              text: info.text,
            },
            description: target,
          });

          // Allow dropdowns/menus to fully render before we capture the
          // post-click screenshot.
          await page.waitForTimeout(1000);
          const screenshot = await this.browser.screenshot();
          const baseMessage = `Clicked ${info.roleHint || 'element'} \"${info.text || target}\"`;

          return {
            success: true,
            message: baseMessage,
            selectors: [info],
            screenshot,
            candidates: pool
          };
        }

        // LLM returned null or an invalid index -> ambiguity: fall back to heuristics.
        console.warn('LLM selector returned null/ambiguous result, falling back to heuristics.');
        return this.clickWithHeuristics(target);
      } catch (err) {
        console.warn('LLM selector failed, falling back to heuristic:', err);
        return this.clickWithHeuristics(target);
      }
    }

    // Tier 2: No model configured – always use heuristic path.
    return this.clickWithHeuristics(target);
  }

  /**
   * Direct, selector-based click that trusts an upstream planner's chosen
   * element. This skips additional fuzzy matching, but still records history
   * for downstream Selenium generation and returns a rich ExecutionResult.
   */
  async clickExact(selector: string, labelForHistory?: string): Promise<ExecutionResult> {
    await this.browser.init();
    const page = this.browser.getPage();
    const extractor = new SelectorExtractor(page);

    try {
      const info = await this.browser.click(selector);
      const robustSelector = info.selector || info.cssSelector || info.xpath || selector;
      this.sessionHistory.push({
        action: 'click',
        target: robustSelector,
        selectors: {
          css: info.cssSelector ?? info.selector,
          xpath: info.xpath,
          id: info.id,
          text: info.text,
        },
        description: labelForHistory || selector,
      });

      const screenshot = await this.browser.screenshot();
      const baseMessage = `Clicked ${info.roleHint || 'element'} \"${info.text || labelForHistory || selector}\"`;

      return {
        success: true,
        message: baseMessage,
        selectors: [info],
        screenshot,
      };
    } catch (err) {
      // Final safety net – mirror type() behaviour and surface a structured
      // failure with a fresh selector snapshot instead of throwing.
      const msg = err instanceof Error ? err.message : String(err);
      const screenshot = await this.browser.screenshot().catch(() => undefined as any);
      let selectors;
      try {
        selectors = await extractor.extractAllInteractive();
      } catch {
        selectors = undefined;
      }
      return {
        success: false,
        message: msg,
        error: msg,
        screenshot,
        selectors,
      };
    }
  }

  /**
   * Sanitize ElementInfo list down to a minimal, JSON-safe structure for LLM
   * consumption. This avoids passing complex prototypes or huge attribute
   * maps into the SDK.
   */
  private sanitizeElementsForLLM(elements: ElementInfo[]): {
    id: string;
    text: string;
    ariaLabel: string;
    dataTestId: string;
    region: string;
    roleHint: string;
  }[] {
    return elements.map((el, idx) => ({
      id: `el_${idx}`,
      text: el.text ?? '',
      ariaLabel: el.ariaLabel ?? '',
      dataTestId: el.dataTestId ?? '',
      region: el.region ?? 'main',
      roleHint: el.roleHint ?? 'other'
    }));
  }

  /**
   * Extract the core label from a natural-language click request. When the
   * prompt contains a quoted label (e.g., "Click on \"Select a role...\" drop
   * down button next to Start Hiring"), we treat the quoted portion as the
   * primary matching key.
   */
  private extractCoreLabel(prompt: string): string {
    const raw = (prompt || '').trim();
    if (!raw) return '';

    const quoted = raw.match(/["'“”‘’]([^"'“”‘’]{2,})["'“”‘’]/);
    if (quoted && quoted[1].trim().length >= 3) {
      return quoted[1].trim();
    }

    let core = raw;
    const lower = core.toLowerCase();
    const verbPrefixes = ['click on', 'click', 'press', 'tap', 'open', 'select', 'choose'];
    for (const v of verbPrefixes) {
      if (lower.startsWith(v + ' ')) {
        core = core.slice(v.length).trim();
        break;
      }
    }

    // Remove common control-type suffixes that don't help identify which
    // specific element is meant.
    core = core.replace(/\b(button|link|tab|field|input|dropdown|drop down|icon|menu)\b/gi, '').trim();

    return core || raw;
  }

  /**
   * Decide which interactive element best matches the user's request using an
   * LLM. Returns the index into the provided elements array, or null when the
   * model reports ambiguity or an error occurs.
   */
  private async identifyTargetWithLLM(
    userPrompt: string,
    coreQuery: string,
    elements: ElementInfo[]
  ): Promise<number | null> {
    if (!this.model) return null;

    const summaries = this.sanitizeElementsForLLM(elements);

    // --- Semantic strictness pre-filter ---
    const selectionQuery = coreQuery && coreQuery.trim().length ? coreQuery : userPrompt;
    const lowerPrompt = selectionQuery.toLowerCase();
    const tokens = lowerPrompt.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);

    const filteredSummaries = summaries.filter((s) => {
      const label = `${s.text} ${s.ariaLabel} ${s.dataTestId}`.toLowerCase();
      if (!label.trim()) return false;
      if (tokens.length === 0) return true;
      return tokens.some((tok) => label.includes(tok));
    });

    if (filteredSummaries.length === 0) {
      console.warn('No LLM candidates share semantic tokens with the user prompt; skipping LLM selection.');
      return null;
    }

    const focusLine =
      coreQuery && coreQuery.trim().length && coreQuery.trim() !== userPrompt.trim()
        ? `Primary label to match: "${coreQuery.trim()}".\n`
        : '';

    const prompt = [
      `SYSTEM: You are a precise automation engine. The user wants to: "${userPrompt}".`,
      focusLine,
      'Here are the interactive elements on the screen as a JSON array:',
      JSON.stringify(filteredSummaries),
      '',
      'Choose the single best element to interact with.',
      '',
      'Rules:',
      '- You MUST only select elements that strongly match the user intent based on text, aria-label, or data-testid.',
      '- If multiple elements match equally well, prefer ones whose "region" is "main" or "header".',
      '- If none of the elements match the text or meaning strongly, return JSON null. Do NOT guess or select unrelated buttons.',
      '- If you cannot confidently decide (the request is ambiguous), return JSON null. Do NOT guess.',
      '- Return ONLY the "id" of the best element as a JSON string, e.g. ""el_3"".'
    ].join('\\n');

    try {
      const result = await this.model.generateContent({
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }]
          }
        ]
      } as any);

      const raw = (result as any).response?.text?.() ?? '';
      const chosenId = this.parseLlmChosenId(raw);
      if (!chosenId) return null;

      const match = chosenId.match(/^el_(\d+)$/);
      if (!match) return null;

      const idx = Number.parseInt(match[1], 10);
      return Number.isFinite(idx) ? idx : null;
    } catch (err) {
      console.warn('LLM Selector failed, falling back to heuristic:', err);
      return null;
    }
  }

  /**
   * Robustly extract the chosen element id (e.g. "el_3") from an LLM response
   * that may be a raw string, JSON string, or small JSON object.
   */
  private parseLlmChosenId(raw: string): string | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    if (trimmed === 'null' || trimmed === '"null"') return null;

    // 1) Try direct JSON parse first.
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') {
        return parsed;
      }
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as any;
        if (typeof obj.id === 'string') return obj.id;
        if (typeof obj.elementId === 'string') return obj.elementId;
      }
    } catch {
      // ignore and fall back to regex-based extraction
    }

    // 2) Look for a token that looks like el_# either quoted or bare.
    const match = trimmed.match(/"(el_\d+)"/) || trimmed.match(/\b(el_\d+)\b/);
    return match ? match[1] : null;
  }

/**
   * Check if an element has any meaningful textual overlap with the user's
   * prompt, using text, aria-label, or data-testid. This is the core of the
   * semantic firewall that prevents obviously unrelated buttons (e.g.,
   * "Payment Posting") from being considered for prompts like "Start Hiring".
   */
  private elementMatchesPrompt(prompt: string, el: ElementInfo): boolean {
    const core = this.extractCoreLabel(prompt);
    const lowerPrompt = core.toLowerCase();
    const tokens = lowerPrompt.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
    if (tokens.length === 0) return true;

    const label = `${el.text ?? ''} ${el.ariaLabel ?? ''} ${el.dataTestId ?? ''}`.toLowerCase();
    if (!label.trim()) return false;

    return tokens.some((tok) => label.includes(tok));
  }

  /**
   * Heuristic click implementation using the original fuzzy-matching and
   * ambiguity handling logic. This is used as Tier 2 when the LLM selector is
   * unavailable or fails.
   */
  private async clickWithHeuristics(target: string): Promise<ExecutionResult> {
    await this.browser.init();
    const page = this.browser.getPage();
    const extractor = new SelectorExtractor(page);
    let candidates: ElementInfo[] = [];

    // Normalize the natural-language target so that quoted labels (e.g.,
    // "Select a role...") drive semantic matching instead of surrounding
    // instructions like "next to Start Hiring button".
    const coreTarget = this.extractCoreLabel(target);

    try {
      // Step 1: Check strict selector count. If target is not a valid CSS/named
      // selector, we fall back to semantic candidate matching.
      let count = 0;
      let isSelectorValid = true;
      try {
        const locator = page.locator(target);
        // Minimal filter to ensure we get a count; also excludes detached nodes.
        count = await locator.filter({ hasText: /.*/ }).count();
      } catch {
        isSelectorValid = false;
      }

      // Step 2: Handle Ambiguity (Multiple Exact Matches) when the caller passed
      // a concrete selector.
      if (isSelectorValid && count > 1) {
        const locator = page.locator(target);
        const locators = await locator.all();

        for (const loc of locators) {
          if (await loc.isVisible()) {
            const handle = await loc.elementHandle();
            if (handle) {
              candidates.push(await extractor.extractFromHandle(handle));
            }
          }
        }

        if (candidates.length > 1) {
          return {
            success: false,
            message: `Ambiguous request: '${target}' matches ${candidates.length} visible elements. Please clarify.`,
            isAmbiguous: true,
            requiresInteraction: true,
            candidates,
            screenshot: await this.browser.screenshot()
          };
        }
        // If only 1 visible remains, we proceed to click logic below with the
        // original selector.
      }

      let selectorToClick = target;
      let selectedCandidate: ElementInfo | undefined;

      // Step 3: Handle Near-Misses (Zero matches or Invalid Selector) by using
      // the semantic candidate finder and scoring.
      if (!isSelectorValid || count === 0) {
        candidates = await extractor.findCandidates(coreTarget || target);

        // Strict semantic pre-filter: drop any candidates with zero keyword overlap.
        candidates = candidates.filter((el) => this.elementMatchesPrompt(coreTarget || target, el));

        // Fallback: explicit icon search when user mentions "icon" but no
        // interactive candidates were found.
        if (candidates.length === 0 && /icon/i.test(coreTarget || target)) {
          const iconHandles = await page.$$('[class*="icon" i]');
          for (const h of iconHandles) {
            const info = await extractor.extractFromHandle(h);
            candidates.push(info);
          }
          // Re-rank icon-only candidates using the same scoring rules.
          candidates = candidates
            .filter((el) => this.elementMatchesPrompt(coreTarget || target, el))
            .map((info) => ({ info, score: extractor.scoreForQuery(info, coreTarget || target) }))
            .filter(({ score }) => score > 0)
            .sort((a, b) => b.score - a.score)
            .map((s) => s.info);
        }

        if (candidates.length > 0) {
          // Strict ambiguity handling over the top tier of scored candidates.
          const scored = candidates
            .map((info) => ({ info, score: extractor.scoreForQuery(info, coreTarget || target) }))
            .filter(({ score }) => score > 0)
            .sort((a, b) => b.score - a.score);

          if (scored.length > 0) {
            const bestScore = scored[0].score;
            const AMBIGUITY_BAND = 10; // ~5–10 points around the best candidate.

            const topTier = scored
              .filter(({ score }) => bestScore - score <= AMBIGUITY_BAND)
              .map(({ info }) => info);

            if (topTier.length > 1) {
              const screenshot = await this.browser.screenshot().catch(() => undefined as any);
              // We do not need verbose descriptions here; the caller can inspect
              // candidates directly.
              return {
                success: true,
                message: `Ambiguous request: found ${topTier.length} strong matches for "${target}".`,
                isAmbiguous: true,
                requiresInteraction: true,
                candidates: topTier,
                screenshot
              };
            }

            // Otherwise, use the top-scoring candidate.
            selectedCandidate = scored[0].info;
          } else {
            // No positive scores (very weak matches) — instead of guessing, treat
            // this as a "not found" situation so we never click an obviously
            // unrelated element.
            const screenshot = await this.browser.screenshot().catch(() => undefined as any);
            return {
              success: false,
              message: `No elements on the page matched "${target}" strongly enough to click safely.`,
              isAmbiguous: false,
              requiresInteraction: true,
              candidates,
              screenshot
            };
          }

          const preferredSelector =
            selectedCandidate.selector || selectedCandidate.cssSelector || selectedCandidate.xpath;
          if (preferredSelector) {
            selectorToClick = preferredSelector;
          }
        }
        // If no semantic candidates were found we intentionally fall back to the
        // browser's smartLocate() logic using the original target string.
      }

      // Step 4: Execute Click (Unique Match / Intelligent Locator)
      const info = await this.browser.click(selectorToClick);
      const robustSelector = info.selector || info.cssSelector || info.xpath || selectorToClick;
      this.sessionHistory.push({
        action: 'click',
        target: robustSelector,
        selectors: {
          css: info.cssSelector ?? info.selector,
          xpath: info.xpath,
          id: info.id,
          text: info.text,
        },
        description: target,
      });

      // Pause briefly so any dropdowns/menus opened by the click have time to
      // render before we grab the screenshot for the client.
      await page.waitForTimeout(1000);
      const screenshot = await this.browser.screenshot();
      const baseMessage = `Clicked ${info.roleHint || 'element'} "${info.text || target}"`;
      const visibilityHint =
        selectedCandidate && selectedCandidate.isVisible === false
          ? ' (note: element was initially hidden or collapsed)'
          : '';

      return {
        success: true,
        message: baseMessage + visibilityHint,
        selectors: [info],
        screenshot,
        candidates: candidates.length ? candidates : undefined
      };
    } catch (err) {
      // Final safety net – we intentionally do not guess here.
      const msg = err instanceof Error ? err.message : String(err);
      const screenshot = await this.browser.screenshot().catch(() => undefined as any);
      return {
        success: false,
        message: `Error clicking: ${msg}`,
        error: msg,
        screenshot
      };
    }
  }

  /**
   * Type into an element. Similar to click(), we always return a rich
   * ExecutionResult and never throw for normal locator issues.
   */
  async type(selector: string, text: string): Promise<ExecutionResult> {
    const page = this.browser.getPage();
    const extractor = new SelectorExtractor(page);

    try {
      const info = await this.browser.type(selector, text);
      
      const robustSelector = info.cssSelector || selector;
      this.sessionHistory.push({
        action: 'type',
        target: robustSelector,
        value: text,
        selectors: {
          css: info.cssSelector ?? info.selector,
          xpath: info.xpath,
          id: info.id,
          text: info.text,
        },
        description: selector,
      });

      const screenshot = await this.browser.screenshot();
      return { 
        success: true, 
        message: `Typed into ${selector}`, 
        screenshot,
        selectors: [info] 
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const screenshot = await this.browser.screenshot().catch(() => undefined as any);
      let selectors;
      try {
        selectors = await extractor.extractAllInteractive();
      } catch {
        selectors = undefined;
      }
      return {
        success: false,
        message: msg,
        error: msg,
        screenshot,
        selectors
      };
    }
  }

  async handleCookieBanner(): Promise<ExecutionResult> {
    const dismissed = await this.browser.handleCookieBanner();
    const screenshot = await this.browser.screenshot();
    return {
      success: true,
      message: dismissed ? 'Cookie banner dismissed' : 'No cookie banner detected',
      screenshot
    };
  }

  /**
   * Extract selectors for either a specific target or all interactive elements.
   * This is the primary way for the LLM to "observe" the page structure.
   */
  async extractSelectors(targetSelector?: string): Promise<ExecutionResult> {
    const page = this.browser.getPage();
    const extractor = new SelectorExtractor(page);

    const selectors = targetSelector
      ? [await extractor.extractForSelector(targetSelector)]
      : await extractor.extractAllInteractive();

    selectors.forEach((s, idx) => this.browser.storeSelector(`el_${idx}`, s));

    return {
      success: true,
      message: `Extracted ${selectors.length} elements`,
      selectors
    };
  }

  /**
   * Convenience helper for the agent: capture both screenshot and a selector
   * snapshot in a single call, without performing any action.
   */
  async observe(targetSelector?: string): Promise<ExecutionResult> {
    const page = this.browser.getPage();
    const extractor = new SelectorExtractor(page);

    const selectors = targetSelector
      ? [await extractor.extractForSelector(targetSelector)]
      : await extractor.extractAllInteractive();

    selectors.forEach((s, idx) => this.browser.storeSelector(`observe_${idx}`, s));

    const screenshot = await this.browser.screenshot();

    return {
      success: true,
      message: `Observed ${selectors.length} interactive elements`,
      screenshot,
      selectors
    };
  }

  async generateSelenium(commands?: ExecutionCommand[]): Promise<ExecutionResult> {
    const gen = new SeleniumGenerator(
      {
        language: 'python',
        testName: 'test_flow',
        chromeDriverPath: 'C:\\\\hyprtask\\\\lib\\\\Chromium\\\\chromedriver.exe',
      },
      this.model,
    );

    const cmdsToUse = (commands && commands.length > 0) ? commands : this.sessionHistory;
    
    // If we're using history, we might want to filter out non-essential steps if needed,
    // but usually exact replay is desired.

    let code: string;
    if (this.model) {
      code = await gen.generateWithLLM(cmdsToUse);
    } else {
      code = gen.generate(cmdsToUse);
    }

    return {
      success: true,
      message: `Generated selenium code from ${cmdsToUse.length} steps`,
      seleniumCode: code,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AUTONOMOUS AGENT WITH SELF-HEALING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Run an autonomous agent that accomplishes a high-level goal through
   * an observe-think-act loop with self-healing capabilities.
   *
   * Self-healing mechanisms:
   * 1. State change detection - verifies actions had the intended effect
   * 2. Automatic retry with alternative selectors when actions fail
   * 3. Action history awareness - prevents infinite loops on the same element
   * 4. Semantic element matching - finds similar elements when exact match fails
   */
  async runAutonomousAgent(
    goal: string,
    config: AgentConfig = {}
  ): Promise<AgentSessionResult> {
    const maxSteps = config.maxSteps ?? 20;
    const maxRetries = config.maxRetriesPerAction ?? 3;
    const generateSelenium = config.generateSelenium ?? true;

    // Clear session history for a fresh autonomous run
    this.sessionHistory = [];

    const steps: AgentStepResult[] = [];
    const failedElements: Set<string> = new Set(); // Track elements that failed to avoid retrying them
    const actionHistory: string[] = []; // Natural language history for context

    await this.browser.init();
    const page = this.browser.getPage();

    let stepNumber = 0;
    let isFinished = false;
    let finalSummary = '';

    while (stepNumber < maxSteps && !isFinished) {
      stepNumber++;

      // ─────────────────────────────────────────────────────────────────────
      // PHASE 1: OBSERVE - Capture current state
      // ─────────────────────────────────────────────────────────────────────
      const urlBefore = page.url();
      const observation = await this.observe();
      const elements = observation.selectors ?? [];
      const screenshot = observation.screenshot;

      // ─────────────────────────────────────────────────────────────────────
      // PHASE 2: THINK - Ask LLM for next action
      // ─────────────────────────────────────────────────────────────────────
      const nextAction = await this.planNextAgentAction(
        goal,
        elements,
        actionHistory,
        failedElements,
        screenshot
      );

      // Notify callback if provided
      if (config.onThought) {
        config.onThought(nextAction.thought, nextAction);
      }

      // Check if agent decided to finish
      if (nextAction.type === 'finish') {
        isFinished = true;
        finalSummary = nextAction.summary;
        steps.push({
          stepNumber,
          action: nextAction,
          success: true,
          message: 'Agent completed the goal',
          urlBefore,
          urlAfter: urlBefore,
          stateChanged: false,
          screenshot,
          retryCount: 0,
        });
        break;
      }

      // ─────────────────────────────────────────────────────────────────────
      // PHASE 3: ACT - Execute with self-healing retry logic
      // ─────────────────────────────────────────────────────────────────────
      let retryCount = 0;
      let actionSuccess = false;
      let actionMessage = '';
      let actionError: string | undefined;
      let elementInfo: ElementInfo | undefined;
      let recoveryAttempt: string | undefined;
      let urlAfter = urlBefore;
      let postActionScreenshot = screenshot;

      while (retryCount <= maxRetries && !actionSuccess) {
        try {
          const result = await this.executeAgentAction(
            nextAction,
            elements,
            retryCount,
            failedElements
          );

          actionSuccess = result.success;
          actionMessage = result.message;
          elementInfo = result.elementInfo;

          if (!actionSuccess && result.error) {
            actionError = result.error;
            // Track failed element to avoid retrying it
            if (result.failedSelector) {
              failedElements.add(result.failedSelector);
            }
            retryCount++;
            if (retryCount <= maxRetries) {
              recoveryAttempt = `Retry ${retryCount}/${maxRetries}: ${result.recoveryHint || 'trying alternative approach'}`;
            }
          }
        } catch (err) {
          actionError = err instanceof Error ? err.message : String(err);
          retryCount++;
          if (retryCount <= maxRetries) {
            recoveryAttempt = `Retry ${retryCount}/${maxRetries} after error: ${actionError}`;
            // Brief pause before retry
            await page.waitForTimeout(500 * retryCount);
          }
        }
      }

      // Capture post-action state
      urlAfter = page.url();
      try {
        postActionScreenshot = await this.browser.screenshot();
      } catch {
        postActionScreenshot = screenshot;
      }

      // ─────────────────────────────────────────────────────────────────────
      // PHASE 4: VERIFY - Detect state change (self-healing check)
      // ─────────────────────────────────────────────────────────────────────
      const stateChanged = await this.detectStateChange(
        urlBefore,
        urlAfter,
        nextAction
      );

      // Update action history for context in future steps
      const actionDescription = this.describeAction(nextAction, actionSuccess);
      actionHistory.push(actionDescription);

      const stepResult: AgentStepResult = {
        stepNumber,
        action: nextAction,
        success: actionSuccess,
        message: actionMessage,
        urlBefore,
        urlAfter,
        stateChanged,
        recoveryAttempt,
        screenshot: postActionScreenshot,
        elementInfo,
        error: actionError,
        retryCount,
      };

      steps.push(stepResult);

      // Notify callback if provided
      if (config.onStepComplete) {
        config.onStepComplete(stepResult);
      }

      // Self-healing: if action succeeded but no state change, log warning
      if (actionSuccess && !stateChanged && nextAction.type !== 'wait') {
        console.warn(
          `Step ${stepNumber}: Action succeeded but no state change detected. ` +
          `This might indicate the click had no effect.`
        );
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FINAL: Generate results
    // ─────────────────────────────────────────────────────────────────────────
    let seleniumCode: string | undefined;
    if (generateSelenium && this.sessionHistory.length > 0) {
      try {
        const seleniumResult = await this.generateSelenium();
        seleniumCode = seleniumResult.seleniumCode;
      } catch (err) {
        console.warn('Failed to generate Selenium code:', err);
      }
    }

    const finalObservation = await this.observe();
    const overallSuccess = isFinished || steps.filter(s => s.success).length > 0;

    return {
      success: overallSuccess,
      summary: finalSummary || this.generateSessionSummary(steps, goal),
      goal,
      totalSteps: stepNumber,
      steps,
      commands: [...this.sessionHistory],
      seleniumCode,
      screenshot: finalObservation.screenshot,
      selectors: finalObservation.selectors,
    };
  }

  /**
   * Ask the LLM to decide the next action based on current state and history.
   */
  private async planNextAgentAction(
    goal: string,
    elements: ElementInfo[],
    actionHistory: string[],
    failedElements: Set<string>,
    screenshot?: string
  ): Promise<AgentAction> {
    if (!this.model) {
      // Fallback: if no model, return finish immediately
      return {
        type: 'finish',
        thought: 'No LLM model available',
        summary: 'Cannot proceed without AI model',
      };
    }

    // Build element context for LLM
    const visibleElements = elements.filter(el => el.visible !== false && el.isVisible !== false);
    const limitedElements = visibleElements.slice(0, 150).map((el, idx) => ({
      id: `el_${idx}`,
      tag: el.tagName,
      text: (el.text || '').slice(0, 100),
      ariaLabel: el.ariaLabel || '',
      placeholder: el.placeholder || '',
      role: el.roleHint || 'other',
      region: el.region || 'main',
      selector: el.selector || el.cssSelector || el.xpath || '',
      isFailed: el.selector ? failedElements.has(el.selector) : false,
    }));

    const historyContext = actionHistory.length > 0
      ? `\n\nPrevious actions taken:\n${actionHistory.map((a, i) => `${i + 1}. ${a}`).join('\n')}`
      : '';

    const failedContext = failedElements.size > 0
      ? `\n\nElements that have failed (DO NOT retry these):\n${Array.from(failedElements).slice(0, 10).join('\n')}`
      : '';

    const prompt = [
      'SYSTEM: You are an autonomous browser agent. Your goal is to accomplish the user\'s task through a series of browser actions.',
      '',
      `GOAL: ${goal}`,
      historyContext,
      failedContext,
      '',
      'CURRENT PAGE ELEMENTS (JSON):',
      JSON.stringify(limitedElements, null, 2),
      '',
      'INSTRUCTIONS:',
      '- Analyze the current state and decide the SINGLE next action to take.',
      '- If an element has "isFailed: true", DO NOT select it - find an alternative.',
      '- If you have completed the goal or cannot proceed further, use action "finish".',
      '- Be precise: prefer elements with exact text matches to the goal.',
      '- Consider the action history to avoid repeating failed approaches.',
      '',
      'RESPONSE FORMAT (JSON only, no markdown):',
      'Return ONE of these action types:',
      '{ "type": "navigate", "url": "https://...", "thought": "reasoning" }',
      '{ "type": "click", "elementId": "el_N", "thought": "reasoning" }',
      '{ "type": "click", "semanticTarget": "button text", "thought": "reasoning" }',
      '{ "type": "type", "elementId": "el_N", "text": "text to type", "thought": "reasoning" }',
      '{ "type": "scroll", "direction": "down", "thought": "reasoning" }',
      '{ "type": "wait", "durationMs": 1000, "thought": "reasoning" }',
      '{ "type": "finish", "thought": "reasoning", "summary": "what was accomplished" }',
      '',
      'The "thought" field must explain your reasoning. Return ONLY raw JSON.',
    ].join('\n');

    try {
      // Build multimodal request if screenshot is available
      const textPart = { text: prompt };
      const imagePart = screenshot && screenshot.startsWith('data:image/')
        ? {
            inlineData: {
              data: screenshot.split(',')[1] || '',
              mimeType: 'image/png',
            },
          }
        : null;

      const response = imagePart
        ? await this.model.generateContent([textPart, imagePart] as any)
        : await this.model.generateContent(textPart as any);

      const rawText = (response as any).response?.text?.() ?? '';
      const parsed = this.parseAgentActionResponse(rawText);
      return parsed;
    } catch (err) {
      console.error('Failed to get next agent action from LLM:', err);
      return {
        type: 'finish',
        thought: `LLM error: ${err instanceof Error ? err.message : String(err)}`,
        summary: 'Agent stopped due to LLM error',
      };
    }
  }

  /**
   * Parse the LLM response into a typed AgentAction.
   */
  private parseAgentActionResponse(raw: string): AgentAction {
    const trimmed = raw.trim();

    // Try to extract JSON from markdown code blocks if present
    const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : trimmed;

    // Find first { and last } to extract JSON object
    const first = jsonStr.indexOf('{');
    const last = jsonStr.lastIndexOf('}');
    if (first < 0 || last <= first) {
      return {
        type: 'finish',
        thought: 'Could not parse LLM response as JSON',
        summary: 'Parse error - stopping agent',
      };
    }

    try {
      const parsed = JSON.parse(jsonStr.substring(first, last + 1));

      // Validate and normalize the action
      const thought = parsed.thought || 'No reasoning provided';

      switch (parsed.type) {
        case 'navigate':
          return { type: 'navigate', url: parsed.url || '', thought };
        case 'click':
          return {
            type: 'click',
            elementId: parsed.elementId,
            selector: parsed.selector,
            semanticTarget: parsed.semanticTarget,
            thought,
          };
        case 'type':
          return {
            type: 'type',
            elementId: parsed.elementId,
            selector: parsed.selector,
            semanticTarget: parsed.semanticTarget,
            text: parsed.text || '',
            thought,
          };
        case 'scroll':
          return {
            type: 'scroll',
            direction: parsed.direction === 'up' ? 'up' : 'down',
            thought,
          };
        case 'wait':
          return {
            type: 'wait',
            durationMs: parsed.durationMs || 1000,
            thought,
          };
        case 'finish':
          return {
            type: 'finish',
            thought,
            summary: parsed.summary || 'Task completed',
          };
        default:
          return {
            type: 'finish',
            thought: `Unknown action type: ${parsed.type}`,
            summary: 'Unknown action - stopping agent',
          };
      }
    } catch (err) {
      return {
        type: 'finish',
        thought: `JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
        summary: 'Parse error - stopping agent',
      };
    }
  }

  /**
   * Execute a single agent action with self-healing support.
   */
  private async executeAgentAction(
    action: AgentAction,
    elements: ElementInfo[],
    retryCount: number,
    failedElements: Set<string>
  ): Promise<{
    success: boolean;
    message: string;
    elementInfo?: ElementInfo;
    error?: string;
    failedSelector?: string;
    recoveryHint?: string;
  }> {
    const page = this.browser.getPage();

    switch (action.type) {
      case 'navigate': {
        const result = await this.navigate(action.url);
        return {
          success: result.success,
          message: result.message,
          error: result.error,
        };
      }

      case 'click': {
        // Resolve the selector to use
        let selectorToClick: string | undefined;
        let elementInfo: ElementInfo | undefined;

        if (action.elementId) {
          // Find element by LLM-assigned ID
          const match = action.elementId.match(/^el_(\d+)$/);
          if (match) {
            const idx = parseInt(match[1], 10);
            const visibleElements = elements.filter(el => el.visible !== false && el.isVisible !== false);
            const el = visibleElements[idx];
            if (el) {
              selectorToClick = el.selector || el.cssSelector || el.xpath;
              elementInfo = el;
            }
          }
        }

        if (action.selector) {
          selectorToClick = action.selector;
        }

        // Self-healing: if the chosen selector has failed before, find alternative
        if (selectorToClick && failedElements.has(selectorToClick) && retryCount > 0) {
          const alternative = await this.findAlternativeElement(
            elements,
            action.semanticTarget || elementInfo?.text || '',
            failedElements
          );
          if (alternative) {
            selectorToClick = alternative.selector || alternative.cssSelector || alternative.xpath;
            elementInfo = alternative;
          }
        }

        // Fallback to semantic target
        if (!selectorToClick && action.semanticTarget) {
          const result = await this.click(action.semanticTarget);
          return {
            success: result.success,
            message: result.message,
            elementInfo: result.selectors?.[0],
            error: result.error,
            failedSelector: action.semanticTarget,
            recoveryHint: 'Will try alternative element matching',
          };
        }

        if (!selectorToClick) {
          return {
            success: false,
            message: 'No valid selector found for click action',
            error: 'Missing selector',
            recoveryHint: 'Need to find element by semantic matching',
          };
        }

        try {
          const result = await this.clickExact(selectorToClick, action.thought);
          return {
            success: result.success,
            message: result.message,
            elementInfo: result.selectors?.[0] || elementInfo,
            error: result.error,
            failedSelector: result.success ? undefined : selectorToClick,
            recoveryHint: result.success ? undefined : 'Will try alternative selector',
          };
        } catch (err) {
          return {
            success: false,
            message: `Click failed: ${err instanceof Error ? err.message : String(err)}`,
            elementInfo,
            error: err instanceof Error ? err.message : String(err),
            failedSelector: selectorToClick,
            recoveryHint: 'Will try alternative selector',
          };
        }
      }

      case 'type': {
        let selectorToType: string | undefined;
        let elementInfo: ElementInfo | undefined;

        if (action.elementId) {
          const match = action.elementId.match(/^el_(\d+)$/);
          if (match) {
            const idx = parseInt(match[1], 10);
            const visibleElements = elements.filter(el => el.visible !== false && el.isVisible !== false);
            const el = visibleElements[idx];
            if (el) {
              selectorToType = el.selector || el.cssSelector || el.xpath;
              elementInfo = el;
            }
          }
        }

        if (action.selector) {
          selectorToType = action.selector;
        }

        if (!selectorToType && action.semanticTarget) {
          selectorToType = action.semanticTarget;
        }

        if (!selectorToType) {
          return {
            success: false,
            message: 'No valid selector found for type action',
            error: 'Missing selector',
          };
        }

        try {
          const result = await this.type(selectorToType, action.text);
          return {
            success: result.success,
            message: result.message,
            elementInfo: result.selectors?.[0] || elementInfo,
            error: result.error,
            failedSelector: result.success ? undefined : selectorToType,
          };
        } catch (err) {
          return {
            success: false,
            message: `Type failed: ${err instanceof Error ? err.message : String(err)}`,
            elementInfo,
            error: err instanceof Error ? err.message : String(err),
            failedSelector: selectorToType,
          };
        }
      }

      case 'scroll': {
        try {
          const delta = action.direction === 'up' ? -500 : 500;
          await page.mouse.wheel(0, delta);
          await page.waitForTimeout(500);
          return {
            success: true,
            message: `Scrolled ${action.direction}`,
          };
        } catch (err) {
          return {
            success: false,
            message: `Scroll failed: ${err instanceof Error ? err.message : String(err)}`,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }

      case 'wait': {
        await page.waitForTimeout(action.durationMs);
        return {
          success: true,
          message: `Waited ${action.durationMs}ms`,
        };
      }

      case 'finish': {
        return {
          success: true,
          message: 'Agent finished',
        };
      }

      default:
        return {
          success: false,
          message: 'Unknown action type',
          error: 'Unknown action',
        };
    }
  }

  /**
   * Self-healing: Find an alternative element when the primary one fails.
   * Uses semantic similarity to find elements with similar text/role.
   */
  private async findAlternativeElement(
    elements: ElementInfo[],
    targetDescription: string,
    failedElements: Set<string>
  ): Promise<ElementInfo | null> {
    if (!targetDescription) return null;

    const targetLower = targetDescription.toLowerCase();
    const targetTokens = targetLower.split(/[^a-z0-9]+/).filter(t => t.length >= 3);

    // Score elements by similarity to target
    const candidates = elements
      .filter(el => {
        const selector = el.selector || el.cssSelector || el.xpath;
        if (!selector) return false;
        if (failedElements.has(selector)) return false;
        if (el.visible === false || el.isVisible === false) return false;
        return true;
      })
      .map(el => {
        const label = `${el.text || ''} ${el.ariaLabel || ''} ${el.placeholder || ''}`.toLowerCase();
        const matchCount = targetTokens.filter(tok => label.includes(tok)).length;
        return { el, score: matchCount };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score);

    return candidates.length > 0 ? candidates[0].el : null;
  }

  /**
   * Detect whether a meaningful state change occurred after an action.
   */
  private async detectStateChange(
    urlBefore: string,
    urlAfter: string,
    action: AgentAction
  ): Promise<boolean> {
    // URL change is a definite state change
    if (urlBefore !== urlAfter) {
      return true;
    }

    // Navigate actions should always result in URL change
    if (action.type === 'navigate') {
      return urlBefore !== urlAfter;
    }

    // For click/type, we assume state changed if the action succeeded
    // A more sophisticated implementation could compare DOM snapshots
    if (action.type === 'click' || action.type === 'type') {
      return true; // Optimistic - assume UI updated
    }

    // Scroll and wait don't typically change URL
    if (action.type === 'scroll' || action.type === 'wait') {
      return true;
    }

    return false;
  }

  /**
   * Generate a human-readable description of an action for history tracking.
   */
  private describeAction(action: AgentAction, success: boolean): string {
    const status = success ? '✓' : '✗';
    switch (action.type) {
      case 'navigate':
        return `${status} Navigated to ${action.url}`;
      case 'click':
        return `${status} Clicked ${action.semanticTarget || action.elementId || 'element'}`;
      case 'type':
        return `${status} Typed "${action.text}" into ${action.semanticTarget || action.elementId || 'input'}`;
      case 'scroll':
        return `${status} Scrolled ${action.direction}`;
      case 'wait':
        return `${status} Waited ${action.durationMs}ms`;
      case 'finish':
        return `${status} Finished: ${action.summary}`;
      default:
        return `${status} Unknown action`;
    }
  }

  /**
   * Generate a summary of the agent session.
   */
  private generateSessionSummary(steps: AgentStepResult[], goal: string): string {
    const successCount = steps.filter(s => s.success).length;
    const failCount = steps.filter(s => !s.success).length;
    const totalRetries = steps.reduce((sum, s) => sum + s.retryCount, 0);

    const actions = steps
      .filter(s => s.action.type !== 'finish')
      .map(s => {
        switch (s.action.type) {
          case 'navigate': return `navigated to ${s.action.url}`;
          case 'click': return `clicked ${s.action.semanticTarget || s.action.elementId || 'element'}`;
          case 'type': return `typed text`;
          case 'scroll': return `scrolled ${s.action.direction}`;
          case 'wait': return `waited`;
          default: return 'performed action';
        }
      });

    let summary = `Attempted to: ${goal}. `;
    summary += `Completed ${successCount} of ${steps.length} steps. `;
    if (failCount > 0) {
      summary += `${failCount} steps failed. `;
    }
    if (totalRetries > 0) {
      summary += `Self-healed with ${totalRetries} retry attempts. `;
    }
    if (actions.length > 0 && actions.length <= 5) {
      summary += `Actions: ${actions.join(', ')}.`;
    }

    return summary;
  }

  /**
   * Get the current session history (useful for external access).
   */
  getSessionHistory(): ExecutionCommand[] {
    return [...this.sessionHistory];
  }

  /**
   * Clear the session history.
   */
  clearSessionHistory(): void {
    this.sessionHistory = [];
  }
}
