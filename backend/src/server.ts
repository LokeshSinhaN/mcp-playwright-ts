import express from 'express';
import http from 'http';
import cors from 'cors';
import WebSocket, { WebSocketServer } from 'ws';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { BrowserManager } from './browserManager';
import { McpTools } from './mcpTools';
import { ExecutionResult, WebSocketMessage, ExecutionCommand, ElementInfo } from './types';

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

export function createServer(port: number, chromePath?: string) {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  const browser = new BrowserManager({
    headless: true,
    timeoutMs: 30000,
    // Use a larger viewport to approximate a maximized browser window in
    // the preview UI.
    viewport: { width: 1600, height: 900 },
    chromePath
  });
  const tools = new McpTools(browser);
 
   const clients = new Set<WebSocket>();
 
   // Deterministic helper: for clear cookie-banner intents (accept/allow/close
   // cookies), try the dedicated cookie handler before invoking the LLM. This
   // avoids unnecessary hallucinations when the task is simple.
   async function maybeHandleCookieFromPrompt(prompt: string): Promise<ExecutionResult | null> {
     const lower = prompt.toLowerCase();
 
     if (!/cookie/.test(lower)) return null;
     if (!/(accept|allow|agree|ok|close|dismiss|reject|deny)/.test(lower)) return null;
 
     const result = await tools.handleCookieBanner();
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
    const apiKey = process.env.GEMINI_API_KEY;
    const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

    if (!apiKey) {
      return {
        success: false,
        message: 'GEMINI_API_KEY is not configured on the server',
        error: 'Missing GEMINI_API_KEY environment variable'
      };
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelName });

    // For obvious cookie-banner prompts, prefer the deterministic handler
    // first so the LLM does not need to plan anything.
    const cookieResult = await maybeHandleCookieFromPrompt(prompt);
    if (cookieResult) {
      return cookieResult;
    }

    // 1) LOOK: capture current page state and candidate elements.
    await browser.init();
    const observation = await tools.observe(selector);
    const elements = observation.selectors ?? [];

    type AiElement = {
      id: string;
      tagName: string;
      role: string;
      region: string;
      text: string;
      ariaLabel: string;
      selector: string;
      visible: boolean;
    };

    const baseCandidates: AiElement[] = elements
      .map((el, idx) => {
        const selectorValue = el.cssSelector ?? el.xpath ?? '';
        return {
          id: `el_${idx}`,
          tagName: (el.tagName || '').toLowerCase(),
          role: el.roleHint ?? 'other',
          region: el.region ?? 'main',
          text: el.text ?? '',
          ariaLabel: el.ariaLabel ?? '',
          selector: selectorValue,
          visible: el.visible !== false
        } satisfies AiElement;
      })
      .filter((e) => !!e.selector);

    // Prefer visible elements only, but otherwise preserve the natural DOM order
    // as returned by the extractor so the model can infer relationships from
    // spatial layout (labels next to inputs, grouped controls, etc.).
    const aiElements: AiElement[] = baseCandidates.filter((e) => e.visible);

    // Limit the number of elements we send to Gemini to keep the request small,
    // but preserve order instead of re-ranking heuristically.
    const limitedElements = aiElements.slice(0, 120);
    const elementsJson = JSON.stringify(limitedElements, null, 2);

    type PlannedAction =
      | { action: 'navigate'; url: string }
      | { action: 'click'; elementId: string }
      | { action: 'type'; elementId: string; text: string }
      | { action: 'noop' };

    const heuristicUrl = extractUrlFromPrompt(prompt);

    // 2) THINK: build a constrained planning prompt.
    const lines: string[] = [];
    lines.push('You are a web automation planner for a headless browser.');
    lines.push('You can see a screenshot of the current page (PNG image) and a JSON list of interactive elements.');
    lines.push('Use the visual layout to disambiguate between elements with similar labels (e.g., navigation links vs primary buttons).');
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
    lines.push('Rules:');
    lines.push('- Do NOT invent new selectors, ids, or elements.');
    lines.push('- If you choose to click or type, you MUST reference the element by its "id" field (e.g., "el_3").');
    lines.push('- Use the screenshot to resolve ambiguities when multiple elements share similar labels (for example, a "Search" navigation link vs. a "Search" button next to an input).');
    lines.push('- Treat dropdowns and select-like controls as a two-step interaction: (1) click the control to open the list, optionally wait for it to appear, then (2) click the specific option element (often with role="option" or rendered as a list item).');
    lines.push('- When planning actions for dropdowns, plan clicks only on elements that are present in the provided elements JSON; do NOT assume hidden options are clickable until they appear.');
    lines.push('- If no safe or relevant action can be taken, choose action "noop".');
    lines.push('');
    lines.push('Return ONLY a JSON value of this TypeScript union type (no markdown, no comments):');
    lines.push('type PlannedAction =');
    lines.push('  | { "action": "navigate"; "url": string }');
    lines.push('  | { "action": "click"; "elementId": string }');
    lines.push('  | { "action": "type"; "elementId": string; "text": string }');
    lines.push('  | { "action": "noop" };');

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

    let parsed: PlannedAction;
    try {
      // Ensure we only parse the JSON object even if the model adds stray text.
      const firstBrace = rawText.indexOf('{');
      const lastBrace = rawText.lastIndexOf('}');
      const jsonSlice =
        firstBrace >= 0 && lastBrace > firstBrace
          ? rawText.slice(firstBrace, lastBrace + 1)
          : rawText;
      parsed = JSON.parse(jsonSlice) as PlannedAction;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Failed to parse AI plan: ${msg}`,
        error: `Failed to parse AI plan: ${msg}`,
        screenshot: observation.screenshot,
        selectors: elements
      };
    }

    // 3) ACT: route to the appropriate tool based on the structured plan.
    switch (parsed.action) {
      case 'navigate':
        return tools.navigate(parsed.url);
      case 'click': {
        const target = limitedElements.find((e) => e.id === parsed.elementId);
        if (!target) {
          return {
            ...observation,
            success: false,
            message: `AI chose invalid elementId: ${parsed.elementId}`,
            error: `Invalid elementId: ${parsed.elementId}`
          };
        }
        return tools.click(target.selector);
      }
      case 'type': {
        const target = limitedElements.find((e) => e.id === parsed.elementId);
        if (!target) {
          return {
            ...observation,
            success: false,
            message: `AI chose invalid elementId: ${parsed.elementId}`,
            error: `Invalid elementId: ${parsed.elementId}`
          };
        }
        return tools.type(target.selector, parsed.text);
      }
      case 'noop':
      default:
        // Just return the observation; AI chose to do nothing.
        return {
          ...observation,
          message: observation.message || 'Observed page only (AI chose no safe action)'
        };
    }
  }

  app.post('/api/execute', async (req, res) => {
    const { action, url, selector, text, commands, prompt } = req.body as {
      action: string;
      url?: string;
      selector?: string;
      text?: string;
      commands?: ExecutionCommand[];
      prompt?: string;
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
          result = await tools.click(selector);
          break;
        case 'type':
          if (!selector || text == null) throw new Error('selector and text required');
          broadcast({ type: 'action', timestamp: new Date().toISOString(), message: `type in ${selector}` });
          result = await tools.type(selector, text);
          break;
        case 'handle_cookie_banner':
          broadcast({ type: 'action', timestamp: new Date().toISOString(), message: 'handle_cookie_banner' });
          result = await tools.handleCookieBanner();
          break;
        case 'extract_selectors':
          broadcast({ type: 'action', timestamp: new Date().toISOString(), message: 'extract_selectors' });
          result = await tools.extractSelectors(selector);
          break;
        case 'observe':
          broadcast({ type: 'action', timestamp: new Date().toISOString(), message: 'observe' });
          result = await tools.observe(selector);
          break;
        case 'ai': {
          if (!prompt) throw new Error('prompt required');

          broadcast({
            type: 'action',
            timestamp: new Date().toISOString(),
            message: `ai_plan "${prompt.slice(0, 120)}"`
          });

          result = await handleAiAction(prompt, selector);
          break;
        }
        case 'generate_selenium':
          // We allow commands to be optional now, defaulting to session history
          broadcast({ type: 'action', timestamp: new Date().toISOString(), message: 'generate_selenium' });
          result = await tools.generateSelenium(commands);
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

    ws.on('close', () => {
      clients.delete(ws);
    });
  });

  server.listen(port, () => {
    console.log(`MCP Playwright server listening on http://localhost:${port}`);
  });
}
