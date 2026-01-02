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

    // 1) Look: capture current page state.
    await browser.init();
    const observation = await tools.observe(selector);
    const elements = observation.selectors ?? [];
    const domSummary = buildDomContext(elements);
    const domForModel = domSummary.length > 8000 ? domSummary.slice(0, 8000) : domSummary;

    type PlannedAction =
      | { action: 'navigate'; url: string }
      | { action: 'click'; selector: string }
      | { action: 'type'; selector: string; text: string }
      | { action: 'noop' };

    const heuristicUrl = extractUrlFromPrompt(prompt);

    const lines: string[] = [];
    lines.push('You are a web automation planner for a headless browser.');
    lines.push('');
    lines.push('User request:');
    lines.push(prompt);
    lines.push('');
    lines.push('Heuristic URL parsed from the request (may be empty if none found):');
    lines.push(heuristicUrl ?? '');
    lines.push('');
    lines.push('Current page elements (compact summary):');
    lines.push(domForModel);
    lines.push('');
    lines.push('Decide ONE best next action for the agent.');
    lines.push('');
    lines.push('Return ONLY a JSON object with this TypeScript type (no markdown, no extra text):');
    lines.push('');
    lines.push('type PlannedAction =');
    lines.push('  | { "action": "navigate"; "url": string }');
    lines.push('  | { "action": "click"; "selector": string }');
    lines.push('  | { "action": "type"; "selector": string; "text": string }');
    lines.push('  | { "action": "noop" };');

    const planningPrompt = lines.join('\n');

    const response = await model.generateContent(planningPrompt);
    const rawText = response.response.text();

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

    // 3) Act: route to the appropriate tool based on the structured plan.
    switch (parsed.action) {
      case 'navigate':
        return tools.navigate(parsed.url);
      case 'click':
        return tools.click(parsed.selector);
      case 'type':
        return tools.type(parsed.selector, parsed.text);
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
