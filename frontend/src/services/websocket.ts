export interface WsPayload {
  type: string;
  timestamp: string;
  message: string;
  data?: unknown;
}

type Handler = (p: WsPayload) => void;

export class WsClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();

  connect(url = 'ws://localhost:5000'): void {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev) => {
      try {
        const payload = JSON.parse(ev.data) as WsPayload;
        for (const h of this.handlers) h(payload);
      } catch (e) {
        console.error('Bad WS payload', e);
      }
    };
  }

  on(handler: Handler): void {
    this.handlers.add(handler);
  }
}

export const wsClient = new WsClient();
