export class WsClient {
    constructor() {
        this.ws = null;
        this.handlers = new Set();
        this.readyHandlers = new Set();
        this._previewReady = false;
    }
    get previewReady() {
        return this._previewReady;
    }
    connect(url = 'ws://localhost:5000') {
        this.ws = new WebSocket(url);
        this.ws.onmessage = (ev) => {
            try {
                const payload = JSON.parse(ev.data);
                // Handle preview_ready events
                if (payload.type === 'preview_ready') {
                    const ready = payload.data?.ready ?? true;
                    this._previewReady = ready;
                    for (const h of this.readyHandlers)
                        h(ready);
                }
                for (const h of this.handlers)
                    h(payload);
            }
            catch (e) {
                console.error('Bad WS payload', e);
            }
        };
        this.ws.onclose = () => {
            this._previewReady = false;
            for (const h of this.readyHandlers)
                h(false);
        };
    }
    on(handler) {
        this.handlers.add(handler);
    }
    onPreviewReady(handler) {
        this.readyHandlers.add(handler);
        // Immediately call with current state
        handler(this._previewReady);
    }
}
export const wsClient = new WsClient();
//# sourceMappingURL=websocket.js.map