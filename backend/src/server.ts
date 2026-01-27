import express from 'express';
import http from 'http';
import cors from 'cors';
import WebSocket, { WebSocketServer } from 'ws';
import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import OpenAI from 'openai';
import multer from 'multer';
import { PDFParse } from 'pdf-parse';
import { BrowserManager } from './browserManager';
import { McpTools } from './mcpTools';
import { ExecutionResult, WebSocketMessage, ExecutionCommand, ElementInfo, AgentSessionResult, AgentConfig } from './types';
import { parseDropdownInstruction } from './dropdownUtils';

// Configure Multer for memory storage (files are processed in RAM)
const upload = multer({ storage: multer.memoryStorage() });

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
  if (lower.includes('agent') || lower.includes('step by step') || lower.includes('steps')) return true;
  const complexConnectors = [
    ' and ', ' then ', ' after ', ' followed by ', ' next ', ',',
    ' first ', ' second ', ' finally '
  ];
  const connectorCount = complexConnectors.reduce((count, word) =>
    lower.includes(word) ? count + 1 : count, 0);
  if (connectorCount >= 1) return true;
  const actionVerbs = [
    'click', 'type', 'enter', 'fill', 'select', 'choose',
    'navigate', 'go to', 'visit', 'open', 'search', 'submit',
    'scroll', 'wait', 'verify', 'check', 'extract', 'scrape'
  ];
  const actionCount = actionVerbs.filter(verb => {
    const regex = new RegExp(`\b${verb}\b`, 'i');
    return regex.test(lower);
  }).length;
  if (actionCount >= 1) return true;

  return false;
}

// Helper: attempt to parse a JSON-like string, applying small repairs when needed.
function tryParseJson(candidate: string): any {
  const trimmed = candidate.trim();
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    let repaired = trimmed.replace(/,\s*([}\]])/g, '$1');
    if (repaired !== trimmed) {
      try {
        return JSON.parse(repaired);
      } catch { } // Ignore if repair fails
    }
    repaired = repaired.replace(/'([^'"\\]*?)'/g, (_m, inner) => {
      const escaped = String(inner).replace(/"/g, '\"');
      return `"${escaped}"`;
    });
    if (repaired !== trimmed) {
      try {
        return JSON.parse(repaired);
      } catch { } // Ignore if repair fails
    }
    throw err;
  }
}

function parseAiResponse(text: string): any {
  try { return tryParseJson(text); } catch { }
  const markdownMatch = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (markdownMatch && markdownMatch[1]) {
    const inner = markdownMatch[1].trim();
    return tryParseJson(inner);
  }
  const genericBlockMatch = text.match(/```\s*([\s\S]*?)\s*```/);
  if (genericBlockMatch && genericBlockMatch[1]) {
    const inner = genericBlockMatch[1].trim();
    return tryParseJson(inner);
  }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const jsonCandidate = text.substring(first, last + 1).trim();
    return tryParseJson(jsonCandidate);
  }
  throw new Error(`Invalid JSON format. Raw output (truncated): ${text.substring(0, 100)}...`);
}

export function createServer(port: number, chromePath?: string) {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  // --- MODEL INITIALIZATION ---
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const geminiModelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  let geminiModel: GenerativeModel | undefined = undefined;
  if (geminiApiKey) {
    const genAI = new GoogleGenerativeAI(geminiApiKey);
    geminiModel = genAI.getGenerativeModel({ model: geminiModelName });
  }

  const openaiApiKey = process.env.OPENAI_API_KEY;
  let openaiClient: OpenAI | undefined = undefined;
  if (openaiApiKey) {
    openaiClient = new OpenAI({ apiKey: openaiApiKey });
  }
  // -----------------------------

  const browser = new BrowserManager({
    headless: true,
    timeoutMs: 5000,
    viewport: { width: 1600, height: 900 },
    chromePath
  });
  
  // Pass BOTH models to tools. The tools will select which one to use based on config.
  const tools = new McpTools(browser, geminiModel, openaiClient); 
 
   const clients = new Set<WebSocket>();
 
   async function maybeHandleCookieFromPrompt(prompt: string, elements: ElementInfo[]): Promise<ExecutionResult | null> {
     const lower = prompt.toLowerCase();
     if (!/cookie/.test(lower)) return null;
     if (!/(accept|allow|agree|ok|close|dismiss|reject|deny)/.test(lower)) return null;
     const result = await browser.handleCookieBanner();
     if (result.message.toLowerCase().startsWith('cookie banner dismissed')) {
       return result;
     }
     return null;
   }

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  function broadcast(msg: WebSocketMessage) {
    const payload = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }

  // --- PDF PARSING ENDPOINT ---
  app.post('/api/parse-pdf', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) {
        throw new Error('No file uploaded');
      }
      
      const buffer = req.file.buffer;
      const parser = new PDFParse({ data: buffer });
      const data = await parser.getText();
      await parser.destroy();

      // Clean up the text slightly
      const text = data.text.trim();
      
      res.json({ success: true, text });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: msg });
    }
  });

  // --- ACTION HANDLER ---
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
          broadcast({ type: 'action', timestamp: new Date().toISOString(), message: `Maps ${url}` });
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
          result = await tools.handleCookieBanner();
          break;
        case 'extract_selectors':
          broadcast({ type: 'action', timestamp: new Date().toISOString(), message: 'extract_selectors' });
          result = { ...(await tools.observe()) };
          break;
        case 'observe':
          broadcast({ type: 'action', timestamp: new Date().toISOString(), message: 'observe' });
          result = { ...(await tools.observe()) };
          break;
        case 'ai': {
          if (!prompt) throw new Error('prompt required');

          const isMultiStep = detectMultiStepPrompt(prompt);
          
          if (isMultiStep) {
            console.log(`[Server] Starting Agent with prompt: ${prompt} [Provider: ${agentConfig?.modelProvider || 'gemini'}]`);

            const config: AgentConfig = {
              maxSteps: 30,
              broadcast,
              modelProvider: agentConfig?.modelProvider || 'gemini' // Pass provider
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
            // Fallback to legacy single step
             const config: AgentConfig = {
              maxSteps: 5, // Short horizon for single step
              broadcast,
              modelProvider: agentConfig?.modelProvider || 'gemini'
            };
            const agentResult = await tools.runAutonomousAgent(prompt, config);
             result = {
              success: agentResult.success,
              message: agentResult.summary,
              selectors: agentResult.selectors,
            };
          }
          break;
        }
        case 'ai_agent': {
          if (!prompt) throw new Error('prompt required for ai_agent');

          broadcast({
            type: 'action',
            timestamp: new Date().toISOString(),
            message: `ai_agent starting: "${prompt.slice(0, 100)}"`
          });

          const config: AgentConfig = {
            maxSteps: agentConfig?.maxSteps ?? 30,
            maxRetriesPerAction: 2,
            generateSelenium: agentConfig?.generateSelenium ?? true,
            broadcast,
            modelProvider: agentConfig?.modelProvider || 'gemini' // Pass provider
          };

          let agentResult: AgentSessionResult;
          try {
            agentResult = await tools.runAutonomousAgent(prompt, config);
          } finally {
          }

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
          break;
        }
        case 'generate_selenium':
          broadcast({ type: 'action', timestamp: new Date().toISOString(), message: 'generate_selenium' });
          result = { ...(await tools.generateSelenium(commands ?? [])), message: 'Selenium code generated' };
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