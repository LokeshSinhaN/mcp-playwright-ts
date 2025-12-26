export class WsClient {
    constructor() {
        this.ws = null;
        this.handlers = new Set();
    }
    connect(url = 'ws://localhost:5000') {
        this.ws = new WebSocket(url);
        this.ws.onmessage = (ev) => {
            try {
                const payload = JSON.parse(ev.data);
                for (const h of this.handlers)
                    h(payload);
            }
            catch (e) {
                console.error('Bad WS payload', e);
            }
        };
    }
    on(handler) {
        this.handlers.add(handler);
    }
}
export const wsClient = new WsClient();
//# sourceMappingURL=websocket.js.map