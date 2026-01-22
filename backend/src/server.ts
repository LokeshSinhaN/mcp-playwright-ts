import express from 'express';
import http from 'http';
import cors from 'cors';
import WebSocket, { WebSocketServer } from 'ws';
import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import { BrowserManager } from './browserManager';
import { McpTools } from './mcpTools';
import { ExecutionResult, WebSocketMessage, ExecutionCommand, ElementInfo, AgentSessionResult, AgentConfig } from './types';
import { parseDropdownInstruction } from './dropdownUtils';

// Minimal conversation turn type if you later add real AI calls.
interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Small helper: detect if a natural language prompt is really asking to
 * navigate to a website, e.g. "go to mayoclinic website".
 */
function extractUrlFromPrompt(prompt: string): string | null {
  const trimmed = prompt.trim();

  // 1) explicit URL with protocol
  const explicit = trimmed.match(/https?:\/\/\S+/i);
  if (explicit) return explicit[0];

  // 2) bare domain like "mayoclinic.org" or "example.com/path"
  const domain = trimmed.match(/\b[\w.-]+\.(com|org|net|gov|edu|io|ai|co)(?:\S*)/i);
  if (domain) {
    const candidate = domain[0];
    return candidate.startsWith('http') ? candidate : `https://${candidate}`;
  }

  // 3) phrases like "go to mayoclinic website" or "open google site"
  const goTo = trimmed.match(/\b(?:go to|open|navigate to|visit)\s+([^'"\n]+?)\s+(?:website|site|page)\b/i);
  if (goTo) {
    const rawName = goTo[1].trim();
    if (rawName) {
      const slug = rawName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '')
        .replace(/^(www)+/g, '');
      if (slug.length > 0) {
        return `https://www.${slug}.com`;
      }
    }
  }

  return null;
}

/**
 * Detect if a prompt contains multiple sequential actions that should trigger
 * autonomous agent mode instead of single-step execution.
 */
function detectMultiStepPrompt(prompt: string): boolean {
  const lower = prompt.toLowerCase();

  // 1. Explicit Agent Keywords
  if (lower.includes('agent') || lower.includes('step by step') || lower.includes('steps')) return true;

  // 2. Complex Workflow Indicators - count connector words
  const complexConnectors = [
    ' and ', ' then ', ' after ', ' followed by ', ' next ', ',',
    ' first ', ' second ', ' finally '
  ];

  // Count how many connectors appear
  const connectorCount = complexConnectors.reduce((count, word) =>
    lower.includes(word) ? count + 1 : count, 0);

  // If we see 1 or more connectors, it's a workflow.
  if (connectorCount >= 1) return true;

  // 3. Action Verb Density
  const actionVerbs = [
    'click', 'type', 'enter', 'fill', 'select', 'choose',
    'navigate', 'go to', 'visit', 'open', 'search', 'submit',
    'scroll', 'wait', 'verify', 'check', 'extract', 'scrape'
  ];

  const actionCount = actionVerbs.filter(verb => {
    // strict word boundary matching to avoid false positives
    const regex = new RegExp(`\\b${verb}\\b`, 'i');
    return regex.test(lower);
  }).length;

  // Reduced threshold: If prompt has 1+ action verbs, treat as Agent task
  if (actionCount >= 1) return true;

  return false;
}

// Helper: build a compact DOM context summary for future AI integrations.
function buildDomContext(elements: ElementInfo[], maxItems = 80): string {
  const lines: string[] = [];
  const visible = elements.filter((el) => el.visible !== false);
  const pool = visible.length > 0 ? visible : elements;

  for (const [index, el] of pool.slice(0, maxItems).entries()) {
    const text = (el.text ?? '').replace(/\s+/g, ' ').trim();
    const aria = el.ariaLabel ?? '';
    const label = text || aria || '(no text)';
    const selector = el.cssSelector ?? el.xpath ?? '';
    const region = el.region ?? 'main';
    const flags: string[] = [];
    if (el.searchField) flags.push('searchField');
    if (el.roleHint && el.roleHint !== 'other') flags.push(el.roleHint);
    const flagsStr = flags.length ? ` [${flags.join(', ')}]` : '';
    lines.push(
      `${index + 1}. (${region}) <${el.tagName}> label="${label.slice(0, 80)}" selector="${selector.slice(
        0,
        120
      )}"${flagsStr}`
    );
  }

  return lines.join('\n');
}

// Helper: attempt to parse a JSON-like string, applying small repairs when needed.
function tryParseJson(candidate: string): any {
  const trimmed = candidate.trim();

  // 1) Direct parse.
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    // 2) Remove trailing commas before } or ] (very common LLM mistake).
    let repaired = trimmed.replace(/,\s*([}\]])/g, '$1');
    if (repaired !== trimmed) {
      try {
        return JSON.parse(repaired);
      } catch {
        // continue to next repair step
      }
    }

    // 3) Convert simple single-quoted strings to double-quoted JSON strings.
    //    This is conservative: we only touch segments that look like valid
    //    string literals without embedded quotes.
    repaired = repaired.replace(/'([^'"\\]*?)'/g, (_m, inner) => {
      const escaped = String(inner).replace(/"/g, '\\"');
      return `"${escaped}"`;
    });
    if (repaired !== trimmed) {
      try {
        return JSON.parse(repaired);
      } catch {
        // fall through to final failure below
      }
    }

    // If we still fail, rethrow the original error; caller will decide how to handle it.
    throw err;
  }
}

// Helper: Clean LLM responses that contain Markdown or conversational text and extract JSON.
function parseAiResponse(text: string): any {
  // Fast path: try direct/repairing parse first.
  try {
    return tryParseJson(text);
  } catch {
    // fall through to more robust strategies below
  }

  // 1) Look for a fenced ```json code block.
  const markdownMatch = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (markdownMatch && markdownMatch[1]) {
    const inner = markdownMatch[1].trim();
    return tryParseJson(inner);
  }

  // 2) Look for any fenced ``` code block.
  const genericBlockMatch = text.match(/```\s*([\s\S]*?)\s*```/);
  if (genericBlockMatch && genericBlockMatch[1]) {
    const inner = genericBlockMatch[1].trim();
    return tryParseJson(inner);
  }

  // 3) Fallback: Find the first '{' and last '}' to strip surrounding chatter.
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const jsonCandidate = text.substring(first, last + 1).trim();
    return tryParseJson(jsonCandidate);
  }

  // If we reach here, we have no plausible JSON object.
  throw new Error(`Invalid JSON format. Raw output (truncated): ${text.substring(0, 100)}...`);
}

export function createServer(port: number, chromePath?: string) {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  // Initialize a shared Gemini model instance once and inject it into tools.
  const apiKey = process.env.GEMINI_API_KEY;
  const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  let model: GenerativeModel | null = null;
  if (apiKey) {
    const genAI = new GoogleGenerativeAI(apiKey);
    model = genAI.getGenerativeModel({ model: modelName });
  }

  const browser = new BrowserManager({
    headless: true,
    timeoutMs: 5000,
    // Use a larger viewport to approximate a maximized browser window in
    // the preview UI.
    viewport: { width: 1600, height: 900 },
    chromePath
  });
  const tools = new McpTools(browser, model ?? undefined);
 
   const clients = new Set<WebSocket>();
 
   // Deterministic helper: for clear cookie-banner intents (accept/allow/close
   // cookies), try the dedicated cookie handler before invoking the LLM. This
   // avoids unnecessary hallucinations when the task is simple.
   async function maybeHandleCookieFromPrompt(prompt: string, elements: ElementInfo[]): Promise<ExecutionResult | null> {
     const lower = prompt.toLowerCase();
 
     if (!/cookie/.test(lower)) return null;
     if (!/(accept|allow|agree|ok|close|dismiss|reject|deny)/.test(lower)) return null;
 
     const result = await tools.handleCookieBanner(elements);
     // tools.handleCookieBanner always returns success=true; only treat it as
     // a real action if a banner was actually dismissed.
     if (result.message.toLowerCase().startsWith('cookie banner dismissed')) {
       return result;
     }
 
     return null;
   }

  // Simple in-memory history placeholder; you can wire this into a real
  // AI call later if needed.
  const conversationHistory: ConversationTurn[] = [];

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  function broadcast(msg: WebSocketMessage) {
    const payload = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }

  async function handleAiAction(prompt: string, selector?: string): Promise<ExecutionResult> {
    if (!model) {
      return {
        success: false,
        message: 'GEMINI_API_KEY is not configured on the server',
        error: 'Missing GEMINI_API_KEY environment variable'
      };
    }

    // 1) LOOK: capture current page state and candidate elements.
    await browser.init();
    const observation = await tools.observe(true);
    const elements = observation.selectors ?? [];

    // For obvious cookie-banner prompts, prefer the deterministic handler
    // first so the LLM does not need to plan anything.
    const cookieResult = await maybeHandleCookieFromPrompt(prompt, elements);
    if (cookieResult) {
      return cookieResult;
    }

    type AiElement = {
      /** Stable identifier used by the LLM to reference this element. */
      elementId: string;
      /** Raw DOM id attribute, if present. */
      domId: string;
      tagName: string;
      role: 'button' | 'link' | 'input' | 'option' | 'listbox' | 'other';
      region: 'header' | 'main' | 'footer' | 'sidebar';
      text: string;
      ariaLabel: string;
      placeholder: string;
      title: string;
      dataTestId: string;
      href: string;
      context: string;
      /** Primary selector for interaction (CSS/XPath). */
      selector: string;
      visible: boolean;
      /** Optional bounding box in viewport coordinates. */
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      /** Human-readable location summary for the LLM (e.g. "x:120,y:340"). */
      location: string;
      attributes: Record<string, string | undefined>;
    };

    const baseCandidates: AiElement[] = elements
      .map((el, idx) => {
        const selectorValue = el.selector ?? el.cssSelector ?? el.xpath ?? '';
        const rect = el.boundingBox ?? el.rect;
        const x = rect?.x;
        const y = rect?.y;
        const width = rect?.width;
        const height = rect?.height;
        const hasCoords =
          typeof x === 'number' && typeof y === 'number' && typeof width === 'number' && typeof height === 'number';

        return {
          elementId: `el_${idx}`,
          domId: el.id ?? '',
          tagName: (el.tagName || '').toLowerCase(),
          role: el.roleHint ?? 'other',
          region: el.region ?? 'main',
          text: el.text ?? '',
          ariaLabel: el.ariaLabel ?? '',
          placeholder: el.placeholder ?? '',
          title: el.title ?? '',
          dataTestId: el.dataTestId ?? '',
          href: el.href ?? '',
          context: el.context ?? '',
          selector: selectorValue,
          visible: el.visible !== false && el.isVisible !== false,
          x: hasCoords ? Math.round(x as number) : undefined,
          y: hasCoords ? Math.round(y as number) : undefined,
          width: hasCoords ? Math.round(width as number) : undefined,
          height: hasCoords ? Math.round(height as number) : undefined,
          location: hasCoords
            ? `x:${Math.round(x as number)},y:${Math.round(y as number)},w:${Math.round(
                width as number
              )},h:${Math.round(height as number)}`
            : 'unknown',
            attributes: el.attributes,
        } satisfies AiElement;
      })
      .filter((e) => !!e.selector);

    // Prefer visible elements only, but otherwise preserve the natural DOM order
    // as returned by the extractor so the model can infer relationships from
    // spatial layout (labels next to inputs, grouped controls, etc.).
    const aiElements: AiElement[] = baseCandidates.filter((e) => e.visible);

    // Limit the number of elements we send to Gemini to keep the request small,
    // but preserve order instead of re-ranking heuristically. Increase the cap
    // on complex sites so important elements below the fold are still visible.
    const limitedElements = aiElements.slice(0, 300);
    const elementsJson = JSON.stringify(limitedElements, null, 2);

    type ReasonedAction =
      | { thought: string; action: 'navigate'; url: string }
      | { thought: string; action: 'click'; elementId?: string; semanticTarget?: string }
      | { thought: string; action: 'type'; elementId?: string; semanticTarget?: string; text: string }
      | { thought: string; action: 'noop' };

    const heuristicUrl = extractUrlFromPrompt(prompt);

    // 2) THINK: build a constrained planning prompt.
    const lines: string[] = [];
    lines.push('SYSTEM ROLE: You are a Selenium Code Generation Specialist.');
    lines.push(
      'Your primary goal is to choose the **exact DOM element** that best satisfies the user request so that reliable Selenium code can be generated later.'
    );
    lines.push(
      'You see a JSON list of interactive elements (`elements`) and an optional screenshot of the current page.'
    );
    lines.push(
      'You MUST select elements by analyzing exact text and attributes from the JSON list. Use the screenshot ONLY to verify visibility/position when multiple JSON candidates look similar.'
    );
    lines.push('Never guess selectors or invent elements that are not present in the JSON list.');
    lines.push('');
    lines.push('User request:');
    lines.push(prompt);
    lines.push('');
    lines.push('Heuristic URL parsed from the request (may be empty if none found):');
    lines.push(heuristicUrl ?? '');
    lines.push('');
    lines.push('You may ONLY click or type into elements from the following JSON array named "elements":');
    lines.push('elements = ' + elementsJson);
    lines.push('');
    lines.push('### INSTRUCTIONS ###');
    lines.push('- The viewport coordinate system starts at the top-left corner (x=0,y=0).');
    lines.push('- The "location" field encodes the element bounding box as x,y,w,h.');
    lines.push('- Larger y values mean the element is lower on the page; larger x values mean it is further to the right.');
    lines.push('- When the user says "under" some text, prefer elements with a greater y (below) but similar x-range.');
    lines.push('- When the user says "above", prefer elements with a smaller y (above).');
    lines.push('');
    lines.push('Reasoning requirements:');
    lines.push('- Always think step-by-step about which element best matches the request.');
    lines.push(
      '- Prefer elements whose DOM attributes (id, dataTestId, text, ariaLabel, placeholder, title, href, context) closely match the user request.'
    );
    lines.push(
      '- When you can confidently map the request to a specific element in `elements`, output its `elementId` field.'
    );
    lines.push(
      '- ONLY when there is **no** suitable element in the JSON list, omit `elementId` and instead set `semanticTarget` to a short natural-language description (e.g., "Login button").'
    );
    lines.push('- If no safe or relevant action can be taken, choose action "noop".');
    lines.push('');
    lines.push('### RESPONSE FORMAT ###');
    lines.push(
      'You MUST return ONLY a raw JSON object. Do not wrap it in markdown (```json). Do not add explanations outside the JSON.'
    );
    lines.push('Example:');
    lines.push(
      '{ "thought": "I see the login button in the main section", "action": "click", "elementId": "el_12" }'
    );
    lines.push('');
    lines.push('Return ONLY a JSON object of this TypeScript union type (no markdown, no comments):');
    lines.push('type ReasonedAction =');
    lines.push('  | { "thought": string; "action": "navigate"; "url": string }');
    lines.push(
      '  | { "thought": string; "action": "click"; "elementId"?: string; "semanticTarget"?: string }'
    );
    lines.push(
      '  | { "thought": string; "action": "type"; "elementId"?: string; "semanticTarget"?: string; "text": string }'
    );
    lines.push('  | { "thought": string; "action": "noop" };');
    lines.push('');
    lines.push('Field rules:');
    lines.push('- `thought` must contain your step-by-step reasoning in plain English.');
    lines.push('- For `click` and `type`, prefer setting `elementId` that exactly matches one of elements[].elementId.');
    lines.push('- Only use `semanticTarget` when no suitable elementId exists; this string will be used for fuzzy matching.');

    const planningPrompt = lines.join('\n');

    // Build multimodal parts for Gemini: a text prompt and a PNG screenshot.
    const screenshotDataUrl = observation.screenshot;
    const imageBase64 =
      screenshotDataUrl && screenshotDataUrl.startsWith('data:image/png;base64,')
        ? screenshotDataUrl.replace('data:image/png;base64,', '')
        : screenshotDataUrl && screenshotDataUrl.startsWith('data:')
        ? screenshotDataUrl.split(',')[1]
        : screenshotDataUrl || undefined;

    const textPart = { text: planningPrompt } as const;
    const imagePart =
      imageBase64 != null
        ? ({
            inlineData: {
              data: imageBase64,
              mimeType: 'image/png'
            }
          } as const)
        : null;

    const response = imagePart
      ? await model.generateContent([textPart, imagePart] as any)
      : await model.generateContent(textPart as any);

    const rawText = (response as any).response.text();
    console.log('Gemini raw response:', rawText);

    let parsed: ReasonedAction;
    try {
      parsed = parseAiResponse(rawText) as ReasonedAction;
    } catch (err) {
      // Log detailed info for debugging, but degrade gracefully for the client.
      console.error('Failed to parse AI plan from Gemini:', err);
      console.error('Raw AI response (truncated):', rawText.slice(0, 400));

      // Fall back to a safe no-op style response instead of hard-failing the
      // /execute API. This keeps the session usable even if the model occasionally
      // returns slightly malformed JSON.
      return {
        ...observation,
        success: true,
        message: 'Observed page only (AI response was not valid structured JSON, no action taken)',
        // Preserve selectors/screenshot so the frontend still has full context.
        selectors: elements
      };
    }

    // OBSERVABILITY: broadcast the model's reasoning before executing any action.
    if ((parsed as any).thought) {
      broadcast({
        type: 'log',
        timestamp: new Date().toISOString(),
        message: `ai_thought: ${String(parsed.thought).slice(0, 400)}`,
        data: {
          role: 'reason-then-act',
          thought: parsed.thought,
          action: parsed.action,
          plan: parsed
        }
      });
    }

    // Detect dropdown-style intents once, based on the original natural-language
    // prompt so we can route them through the specialised dropdown helper
    // instead of treating them as a generic "click" on the <select> element.
    const dropdownIntentFromPrompt = parseDropdownInstruction(prompt);

    // 3) ACT: route to the appropriate tool based on the structured plan.
    switch (parsed.action) {
      case 'navigate': {
        const targetUrl = parsed.url || heuristicUrl || '';
        if (!targetUrl) {
          return {
            ...observation,
            success: false,
            message: 'AI requested navigation but did not provide a URL',
            error: 'Missing URL in ReasonedAction'
          };
        }
        return tools.navigate(targetUrl);
      }
      case 'click': {
        // For dropdown-selection prompts like "Select the Indiana option from the
        // drop down menu", the most reliable behaviour is to reuse the
        // specialised dropdown helper wired into McpTools.click(). When a
        // dropdown intent is detected from the original prompt, we deliberately
        // ignore the model's chosen elementId and let the dropdown helper
        // resolve the appropriate trigger and option using its own heuristics
        // and LLM-assisted matching.
        if (dropdownIntentFromPrompt) {
          return tools.clickWithHeuristics(prompt, limitedElements);
        }

        const byId = parsed.elementId
          ? limitedElements.find((e) => e.elementId === parsed.elementId)
          : undefined;

        // STRICT ID PRIORITY: when a matching elementId exists, we still require
        // its visible labels to have meaningful overlap with the original
        // natural-language prompt. This prevents the system from blindly
        // clicking elements like "Test Autofill" when the user asked for
        // "Credit Card", while still allowing inputs that are only labelled via
        // placeholder, title, or nearby context.
        if (byId && byId.selector) {
          const promptText = (prompt || '').toLowerCase();
          const promptTokens = promptText
            .split(/[^a-z0-9]+/)
            .filter((t) => t.length >= 3)
            .filter((t) => !['click', 'press', 'tap', 'open', 'go', 'goto', 'the', 'this', 'that', 'button', 'link', 'tab', 'menu', 'dropdown', 'drop', 'down', 'header', 'footer'].includes(t));

          const labelBlob = [
            byId.text,
            byId.ariaLabel,
            byId.dataTestId,
            byId.placeholder,
            byId.title,
            byId.context,
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
            .trim();

          const hasOverlap =
            promptTokens.length === 0 ||
            (labelBlob && promptTokens.some((tok) => labelBlob.includes(tok)));

          if (!hasOverlap) {
            const screenshot = observation.screenshot ?? (await browser.screenshot().catch(() => undefined as any));
            return {
              ...observation,
              success: false,
              message: `No element with text matching the request "${prompt}" could be safely identified. AI suggested "${byId.text || byId.ariaLabel || byId.selector}", which does not share key words with the prompt, so no click was performed.`,
              error: 'No strong overlap between prompt and chosen element',
              screenshot,
            };
          }

          // At this point the planner has selected a concrete elementId and its
          // labels semantically match the user's request. We can safely perform
          // a direct selector-based click without re-running a second round of
          // heuristic matching that might reintroduce ambiguity.
          const historyLabel =
            prompt ||
            byId.text ||
            byId.ariaLabel ||
            byId.dataTestId ||
            byId.context ||
            byId.selector;

          return tools.clickExact(byId.selector);
        }

        // Fallback: semantic target for fuzzy matching inside McpTools.
        if (parsed.semanticTarget) {
          return tools.clickWithHeuristics(parsed.semanticTarget, limitedElements);
        }

        return {
          ...observation,
          success: false,
          message:
            'AI returned a click action without a valid elementId or semanticTarget; no action was taken.',
          error: 'Invalid ReasonedAction for click'
        };
      }
      case 'type': {
        const byId = parsed.elementId
          ? limitedElements.find((e) => e.elementId === parsed.elementId)
          : undefined;

        // STRICT ID PRIORITY: when a matching elementId exists, always use its selector.
        if (byId && byId.selector) {
          return tools.type(byId.selector, parsed.text);
        }

        // Fallback: semantic target for fuzzy matching inside McpTools.
        if (parsed.semanticTarget) {
          return tools.type(parsed.semanticTarget, parsed.text);
        }

        return {
          ...observation,
          success: false,
          message:
            'AI returned a type action without a valid elementId or semanticTarget; no action was taken.',
          error: 'Invalid ReasonedAction for type'
        };
      }
      case 'noop':
      default:
        // Just return the observation; AI chose to do nothing.
        return {
          ...observation,
          success: true,
          message: (parsed.action === 'noop'
              ? 'Observed page only (AI chose no safe action)'
              : 'Observed page only (AI action was unrecognized)')
        };
    }
  }

  app.post('/api/execute', async (req, res) => {
    const { action, url, selector, text, commands, prompt, agentConfig } = req.body as {
      action: string;
      url?: string;
      selector?: string;
      text?: string;
      commands?: ExecutionCommand[];
      prompt?: string;
      agentConfig?: Partial<AgentConfig>;
    };

    let result: ExecutionResult;

    try {
      switch (action) {
        case 'navigate':
          if (!url) throw new Error('url required');
          broadcast({ type: 'action', timestamp: new Date().toISOString(), message: `navigate ${url}` });
          result = await tools.navigate(url);
          break;
        case 'click':
          if (!selector) throw new Error('selector required');
          broadcast({ type: 'action', timestamp: new Date().toISOString(), message: `click ${selector}` });
          result = await tools.clickExact(selector);
          break;
        case 'type':
          if (!selector || text == null) throw new Error('selector and text required');
          broadcast({ type: 'action', timestamp: new Date().toISOString(), message: `type in ${selector}` });
          result = await tools.type(selector, text);
          break;
        case 'handle_cookie_banner':
          broadcast({ type: 'action', timestamp: new Date().toISOString(), message: 'handle_cookie_banner' });
          result = await tools.handleCookieBanner((await tools.observe()).selectors);
          break;
        case 'extract_selectors':
          broadcast({ type: 'action', timestamp: new Date().toISOString(), message: 'extract_selectors' });
          result = { success: true, message: 'Selectors extracted', ...(await tools.observe()) };
          break;
        case 'observe':
          broadcast({ type: 'action', timestamp: new Date().toISOString(), message: 'observe' });
          result = { success: true, message: 'Page observed', ...(await tools.observe(true)) };
          break;
        case 'ai': {
          if (!prompt) throw new Error('prompt required');

          // SMART ROUTING: Detect if this is a multi-step task and route to agent mode
          const isMultiStep = detectMultiStepPrompt(prompt);
          
          if (isMultiStep) {
            // Auto-route to autonomous agent for complex tasks
            broadcast({
              type: 'log',
              timestamp: new Date().toISOString(),
              message: `Prompt detected as multi-step. Starting agent: "${prompt.slice(0, 100)}"`
            });

            const config: AgentConfig = {
              maxSteps: agentConfig?.maxSteps ?? 30, // Increased for complex multi-step tasks
              maxRetriesPerAction: 2, // Allow more retries for reliability
              generateSelenium: agentConfig?.generateSelenium ?? true,
              broadcast,
            };

            const agentResult: AgentSessionResult = await tools.runAutonomousAgent(prompt, config);

            broadcast({
              type: agentResult.success ? 'success' : 'error',
              timestamp: new Date().toISOString(),
              message: `ai_agent completed: ${agentResult.summary.slice(0, 150)}`,
              data: {
                totalSteps: agentResult.totalSteps,
                success: agentResult.success,
              }
            });

            result = {
              success: agentResult.success,
              message: agentResult.summary,
              screenshot: agentResult.screenshot,
              selectors: agentResult.selectors,
              seleniumCode: agentResult.seleniumCode,
              data: {
                goal: agentResult.goal,
                totalSteps: agentResult.totalSteps,
                steps: agentResult.steps,
                commands: agentResult.commands,
              }
            };
          } else {
            // Single-step mode for simple tasks
            broadcast({
              type: 'log',
              timestamp: new Date().toISOString(),
              message: `Prompt detected as single-step. Planning one action.`
            });

            result = await handleAiAction(prompt, selector);
          }
          break;
        }
        case 'ai_agent': {
          // Autonomous agent mode: takes a high-level goal and executes
          // a multi-step plan with self-healing capabilities
          if (!prompt) throw new Error('prompt required for ai_agent');

          broadcast({
            type: 'action',
            timestamp: new Date().toISOString(),
            message: `ai_agent starting: "${prompt.slice(0, 100)}"`
          });

          // Build agent config with real-time broadcasting
          const config: AgentConfig = {
            maxSteps: agentConfig?.maxSteps ?? 30, // Increased for complex multi-step tasks
            maxRetriesPerAction: 2, // Allow more retries for reliability
            generateSelenium: agentConfig?.generateSelenium ?? true,
            broadcast,
          };

          // --- START SCREENSHOT STREAM ---
          // Wrap the agent execution in a try/finally to ensure the stream is
          // always stopped, even if the agent fails.
          let agentResult: AgentSessionResult;
          try {
            agentResult = await tools.runAutonomousAgent(prompt, config);
          } finally {
            // --- STOP SCREENSHOT STREAM ---
          }

          // Broadcast completion
          broadcast({
            type: agentResult.success ? 'success' : 'error',
            timestamp: new Date().toISOString(),
            message: `ai_agent completed: ${agentResult.summary.slice(0, 150)}`,
            data: {
              totalSteps: agentResult.totalSteps,
              success: agentResult.success,
            }
          });

          // Return the full agent result (includes steps, commands, selenium code)
          result = {
            success: agentResult.success,
            message: agentResult.summary,
            screenshot: agentResult.screenshot,
            selectors: agentResult.selectors,
            seleniumCode: agentResult.seleniumCode,
            data: {
              goal: agentResult.goal,
              totalSteps: agentResult.totalSteps,
              steps: agentResult.steps,
              commands: agentResult.commands,
            }
          };
          break;
        }
        case 'generate_selenium':
          // We allow commands to be optional now, defaulting to session history
          broadcast({ type: 'action', timestamp: new Date().toISOString(), message: 'generate_selenium' });
          result = { ...(await tools.generateSelenium(commands)), message: 'Selenium code generated' };
          break;
        default:
          result = { success: false, message: `Unknown action: ${action}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      broadcast({ type: 'error', timestamp: new Date().toISOString(), message: msg });
      result = { success: false, message: msg, error: msg };
    }

    broadcast({
      type: result.success ? 'success' : 'error',
      timestamp: new Date().toISOString(),
      message: result.message,
      data: result
    });

    res.json(result);
  });

  app.get('/api/screenshot', async (_req, res) => {
    try {
      const img = await browser.screenshot();
      res.json({ success: true, screenshot: img });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: msg });
    }
  });

  app.get('/api/health', (_req, res) => {
    res.json({ success: true, browserOpen: browser.isOpen() });
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.send(
      JSON.stringify({
        type: 'log',
        timestamp: new Date().toISOString(),
        message: 'Connected to execution stream'
      } satisfies WebSocketMessage)
    );

    if (clients.size === 1) {
      browser.startScreenshotStream((payload: string) => {
        for (const ws of clients) {
          if (ws.readyState === WebSocket.OPEN) ws.send(payload);
        }
      });
    }

    ws.on('close', () => {
      clients.delete(ws);
      if (clients.size === 0) {
        browser.stopScreenshotStream();
      }
    });
  });

  server.listen(port, () => {
    console.log(`MCP Playwright server listening on http://localhost:${port}`);
  });
}
