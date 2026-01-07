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
  roleHint?: 'button' | 'link' | 'input' | 'other';
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
