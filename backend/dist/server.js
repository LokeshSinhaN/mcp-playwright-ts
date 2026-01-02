"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createServer = createServer;
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const cors_1 = __importDefault(require("cors"));
const ws_1 = __importStar(require("ws"));
const generative_ai_1 = require("@google/generative-ai");
const browserManager_1 = require("./browserManager");
const mcpTools_1 = require("./mcpTools");
/**
 * Small helper: detect if a natural language prompt is really asking to
 * navigate to a website, e.g. "go to mayoclinic website".
 */
function extractUrlFromPrompt(prompt) {
    const trimmed = prompt.trim();
    // 1) explicit URL with protocol
    const explicit = trimmed.match(/https?:\/\/\S+/i);
    if (explicit)
        return explicit[0];
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
function buildDomContext(elements, maxItems = 80) {
    const lines = [];
    const visible = elements.filter((el) => el.visible !== false);
    const pool = visible.length > 0 ? visible : elements;
    for (const [index, el] of pool.slice(0, maxItems).entries()) {
        const text = (el.text ?? '').replace(/\s+/g, ' ').trim();
        const aria = el.ariaLabel ?? '';
        const label = text || aria || '(no text)';
        const selector = el.cssSelector ?? el.xpath ?? '';
        const region = el.region ?? 'main';
        const flags = [];
        if (el.searchField)
            flags.push('searchField');
        if (el.roleHint && el.roleHint !== 'other')
            flags.push(el.roleHint);
        const flagsStr = flags.length ? ` [${flags.join(', ')}]` : '';
        lines.push(`${index + 1}. (${region}) <${el.tagName}> label="${label.slice(0, 80)}" selector="${selector.slice(0, 120)}"${flagsStr}`);
    }
    return lines.join('\n');
}
function createServer(port, chromePath) {
    const app = (0, express_1.default)();
    const server = http_1.default.createServer(app);
    const wss = new ws_1.WebSocketServer({ server });
    const browser = new browserManager_1.BrowserManager({
        headless: true,
        timeoutMs: 30000,
        // Use a larger viewport to approximate a maximized browser window in
        // the preview UI.
        viewport: { width: 1600, height: 900 },
        chromePath
    });
    const tools = new mcpTools_1.McpTools(browser);
    const clients = new Set();
    // Deterministic helper: for clear cookie-banner intents (accept/allow/close
    // cookies), try the dedicated cookie handler before invoking the LLM. This
    // avoids unnecessary hallucinations when the task is simple.
    async function maybeHandleCookieFromPrompt(prompt) {
        const lower = prompt.toLowerCase();
        if (!/cookie/.test(lower))
            return null;
        if (!/(accept|allow|agree|ok|close|dismiss|reject|deny)/.test(lower))
            return null;
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
    const conversationHistory = [];
    app.use((0, cors_1.default)());
    app.use(express_1.default.json({ limit: '10mb' }));
    function broadcast(msg) {
        const payload = JSON.stringify(msg);
        for (const ws of clients) {
            if (ws.readyState === ws_1.default.OPEN)
                ws.send(payload);
        }
    }
    async function handleAiAction(prompt, selector) {
        const apiKey = process.env.GEMINI_API_KEY;
        const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
        if (!apiKey) {
            return {
                success: false,
                message: 'GEMINI_API_KEY is not configured on the server',
                error: 'Missing GEMINI_API_KEY environment variable'
            };
        }
        const genAI = new generative_ai_1.GoogleGenerativeAI(apiKey);
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
        const baseCandidates = elements
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
            };
        })
            .filter((e) => !!e.selector);
        // Prefer visible elements only; let the model decide which ones matter.
        let aiElements = baseCandidates.filter((e) => e.visible);
        // --- Prompt‑aware re‑ranking so we never drop the most relevant elements ---
        const rawPrompt = prompt.toLowerCase();
        const stopWords = new Set([
            'the',
            'a',
            'an',
            'on',
            'in',
            'at',
            'to',
            'for',
            'of',
            'and',
            'or',
            'please',
            'click',
            'press',
            'button',
            'link',
            'field',
            'box',
            'banner',
            'from',
            'this',
            'that'
        ]);
        const promptTokens = rawPrompt
            .split(/[^a-z0-9]+/)
            .map((w) => w.trim())
            .filter((w) => w.length >= 3 && !stopWords.has(w));
        const interactiveTagOrder = new Map([
            ['input', 0],
            ['textarea', 0],
            ['button', 1],
            ['a', 2]
        ]);
        const scored = aiElements.map((el) => {
            const haystack = `${el.text} ${el.ariaLabel}`.toLowerCase();
            let score = 0;
            for (const token of promptTokens) {
                if (!token)
                    continue;
                if (haystack.includes(token)) {
                    // Strong boost for exact token matches from the prompt.
                    score += 3;
                }
            }
            // Mild boost if element role matches obvious intent words.
            if (/search|find/.test(rawPrompt) && el.role === 'input' && /search/i.test(haystack)) {
                score += 2;
            }
            // Cookie/consent specific boost, but phrased generically so it also
            // helps with any prompt mentioning those words.
            if (/cookie|consent|privacy/.test(rawPrompt) && /cookie|consent|privacy/i.test(haystack)) {
                score += 3;
            }
            // Prefer clearly labeled controls over nearly-empty ones.
            const labelLength = (el.text || el.ariaLabel || '').trim().length;
            if (labelLength >= 3) {
                score += 1;
            }
            const tagBias = interactiveTagOrder.has(el.tagName) ? interactiveTagOrder.get(el.tagName) : 3;
            return { el, score, tagBias };
        });
        scored.sort((a, b) => {
            if (b.score !== a.score)
                return b.score - a.score; // higher score first
            if (a.tagBias !== b.tagBias)
                return a.tagBias - b.tagBias; // prefer inputs/textareas, then buttons, then links
            // Stable-ish fallback: shorter, more descriptive text first.
            const aText = (a.el.text || a.el.ariaLabel || '').length;
            const bText = (b.el.text || b.el.ariaLabel || '').length;
            return aText - bText;
        });
        aiElements = scored.map((s) => s.el);
        // Limit the number of elements we send to Gemini to keep the prompt small.
        // We allow a slightly larger cap to reduce the chance of dropping
        // important controls on dense pages like medical portals.
        const limitedElements = aiElements.slice(0, 120);
        const elementsJson = JSON.stringify(limitedElements, null, 2);
        const heuristicUrl = extractUrlFromPrompt(prompt);
        // 2) THINK: build a constrained planning prompt.
        const lines = [];
        lines.push('You are a web automation planner for a headless browser.');
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
        lines.push('- If the user says "click [input/box]" or refers to a text box/field, prefer INPUT or TEXTAREA elements over BUTTON elements with similar labels.');
        lines.push('- If no safe or relevant action can be taken, choose action "noop".');
        lines.push('');
        lines.push('Return ONLY a JSON value of this TypeScript union type (no markdown, no comments):');
        lines.push('type PlannedAction =');
        lines.push('  | { "action": "navigate"; "url": string }');
        lines.push('  | { "action": "click"; "elementId": string }');
        lines.push('  | { "action": "type"; "elementId": string; "text": string }');
        lines.push('  | { "action": "noop" };');
        const planningPrompt = lines.join('\n');
        const response = await model.generateContent(planningPrompt);
        const rawText = response.response.text();
        let parsed;
        try {
            // Ensure we only parse the JSON object even if the model adds stray text.
            const firstBrace = rawText.indexOf('{');
            const lastBrace = rawText.lastIndexOf('}');
            const jsonSlice = firstBrace >= 0 && lastBrace > firstBrace
                ? rawText.slice(firstBrace, lastBrace + 1)
                : rawText;
            parsed = JSON.parse(jsonSlice);
        }
        catch (err) {
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
        const { action, url, selector, text, commands, prompt } = req.body;
        let result;
        try {
            switch (action) {
                case 'navigate':
                    if (!url)
                        throw new Error('url required');
                    broadcast({ type: 'action', timestamp: new Date().toISOString(), message: `navigate ${url}` });
                    result = await tools.navigate(url);
                    break;
                case 'click':
                    if (!selector)
                        throw new Error('selector required');
                    broadcast({ type: 'action', timestamp: new Date().toISOString(), message: `click ${selector}` });
                    result = await tools.click(selector);
                    break;
                case 'type':
                    if (!selector || text == null)
                        throw new Error('selector and text required');
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
                    if (!prompt)
                        throw new Error('prompt required');
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
        }
        catch (err) {
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
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.status(500).json({ success: false, error: msg });
        }
    });
    app.get('/api/health', (_req, res) => {
        res.json({ success: true, browserOpen: browser.isOpen() });
    });
    wss.on('connection', (ws) => {
        clients.add(ws);
        ws.send(JSON.stringify({
            type: 'log',
            timestamp: new Date().toISOString(),
            message: 'Connected to execution stream'
        }));
        ws.on('close', () => {
            clients.delete(ws);
        });
    });
    server.listen(port, () => {
        console.log(`MCP Playwright server listening on http://localhost:${port}`);
    });
}
//# sourceMappingURL=server.js.map