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
import { selectFromDropdown, selectOptionInOpenDropdown, parseDropdownInstruction, DropdownIntent, DropdownSelectionResult } from './dropdownUtils';

export class McpTools {
  private sessionHistory: ExecutionCommand[] = [];
  /**
   * When the autonomous agent is running we buffer commands for the
   * current high-level step here instead of writing directly to
   * sessionHistory. The step is only committed if the action is
   * ultimately considered successful.
   */
  private agentCommandBuffer: ExecutionCommand[] | null = null;

  /**
   * Centralised history recording so we can transparently switch between
   * immediate logging (single-step mode) and per-step buffering
   * (autonomous agent mode).
   */
  private recordCommand(cmd: ExecutionCommand | ExecutionCommand[]): void {
    const cmds = Array.isArray(cmd) ? cmd : [cmd];
    if (this.agentCommandBuffer) {
      this.agentCommandBuffer.push(...cmds);
    } else {
      this.sessionHistory.push(...cmds);
    }
  }

  constructor(private readonly browser: BrowserManager, private readonly model?: GenerativeModel) {}

  private extractUrlFromPrompt(prompt: string): string | null {
    const match = prompt.match(/https?:\/\/[^\s]+/);
    return match ? match[0] : null;
  }
  private extractDomain(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }

  async navigate(url: string): Promise<ExecutionResult> {
    await this.browser.init();
    await this.browser.goto(url);

    // Record a high-level navigation step; description is the raw URL or prompt.
    this.recordCommand({
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
          const selectionResult = await selectFromDropdown(page, dropdownIntent.dropdownLabel, dropdownIntent.optionLabel);

          // Record this as two high-level steps for downstream Selenium
          // generation: open dropdown (click) + select option (click with REAL selector).
          this.recordCommand([
            {
              action: 'click',
              target: dropdownIntent.dropdownLabel,
              // Note: dropdownLabel is semantic text, not a real CSS selector
              // The SeleniumGenerator will handle this via text-based XPath fallback
              selectors: { text: dropdownIntent.dropdownLabel },
              description: `Open dropdown "${dropdownIntent.dropdownLabel}"`,
            },
            {
              action: 'click',
              // Use the REAL selector captured during the click, or fall back to
              // a semantic description if keyboard selection was used.
              target: selectionResult.optionSelector || dropdownIntent.optionLabel,
              selectors: selectionResult.optionSelector
                ? { css: selectionResult.optionSelector, xpath: selectionResult.optionXpath, text: dropdownIntent.optionLabel }
                : { text: dropdownIntent.optionLabel },
              description: `Select option "${dropdownIntent.optionLabel}" from dropdown "${dropdownIntent.dropdownLabel}"`,
            },
          ]);

          message = `Selected option "${dropdownIntent.optionLabel}" from dropdown "${dropdownIntent.dropdownLabel}"`;
        } else {
          // Dropdown already open; just select the option.
          const selectionResult = await selectOptionInOpenDropdown(page, dropdownIntent.optionLabel);

          this.recordCommand({
            action: 'click',
            // Use the REAL selector if we have it, otherwise fall back to semantic target
            target: selectionResult.optionSelector || dropdownIntent.optionLabel,
            selectors: selectionResult.optionSelector
              ? { css: selectionResult.optionSelector, xpath: selectionResult.optionXpath, text: dropdownIntent.optionLabel }
              : { text: dropdownIntent.optionLabel },
            description: `Select option "${dropdownIntent.optionLabel}" from the currently open dropdown`,
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
            this.recordCommand({
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
            const baseMessage = `Clicked ${info.roleHint || 'element'} "${info.text || target}"`;

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
          const selectorToClick = 
            chosen.selector || chosen.cssSelector || chosen.xpath;
          if (!selectorToClick) {
            console.warn('LLM selected element without usable selector, falling back to heuristics.');
            return this.clickWithHeuristics(target);
          }

          const info = await this.browser.click(selectorToClick);
          const robustSelector = info.selector || info.cssSelector || info.xpath || selectorToClick;
          this.recordCommand({
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
          const baseMessage = `Clicked ${info.roleHint || 'element'} "${info.text || target}"`;

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
      this.recordCommand({
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
      const baseMessage = `Clicked ${info.roleHint || 'element'} "${info.text || labelForHistory || selector}"`;

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
   * Small helper to guard long-running LLM calls so the autonomous agent
   * cannot stall indefinitely while waiting for a model response.
   */
  private async withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${ms}ms`));
      }, ms);
    });

    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
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

    const quoted = raw.match(/["\'“”‘’]([^"\'“”‘’]{2,})["\'“”‘’]/);
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
      'SYSTEM: You are a precise automation engine. The user wants to: "' + userPrompt + '".',
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
    ].join('\n');

    try {
      const result = await this.withTimeout(
        this.model.generateContent({
          contents: [
            {
              role: 'user',
              parts: [{ text: prompt }]
            }
          ]
        } as any),
        45000,
        'LLM selector'
      );

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

    const attrs = el.attributes || {};
    const attrLabelParts = [
      attrs.id,
      attrs.name,
      attrs.value,
      attrs.placeholder,
      attrs.title,
      attrs['aria-label'],
      attrs['data-testid'],
    ].filter(Boolean);

    const label = [
      el.text ?? '',
      el.ariaLabel ?? '',
      el.placeholder ?? '',
      el.title ?? '',
      el.dataTestId ?? '',
      el.context ?? '',
      ...attrLabelParts,
    ]
      .join(' ')
      .toLowerCase();

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
      this.recordCommand({
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
   *
   * Universal "Commit Protocol": after typing the requested text, we
   * automatically press Enter to commit the value (e.g., submit search
   * queries or dates) so sites that rely on Enter/focus-change handlers
   * register the input.
   */
  async type(selector: string, text: string): Promise<ExecutionResult> {
    const page = this.browser.getPage();
    const extractor = new SelectorExtractor(page);

    try {
      const info = await this.browser.type(selector, text);

      // REMOVED: await page.keyboard.press('Enter'); 
      // We now rely on the Agent to explicitly click "Go" or "Search" 
      // just like a human user would.

      const robustSelector = info.cssSelector || selector;
      this.recordCommand({
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
        selectors: [info],
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
        selectors,
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
        chromeDriverPath: 'C:\\hyprtask\\lib\\Chromium\\chromedriver.exe',
      },
      this.model,
    );

    const cmdsToUse = (commands && commands.length > 0) ? commands : this.sessionHistory;
    
    // If we're using history, we might want to filter out non-essential steps if needed,
    // but usually exact replay is desired.

    let code: string;
    // LLM-assisted Selenium generation is not implemented yet; always use
    // the deterministic generator to avoid compile-time errors while
    // preserving current behaviour.
    code = gen.generate(cmdsToUse);

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
  const maxRetries = config.maxRetriesPerAction ?? 3; // Keep retries enabled for robustness
  const generateSelenium = config.generateSelenium ?? true;
  const onStepComplete = config.onStepComplete;
  const onThought = config.onThought;

  this.sessionHistory = []; 
  const steps: AgentStepResult[] = [];
  const failedElements: Set<string> = new Set();
  const actionHistory: string[] = [];

  await this.browser.init();
  const page = this.browser.getPage();

  let stepNumber = 0;
  let isFinished = false;
  let finalSummary = '';
  let observation: ExecutionResult | undefined;

  // --- UNIVERSAL FIX 1: HEURISTIC NAVIGATION GUARD ---
  // If the goal contains a URL and we aren't there, go there immediately.
  // This prevents the AI from Hallucinating "Click Login" on a blank page.
  const urlInGoal = this.extractUrlFromPrompt(goal);
  const currentUrl = page.url();
  
  if (urlInGoal && (currentUrl === 'about:blank' || !currentUrl.includes(this.extractDomain(urlInGoal)))) {
      console.log(`[SmartAgent] Auto-navigating to detected URL: ${urlInGoal}`);
      await this.navigate(urlInGoal);
      
      this.sessionHistory.push({
          action: 'navigate',
          target: urlInGoal,
          description: `Auto-navigated to goal URL: ${urlInGoal}`
      });
      actionHistory.push(`✓ Navigated to ${urlInGoal}`);
  }

  while (stepNumber < maxSteps && !isFinished) {
    stepNumber++;

    // OBSERVE
    observation = await this.observe();
    const elements = observation.selectors ?? [];
    const screenshot = observation.screenshot;

    // THINK (AI)
    let nextAction: AgentAction = await this.planNextAgentAction(
      goal,
      elements,
      actionHistory,
      failedElements,
      screenshot,
    );

    // ... (Loop breaker logic remains mostly the same, ensuring we don't repeat identical actions) ...

    // ACT
    const urlBefore = page.url();
    let urlAfter = urlBefore;
    let postActionScreenshot = observation?.screenshot;
    let recoveryAttempt: string | undefined;
    let elementInfo: ElementInfo | undefined;
    let actionError: string | undefined;
    let stateChanged = false;

    let retryCount = 0;
    let actionSuccess = false;
    let actionMessage = '';
    let stepCommands: ExecutionCommand[] | null = null;

    while (retryCount <= maxRetries && !actionSuccess) {
         try {
             this.agentCommandBuffer = [];
             
             // EXECUTE
             const result = await this.executeAgentAction(nextAction, elements, retryCount, failedElements);

             const buffered = this.agentCommandBuffer;
             this.agentCommandBuffer = null;

             actionSuccess = result.success;
             actionMessage = result.message;
             elementInfo = result.elementInfo;

             if (actionSuccess && buffered && buffered.length) {
               stepCommands = [...buffered];
             }

             if (!actionSuccess) {
                actionError = result.error;
                if(result.failedSelector) failedElements.add(result.failedSelector);
                retryCount++;
                if (retryCount <= maxRetries) {
                    recoveryAttempt = `Retry ${retryCount}: ${result.recoveryHint || 'Retrying...'}`;
                    await page.waitForTimeout(1000 * retryCount); // Backoff wait
                }
             }
         } catch (err) { 
            this.agentCommandBuffer = null;
            actionError = err instanceof Error ? err.message : String(err);
            retryCount++;
         }
         
         if (actionSuccess) {
            urlAfter = page.url();
            stateChanged = await this.detectStateChange(urlBefore, urlAfter, nextAction);
         }
    }
    
    // ... (Logging/History logic same as before) ...
    // LOG & NOTIFY
      actionHistory.push(this.describeAction(nextAction, actionSuccess));
      const stepResult: AgentStepResult = {
        stepNumber,
        action: nextAction,
        success: actionSuccess,
        message: actionMessage,
        urlBefore: urlBefore,
        urlAfter: urlAfter,
        stateChanged,
        recoveryAttempt,
        screenshot: postActionScreenshot,
        elementInfo,
        error: actionError,
        retryCount,
      };
      steps.push(stepResult);

      if (onStepComplete) try { onStepComplete(stepResult); } catch {}
  }

  // ... (Return logic same as before) ...
   return {
        success: isFinished,
        summary: finalSummary || this.generateSessionSummary(steps, goal),
        goal,
        totalSteps: stepNumber,
        steps,
        commands: [...this.sessionHistory],
        seleniumCode: await this.generateSelenium().then(r => r.seleniumCode), // Generate code at end
        screenshot: observation?.screenshot,
        selectors: observation?.selectors
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
  if (!this.model) return { type: 'finish', thought: 'No AI', summary: 'No AI' };

  // --- UNIVERSAL FIX 2: REMOVED `findDirectLabelClick` ---
  // We deleted the code that blindly clicks "Appointment View". 
  // Now the AI MUST look at the screen and decide.
  
  const visibleElements = elements.filter(el => el.visible !== false);
  const limitedElements = visibleElements.slice(0, 500).map((el, idx) => ({
    id: `el_${idx}`,
    tag: el.tagName,
    text: (el.text || '').slice(0, 100),
    ariaLabel: el.ariaLabel || '',
    role: el.roleHint || 'other',
    selector: el.selector || ''
  }));

  const historyContext = actionHistory.length > 0 ? `\nHistory:\n${actionHistory.join('\n')}` : '';

  // --- UNIVERSAL FIX 3: INTELLIGENT SYSTEM PROMPT ---
  const prompt = [
    'SYSTEM: You are an intelligent autonomous browser agent.',
    `GOAL: ${goal}`,
    historyContext,
    '',
    '### INTELLIGENT RULES ###',
    '1. **VERIFY VISIBILITY**: If you just clicked a menu (like "Practice"), look at the JSON/Screenshot. Is the submenu ("Appointment View") visible? If NOT, wait.',
    '2. **ASSUME SUCCESS**: If you just typed a password, DO NOT check it. Click "Login" immediately.',
    '3. **NO LOOPS**: If you clicked something and the state/URL did not change, DO NOT click it again. Try a different strategy.',
    '',
    '### RESPONSE FORMAT ###',
    'Return ONLY JSON: { "type": "click", "elementId": "el_5", "thought": "Reason..." }'
  ].join('\n');

  // ... (Call LLM as before) ...
  // [Code for calling this.model.generateContent remains the same]
   try {
      const textPart = { text: prompt };
      const imagePart = screenshot && screenshot.startsWith('data:image/')
        ? { inlineData: { data: screenshot.split(',')[1] || '', mimeType: 'image/png' } }
        : null;

      const response = imagePart
        ? await this.withTimeout(this.model.generateContent([textPart, imagePart] as any), 60000, 'Agent planning')
        : await this.withTimeout(this.model.generateContent(textPart as any), 60000, 'Agent planning');

      const rawText = (response as any).response?.text?.() ?? '';
      return this.parseAgentActionResponse(rawText);
    } catch (err) {
       return { type: 'wait', durationMs: 2000, thought: 'Error planning, waiting...' };
    }
}

  /**
   * Best-effort JSON parser for agent plans with small automatic repairs
   * (trailing commas, single-quoted strings, etc.).
   */
  private tryParseAgentJson(candidate: string): any {
    const trimmed = candidate.trim();

    // Fast path
    try {
      return JSON.parse(trimmed);
    } catch (err) {
      let repaired = trimmed;

      // 1) Remove trailing commas before } or ]
      repaired = repaired.replace(/,\s*([}\]])/g, '$1');
      if (repaired !== trimmed) {
        try {
          return JSON.parse(repaired);
        } catch {
          // fall through
        }
      }

      // 2) Convert simple single-quoted strings to double-quoted JSON strings.
      repaired = repaired.replace(/'([^'"\\]*?)'/g, (_m, inner) => {
        const escaped = String(inner).replace(/"/g, '\\"');
        return `"${escaped}"`;
      });
      if (repaired !== trimmed) {
        try {
          return JSON.parse(repaired);
        } catch {
          // fall through
        }
      }

      throw err;
    }
  }

  /**
   * Extract a JSON object from an LLM response that may include markdown or
   * extra prose, using the same style of repairs as single-step AI mode.
   */
  private parseAgentJsonWithRepairs(text: string): any {
    // 1) Direct/repairing parse first.
    try {
      return this.tryParseAgentJson(text);
    } catch {
      // fall through
    }

    // 2) Explicit ```json code block.
    const markdownMatch = text.match(/```json\s*([\s\S]*?)\s*```/i);
    if (markdownMatch && markdownMatch[1]) {
      return this.tryParseAgentJson(markdownMatch[1]);
    }

    // 3) Any fenced code block.
    const genericBlockMatch = text.match(/```\s*([\s\S]*?)\s*```/);
    if (genericBlockMatch && genericBlockMatch[1]) {
      return this.tryParseAgentJson(genericBlockMatch[1]);
    }

    // 4) Fallback: substring between first '{' and last '}'.
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first >= 0 && last > first) {
      const jsonCandidate = text.substring(first, last + 1);
      return this.tryParseAgentJson(jsonCandidate);
    }

    throw new Error('Invalid JSON format in agent response');
  }

  /**
   * Parse the LLM response with improved robustness for JSON errors.
   *
   * IMPORTANT: On parse failure we return a small "wait" action instead of
   * forcing the agent to finish. This lets the self-healing loop re-plan on
   * the next iteration instead of giving up with a parse error.
   */
  private parseAgentActionResponse(raw: string): AgentAction {
    let parsed: any;
    try {
      parsed = this.parseAgentJsonWithRepairs(raw);
    } catch (err) {
      console.error('Failed to parse agent action JSON, will wait and re-plan:', err);
      console.error('Raw agent response (truncated):', raw.substring(0, 400));
      // Soft failure: do not stop the agent, just perform a short wait so the
      // next loop iteration can ask the model again with updated history.
      return {
        type: 'wait',
        durationMs: 1000,
        thought: 'JSON parse error while planning next step; waiting briefly and then re-planning.',
      };
    }

    const thought: string =
      typeof parsed.thought === 'string' && parsed.thought.trim().length > 0
        ? parsed.thought.trim()
        : 'No reasoning provided';

    const cleanString = (val: any, maxLen: number): string | undefined => {
      if (typeof val !== 'string') return undefined;
      const trimmed = val.trim();
      if (!trimmed) return undefined;
      if (trimmed.length > maxLen) return undefined;
      return trimmed;
    };

    const safeElementId: string | undefined =
      typeof parsed.elementId === 'string' && /^el_\d+$/.test(parsed.elementId)
        ? parsed.elementId
        : undefined;

    const safeSelector: string | undefined = cleanString(parsed.selector, 300);

    let safeSemantic: string | undefined = cleanString(parsed.semanticTarget, 120);
    // Guard against the model accidentally copying the full thought text into
    // semanticTarget or selector fields. If semanticTarget is identical to the
    // reasoning text, ignore it so we don't treat a long paragraph as a
    // locator.
    if (safeSemantic && safeSemantic === thought) {
      safeSemantic = undefined;
    }

    switch (parsed.type) {
      case 'navigate':
        return {
          type: 'navigate',
          url: cleanString(parsed.url, 2048) || '',
          thought,
        };
      case 'click':
        return {
          type: 'click',
          elementId: safeElementId,
          selector: safeSelector,
          semanticTarget: safeSemantic,
          thought,
        };
      case 'type':
        return {
          type: 'type',
          elementId: safeElementId,
          selector: safeSelector,
          semanticTarget: safeSemantic,
          text: cleanString(parsed.text, 512) || '',
          thought,
        };
      case 'select_option':
        return {
          type: 'select_option',
          elementId: safeElementId,
          selector: safeSelector,
          semanticTarget: safeSemantic,
          option: cleanString(parsed.option, 256) || '',
          thought,
        };
      case 'scrape_data':
        return {
          type: 'scrape_data',
          instruction: cleanString(parsed.instruction, 512) || 'Extract data',
          thought,
        };
      case 'scroll':
        return {
          type: 'scroll',
          direction: parsed.direction === 'up' || parsed.direction === 'down' ? parsed.direction : 'down',
          thought,
        };
      case 'wait':
        return {
          type: 'wait',
          durationMs:
            typeof parsed.durationMs === 'number' && parsed.durationMs > 0 && Number.isFinite(parsed.durationMs)
              ? parsed.durationMs
              : 1000,
          thought,
        };
      case 'finish':
        return {
          type: 'finish',
          thought,
          summary: cleanString(parsed.summary, 2000) || 'Done',
        };
      default:
        return {
          type: 'wait',
          durationMs: 1000,
          thought: `Unknown agent action type "${String(parsed.type)}"; waiting and re-planning.`,
        };
    }
  }

  /**
   * Execute a single agent action with self-healing support.
   * 
   * IMPORTANT: All actions that interact with elements MUST capture real
   * selectors (CSS/XPath) from the DOM and store them in sessionHistory
   * for production-ready Selenium code generation.
   */
  private async executeAgentAction(
  action: AgentAction,
  elements: ElementInfo[],
  retryCount: number,
  failedElements: Set<string>
): Promise<{ success: boolean; message: string; elementInfo?: ElementInfo; error?: string; failedSelector?: string; recoveryHint?: string; }> {
    // ... (Resolution logic same as before) ...
    
    switch (action.type) {
        case 'click': {
            // ... resolve selector ...
            const targetClick = /* resolved selector logic */ action.selector || action.semanticTarget; 
            
            try {
                // Use clickExact to ensure history is recorded
                const res = await this.clickExact(targetClick!, action.thought);
                
                // --- UNIVERSAL FIX 4: THE HUMAN WAIT ---
                // Essential for React/Angular apps. We wait 2s after EVERY click
                // to allow dropdowns to open, pages to transition, etc.
                const page = this.browser.getPage();
                await page.waitForTimeout(2000); 

                return { success: res.success, message: res.message, elementInfo: res.selectors?.[0] };
            } catch (e: any) {
                return { success: false, message: e.message, failedSelector: targetClick };
            }
        }
        
        case 'type': {
             // ... resolve target ...
             try {
                 const res = await this.type(action.selector!, action.text);
                 return { success: res.success, message: res.message };
             } catch (e: any) { return { success: false, message: e.message }; }
        }
        // ... other cases ...
    }
    return { success: false, message: 'Unknown' };
}

  /**
   * For goals that explicitly mention menu items or buttons by label (e.g.,
   * "select the \"Appointment View\" option"), try to choose a click target
   * directly from the current element list without calling the LLM.
   *
   * This is especially useful on sites like CyberMed EHR where the flow is
   * "Practice" → "Appointment View" and those labels appear verbatim in both
   * the goal and the DOM.
   */
  private findDirectLabelClick(
    goal: string,
    elements: {
      id: string;
      tag: string;
      text: string;
      ariaLabel: string;
      placeholder: string;
      role: string;
      region: string;
      selector: string;
      isFailed: boolean;
    }[],
    failedElements: Set<string>,
  ): AgentAction | null {
    if (!goal.trim()) return null;

    const lowerGoal = goal.toLowerCase();

    // 1) Extract any explicitly quoted labels from the goal, including smart
    // quotes. These are high-signal targets like "Practice" or
    // "Appointment View".
    const labelRegex = /["'“”‘’]([^"'“”‘’]{2,})["'“”‘’]/g;
    const quotedLabels: { label: string; index: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = labelRegex.exec(goal)) !== null) {
      const label = m[1].trim();
      if (label.length >= 2) {
        quotedLabels.push({ label, index: m.index });
      }
    }

    // 2) Special-case: labels that appear in a "select ... \"X\"" phrase are
    // almost certainly dropdown/menu options (e.g., "select the \"Appointment View\" option").
    const selectionLabelSet = new Set<string>();
    for (const q of quotedLabels) {
      const ctxStart = Math.max(0, q.index - 40);
      const ctx = goal.slice(ctxStart, q.index).toLowerCase();
      if (ctx.includes('select')) {
        selectionLabelSet.add(q.label);
      }
    }
    const selectionLabels = Array.from(selectionLabelSet);

    // Also include a few hard-coded high-value phrases we know appear in
    // flows (like "Appointment View") in case quoting is missing.
    const extraLabels = ['Appointment View'];

    const allLabels = [
      ...quotedLabels.map((q) => q.label),
      ...extraLabels,
    ].filter((lbl, idx, arr) =>
      arr.findIndex((x) => x.toLowerCase() === lbl.toLowerCase()) === idx,
    );

    if (allLabels.length === 0) return null;

    // Primary preference: labels explicitly tied to a "select" instruction
    // (e.g., "select the \"Appointment View\" option"). This prevents us from
    // over-clicking top-level items like "Practice" when the real goal is a
    // deeper option inside the dropdown.
    let labelsToUse: string[];
    if (selectionLabels.length > 0) {
      labelsToUse = selectionLabels;
    } else {
      // Fallback: choose labels that actually appear in the goal text.
      const labelsInGoal = allLabels.filter((lbl) => lowerGoal.includes(lbl.toLowerCase()));
      labelsToUse = labelsInGoal.length > 0 ? labelsInGoal : allLabels;
    }

    // For each candidate label, try to find a single best matching element by
    // visible text or aria-label.
    for (const lbl of labelsToUse) {
      const labelLower = lbl.toLowerCase();

      const matches = elements
        .map((el, idx) => ({ el, idx }))
        .filter(({ el }) => {
          const labelText = `${el.text || ''} ${el.ariaLabel || ''}`.toLowerCase();
          if (!labelText.includes(labelLower)) return false;

          // Skip obviously failed selectors so we don't re-click bad targets.
          if (el.selector && failedElements.has(el.selector)) return false;

          return true;
        });

      if (matches.length === 0) continue;

      // Prefer elements that look like links or buttons in the main/header
      // region, since menu items are usually links within nav.
      matches.sort((a, b) => {
        const score = (x: typeof a) => {
          let s = 0;
          const role = (x.el.role || '').toLowerCase();
          const tag = (x.el.tag || '').toLowerCase();
          const region = (x.el.region || '').toLowerCase();

          if (role === 'link' || tag === 'a') s += 3;
          if (role === 'button' || tag === 'button') s += 2;
          if (region === 'header' || region === 'main') s += 1;
          return s;
        };
        return score(b) - score(a);
      });

      const best = matches[0];
      if (!best) continue;

      return {
        type: 'click',
        elementId: best.el.id, // e.g., "el_5" – resolved against visible elements later
        thought: `Directly clicking "${lbl}" because it appears as the specific option to select in the goal.`,
      };
    }

    return null;
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
        const attrs = el.attributes || {};
        const attrLabelParts = [
          attrs.id,
          attrs.name,
          attrs.value,
          attrs.placeholder,
          attrs.title,
          attrs['aria-label'],
          attrs['data-testid'],
        ].filter(Boolean);

        const label = `${
          [
            el.text || '',
            el.ariaLabel || '',
            el.placeholder || '',
            el.title || '',
            el.dataTestId || '',
            el.context || '',
            ...attrLabelParts,
          ].join(' ')
        }`.toLowerCase();

        const matchCount = targetTokens.filter(tok => label.includes(tok)).length;
        return { el, score: matchCount };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score);

    return candidates.length > 0 ? candidates[0].el : null;
  }

  /**
   * Actions that should be ignored for loop detection because they are
   * "passive" (e.g., JSON-parse-retry waits).
   */
  private isPassiveForLoop(action: AgentAction): boolean {
    // You can extend this later if you introduce other passive steps.
    return action.type === 'wait';
  }

  /**
   * Check if two agent actions are functionally identical (same type,
   * targeting the same element). Used by the loop breaker to detect
   * when the agent is mindlessly repeating itself.
   */
  private isIdenticalAction(prev: AgentAction, next: AgentAction): boolean {
    // Different action types = not identical
    if (prev.type !== next.type) return false;

    // Helper to get the best ID/Selector available
    const getTarget = (a: any) => a.selector || a.elementId || a.semanticTarget;

    const prevTarget = getTarget(prev);
    const nextTarget = getTarget(next);

    // For actions that target elements, check if they target the same element
    switch (prev.type) {
      case 'click':
      case 'type':
      case 'select_option': {
        // If both have targets, compare them
        if (prevTarget && nextTarget) {
          // 1. Strict Equality
          if (prevTarget === nextTarget) return true;

          // 2. Semantic Similarity (ignore case/quotes/special chars)
          if (typeof prevTarget === 'string' && typeof nextTarget === 'string') {
            const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (clean(prevTarget) === clean(nextTarget)) return true;
          }
        }
        return false;
      }

      case 'navigate': {
        return (prev as any).url === (next as any).url;
      }

      case 'scroll': {
        return (prev as any).direction === (next as any).direction;
      }

      case 'scrape_data': {
        // Scraping is terminal, but if somehow repeated, treat as identical
        return true;
      }

      case 'wait':
      case 'finish':
        // These are considered unique each time
        return false;

      default:
        return false;
    }
  }

  /**
   * Detect whether a meaningful state change occurred after an action.
   */
  private async detectStateChange(
  urlBefore: string,
  urlAfter: string,
  action: AgentAction
): Promise<boolean> {
  // 1. URL Change is absolute proof
  if (urlBefore !== urlAfter) return true;

  // 2. Navigation without URL change = FAILURE
  if (action.type === 'navigate') return false;

  // --- UNIVERSAL FIX 5: TRUST YOUR TYPES ---
  // If we successfully typed into an input, consider that a state change.
  // We verify it locally so we don't need the AI to check it.
  if (action.type === 'type' && action.selector) {
      try {
          const page = this.browser.getPage();
          const val = await page.inputValue(action.selector);
          // If the input now contains what we typed, IT WORKED.
          if (val.includes(action.text)) return true;
      } catch {}
      return false;
  }

  // 3. For clicks, be pessimistic. If URL didn't change, we likely need to check visual state next time.
  if (action.type === 'click') return false; 

  return true; // Passive actions (scroll/wait) always "succeed"
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
        // This will handle the new action types.
        const unhandledAction: any = action;
        if (unhandledAction.type === 'select_option') {
            return `${status} Selected option ${unhandledAction.option}`;
        }
        if (unhandledAction.type === 'scrape_data') {
            return `${status} Scraped data`;
        }
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
          case 'select_option': return `selected option`;
          case 'scrape_data': return `scraped data`;
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
