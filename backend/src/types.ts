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
  // Additional enriched attributes for smarter matching.
  placeholder?: string;
  title?: string;
  dataTestId?: string;
  href?: string;
  cssSelector?: string;
  xpath?: string;
  /** Primary CSS selector used for replay / disambiguation (alias for cssSelector). */
  selector?: string;
  // Rough visibility heuristic so the AI can ignore hidden elements.
  visible?: boolean;
  // Explicit visibility flag used by Intelligent Interaction logic.
  isVisible?: boolean;
  // High-level role hint to help reasoning about elements.
  roleHint?: 'button' | 'link' | 'input' | 'option' | 'listbox' | 'other';
  
  // NEW: Flag to tell the AI "You can scroll this specific element!"
  scrollable?: boolean; 
  
  isFloating?: boolean;

  // True if this looks like a search input field.
  searchField?: boolean;
  // Approximate vertical region of the page.
  region?: 'header' | 'main' | 'footer' | 'sidebar';
  // Bounding box (CSS pixels, viewport-relative).
  boundingBox?: { x: number; y: number; width: number; height: number };
  // Rect alias for compatibility with interaction schemas.
  rect?: { x: number; y: number; width: number; height: number };
  // Optional smart context string that captures nearby labels or section headers
  // to disambiguate otherwise similar elements (e.g., identical buttons in
  // different cards).
  context?: string;
  attributes: Record<string, string | undefined>;
}

export interface ExecutionCommand {
  action: 'navigate' | 'click' | 'type' | 'scroll' | 'wait' | 'examine';
  target?: string;      // selector or URL (legacy primary target)
  value?: string;       // text to type
  waitTime?: number;    // seconds or ms depending on generator
  // Rich selector data captured from successful interactions so downstream
  // generators (e.g., Selenium) never need to hallucinate locators.
  selectors?: {
    css?: string;
    xpath?: string;
    id?: string;
    text?: string;
  };
  // High-level natural-language description of the step, ideally the original
  // user prompt or intent (e.g., "Click the 'Login' button"). Used to generate
  // human-friendly comments in the Selenium script.
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
  // Intelligent Interaction: when true, the server detected ambiguity.
  isAmbiguous?: boolean;
  // When true, the server is intentionally pausing and expects the caller to
  // choose among the provided candidates or otherwise clarify the request.
  requiresInteraction?: boolean;
  // Optional list of candidate elements when an action was ambiguous or when a
  // fuzzy search produced multiple strong matches.
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

// ─────────────────────────────────────────────────────────────────────────────
// Autonomous Agent Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Represents a single action the autonomous agent can take.
 */
export type AgentAction =
  | { type: 'navigate'; url: string; thought: string }
  | { type: 'click'; elementId?: string; selector?: string; semanticTarget?: string; thought: string }
  | { type: 'type'; elementId?: string; selector?: string; semanticTarget?: string; text: string; thought: string }
  | { type: 'select_option'; elementId?: string; selector?: string; semanticTarget?: string; option: string; thought: string } // NEW
  | { type: 'scrape_data'; instruction: string; thought: string } // NEW
  | { type: 'scroll'; direction: 'up' | 'down'; elementId?: string; thought: string }
  | { type: 'wait'; durationMs: number; thought: string }
  | { type: 'finish'; thought: string; summary: string };

/**
 * Result of a single step in the autonomous agent loop.
 */
export interface AgentStepResult {
  stepNumber: number;
  action: AgentAction;
  success: boolean;
  message: string;
  /** URL before the action was executed */
  urlBefore: string;
  /** URL after the action was executed */
  urlAfter: string;
  /** Whether a meaningful state change was detected (URL change, DOM change, etc.) */
  stateChanged: boolean;
  /** If the action failed, describes the recovery attempt (if any) */
  recoveryAttempt?: string;
  /** Screenshot after action (base64 data URL) */
  screenshot?: string;
  /** Element info if an element was interacted with */
  elementInfo?: ElementInfo;
  /** Error message if the step failed */
  error?: string;
  /** Number of retry attempts made for this step */
  retryCount: number;
}

/**
 * Final result of an autonomous agent session.
 */
export interface AgentSessionResult {
  success: boolean;
  /** High-level summary of what the agent accomplished */
  summary: string;
  /** The original goal/prompt */
  goal: string;
  /** Total number of steps taken */
  totalSteps: number;
  /** Detailed history of each step */
  steps: AgentStepResult[];
  /** The execution commands recorded (for Selenium generation) */
  commands: ExecutionCommand[];
  /** Generated Selenium code for replaying the session */
  seleniumCode?: string;
  /** Final screenshot */
  screenshot?: string;
  /** All interactive elements on the final page */
  selectors?: ElementInfo[];
  /** Error message if the session failed */
  error?: string;
}

/**
 * Configuration options for the autonomous agent.
 */
export interface AgentConfig {
  /** Maximum number of steps before the agent stops (default: 20) */
  maxSteps?: number;
  /** Maximum retries per failed action (default: 3) */
  maxRetriesPerAction?: number;
  /** Whether to generate Selenium code at the end (default: true) */
  generateSelenium?: boolean;
  /** Callback for real-time step updates */
  onStepComplete?: (step: AgentStepResult) => void;
  /** Callback for agent thoughts/reasoning */
  onThought?: (thought: string, action: AgentAction) => void;
  /** Direct access to the WebSocket broadcast function for real-time logging. */
  broadcast?: (msg: WebSocketMessage) => void;
}
