export interface BrowserConfig {
  headless: boolean;
  chromePath?: string;
  timeoutMs: number;
  viewport: { width: number; height: number };
}

export interface ElementInfo {
  tagName: string;
  id?: string;
  className?: string;
  text?: string;
  ariaLabel?: string;
  cssSelector?: string;
  xpath?: string;
  attributes: Record<string, string | undefined>;
}

export interface ExecutionCommand {
  action: string;       // 'navigate' | 'click' | 'type' | 'wait' | ...
  target?: string;      // selector or URL
  value?: string;       // text to type
  waitTime?: number;    // seconds or ms depending on generator
}

export interface ExecutionResult {
  success: boolean;
  message: string;
  screenshot?: string;
  selectors?: ElementInfo[];
  seleniumCode?: string;
  error?: string;
  data?: unknown;
}

export interface WebSocketMessage {
  type: 'log' | 'error' | 'success' | 'action' | 'selector' | 'selenium';
  timestamp: string;
  message: string;
  data?: unknown;
}

export interface SessionState {
  isOpen: boolean;
  currentUrl?: string;
  lastScreenshot?: string;
  selectors: Map<string, ElementInfo>;
}
