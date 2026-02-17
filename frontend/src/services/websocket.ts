export interface WsPayload {
  type: string;
  timestamp: string;
  message: string;
  data?: unknown;
}

type Handler = (p: WsPayload) => void;
type ReadyHandler = (ready: boolean) => void;

export class WsClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private readyHandlers = new Set<ReadyHandler>();
  private _previewReady: boolean = false;

  get previewReady(): boolean {
    return this._previewReady;
  }

  connect(url = 'ws://localhost:5000'): void {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev) => {
      try {
        const payload = JSON.parse(ev.data) as WsPayload;
        
        // Handle preview_ready events
        if (payload.type === 'preview_ready') {
          const ready = (payload.data as any)?.ready ?? true;
          this._previewReady = ready;
          for (const h of this.readyHandlers) h(ready);
        }
        
        for (const h of this.handlers) h(payload);
      } catch (e) {
        console.error('Bad WS payload', e);
      }
    };
    
    this.ws.onclose = () => {
      this._previewReady = false;
      for (const h of this.readyHandlers) h(false);
    };
  }

  on(handler: Handler): void {
    this.handlers.add(handler);
  }

  onPreviewReady(handler: ReadyHandler): void {
    this.readyHandlers.add(handler);
    // Immediately call with current state
    handler(this._previewReady);
  }
}

export const wsClient = new WsClient();
