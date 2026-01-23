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
  placeholder?: string;
  title?: string;
  dataTestId?: string;
  href?: string;
  cssSelector?: string;
  xpath?: string;
  selector?: string;
  visible?: boolean;
  isVisible?: boolean;
  roleHint?: 'button' | 'link' | 'input' | 'option' | 'listbox' | 'other';
  scrollable?: boolean; 
  isFloating?: boolean;
  searchField?: boolean;
  region?: 'header' | 'main' | 'footer' | 'sidebar';
  boundingBox?: { x: number; y: number; width: number; height: number };
  rect?: { x: number; y: number; width: number; height: number };
  context?: string;
  expanded?: boolean;
  attributes: Record<string, string | undefined>;
}

export interface ExecutionCommand {
  action: 'navigate' | 'click' | 'type' | 'scroll' | 'wait' | 'examine';
  target?: string;
  value?: string;
  waitTime?: number;
  selectors?: {
    css?: string;
    xpath?: string;
    id?: string;
    text?: string;
  };
  description?: string;
}

export interface ExecutionResult {
  success: boolean;
  message: string;
  screenshot?: string;
  selectors?: ElementInfo[];
  seleniumCode?: string;
  error?: string;
  data?: unknown;
  isAmbiguous?: boolean;
  requiresInteraction?: boolean;
  candidates?: ElementInfo[];
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

export type AgentAction =
  | { type: 'navigate'; url: string; thought: string }
  | { type: 'click'; elementId?: string; selector?: string; semanticTarget?: string; thought: string }
  | { type: 'type'; elementId?: string; selector?: string; semanticTarget?: string; text: string; thought: string }
  | { type: 'select_option'; elementId?: string; selector?: string; semanticTarget?: string; option: string; thought: string }
  | { type: 'scrape_data'; instruction: string; thought: string }
  | { type: 'scroll'; direction: 'up' | 'down'; elementId?: string; thought: string }
  | { type: 'wait'; durationMs: number; thought: string }
  | { type: 'finish'; thought: string; summary: string };

export interface AgentStepResult {
  stepNumber: number;
  action: AgentAction;
  success: boolean;
  message: string;
  urlBefore: string;
  urlAfter: string;
  stateChanged: boolean;
  recoveryAttempt?: string;
  screenshot?: string;
  elementInfo?: ElementInfo;
  error?: string;
  retryCount: number;
}

export interface AgentSessionResult {
  success: boolean;
  summary: string;
  goal: string;
  totalSteps: number;
  steps: AgentStepResult[];
  commands: ExecutionCommand[];
  seleniumCode?: string;
  screenshot?: string;
  selectors?: ElementInfo[];
  error?: string;
}

export interface AgentConfig {
  maxSteps?: number;
  maxRetriesPerAction?: number;
  generateSelenium?: boolean;
  onStepComplete?: (step: AgentStepResult) => void;
  onThought?: (thought: string, action: AgentAction) => void;
  broadcast?: (msg: WebSocketMessage) => void;
  /** Select which AI model to use for reasoning */
  modelProvider?: 'gemini' | 'openai'; 
}

export interface ActionOutcome {
    action: AgentAction;
    success: boolean;
    stateFingerprintBefore: string;
    stateFingerprintAfter: string;
    timestamp: number;
}
