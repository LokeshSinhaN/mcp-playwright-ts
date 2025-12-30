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
    // Helper: build a compact DOM context summary for the AI.
    function buildDomContext(elements, maxItems = 80) {
        const lines = [];
        // Prefer visible elements; if all are hidden, fall back to everything.
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
                    // First: deterministic navigation intent handling.
                    const inferredUrl = extractUrlFromPrompt(prompt);
                    if (inferredUrl) {
                        broadcast({
                            type: 'action',
                            timestamp: new Date().toISOString(),
                            message: `navigate (from ai prompt) ${inferredUrl}`
                        });
                        result = await tools.navigate(inferredUrl);
                        break;
                    }
                    // Otherwise, we could call an AI model here. For now we just
                    // capture DOM context and return a friendly message so the
                    // client can decide how to proceed.
                    await browser.init();
                    const page = browser.getPage();
                    const extractor = new (await Promise.resolve().then(() => __importStar(require('./selectorExtractor')))).SelectorExtractor(page);
                    const interactive = await extractor.extractAllInteractive();
                    const domSummary = buildDomContext(interactive);
                    conversationHistory.push({ role: 'user', content: prompt });
                    result = {
                        success: false,
                        message: 'AI action not implemented yet',
                        data: { domContext: domSummary }
                    };
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