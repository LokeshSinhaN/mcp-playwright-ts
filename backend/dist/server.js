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
const browserManager_1 = require("./browserManager");
const mcpTools_1 = require("./mcpTools");
async function callGeminiSteps(prompt) {
    var _a, _b, _c, _d;
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error('GEMINI_API_KEY is not set');
    }
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const systemInstructions = [
        'You control a Playwright browser for UI testing.',
        'Given a single user command, produce a SHORT JSON-only plan for how to operate the browser.',
        'Use as few steps as possible (1-4).',
        'Supported actions: "navigate", "click", "type", "wait".',
        'For navigate, set "url".',
        'For click/type, set "selector" to a Playwright selector string.',
        'When the target element is ambiguous (e.g. "search box", "login field"), you may include up to 3 fallback selectors separated by "||" in the same selector string, ordered from most specific/robust to most generic.',
        'Prefer text/role/label based selectors over raw tag/attribute guesses.',
        'For type, also set "text".',
        'For wait, set "waitMs" (milliseconds).',
        'Respond with ONLY JSON in this exact shape and nothing else:',
        '{"steps":[{"action":"navigate|click|type|wait","url?":"...","selector?":"...","text?":"...","waitMs?":1000}]}'
    ].join(' ');
    const fullPrompt = `${systemInstructions}\n\nUser command: ${prompt}`;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const body = {
        contents: [
            {
                role: 'user',
                parts: [{ text: fullPrompt }]
            }
        ]
    };
    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Gemini API error ${resp.status}: ${text}`);
    }
    const data = await resp.json();
    const text = (_d = (_c = (_b = (_a = data.candidates) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.content) === null || _c === void 0 ? void 0 : _c.parts[0]) === null || _d === void 0 ? void 0 : _d.text;
    if (!text) {
        throw new Error('Gemini response missing text content');
    }
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const jsonString = jsonMatch ? jsonMatch[0] : text;
    let parsed;
    try {
        parsed = JSON.parse(jsonString);
    }
    catch (err) {
        throw new Error('Failed to parse Gemini JSON: ' + (err instanceof Error ? err.message : String(err)));
    }
    if (!parsed.steps || !Array.isArray(parsed.steps)) {
        throw new Error('Gemini JSON missing "steps" array');
    }
    return parsed.steps;
}
function createServer(port, chromePath) {
    const app = (0, express_1.default)();
    const server = http_1.default.createServer(app);
    const wss = new ws_1.WebSocketServer({ server });
    const browser = new browserManager_1.BrowserManager({
        headless: true,
        timeoutMs: 30000,
        viewport: { width: 1280, height: 720 },
        chromePath
    });
    const tools = new mcpTools_1.McpTools(browser);
    const clients = new Set();
    app.use((0, cors_1.default)());
    app.use(express_1.default.json({ limit: '10mb' }));
    function broadcast(msg) {
        const payload = JSON.stringify(msg);
        for (const ws of clients) {
            if (ws.readyState === ws_1.default.OPEN)
                ws.send(payload);
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
                case 'ai':
                    if (!prompt)
                        throw new Error('prompt required');
                    broadcast({ type: 'log', timestamp: new Date().toISOString(), message: `AI interpreting command: ${prompt}` });
                    {
                        const steps = await callGeminiSteps(prompt);
                        if (!steps.length) {
                            throw new Error('AI did not return any steps');
                        }
                        let lastResult = null;
                        for (const [idx, step] of steps.entries()) {
                            const ts = new Date().toISOString();
                            const label = step.action || 'unknown';
                            switch ((step.action || '').toLowerCase()) {
                                case 'navigate':
                                    if (!step.url)
                                        throw new Error(`Step ${idx} missing url`);
                                    broadcast({ type: 'action', timestamp: ts, message: `navigate ${step.url}` });
                                    lastResult = await tools.navigate(step.url);
                                    break;
                                case 'click':
                                    if (!step.selector)
                                        throw new Error(`Step ${idx} missing selector`);
                                    broadcast({ type: 'action', timestamp: ts, message: `click ${step.selector}` });
                                    lastResult = await tools.click(step.selector, { prompt });
                                    break;
                                case 'type':
                                    if (!step.selector || step.text == null)
                                        throw new Error(`Step ${idx} missing selector or text`);
                                    broadcast({ type: 'action', timestamp: ts, message: `type in ${step.selector}` });
                                    lastResult = await tools.type(step.selector, step.text, { prompt });
                                    break;
                                case 'wait':
                                    {
                                        const waitMs = typeof step.waitMs === 'number' && step.waitMs > 0 ? step.waitMs : 1000;
                                        broadcast({ type: 'log', timestamp: ts, message: `wait ${waitMs}ms` });
                                        await new Promise((resolve) => setTimeout(resolve, waitMs));
                                    }
                                    break;
                                default:
                                    broadcast({ type: 'error', timestamp: ts, message: `Unknown AI step action: ${label}` });
                                    break;
                            }
                        }
                        if (!lastResult) {
                            result = { success: false, message: 'AI did not execute any browser steps' };
                        }
                        else {
                            result = Object.assign(Object.assign({}, lastResult), { steps });
                        }
                    }
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
                case 'extract_selectors':
                    broadcast({ type: 'action', timestamp: new Date().toISOString(), message: 'extract_selectors' });
                    result = await tools.extractSelectors(selector);
                    break;
                case 'generate_selenium':
                    if (!commands || !Array.isArray(commands))
                        throw new Error('commands array required');
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