# Autonomous Agent Mode - Usage Guide

## Overview

The system now supports **two execution modes**:

1. **Single-Step Mode** (`action: "ai"`) - Executes ONE action per request
2. **Autonomous Agent Mode** (`action: "ai_agent"`) - Executes MULTIPLE actions in a loop until goal is complete

## Automatic Mode Detection (NEW)

As of the latest update, the `ai` action **automatically detects multi-step prompts** and routes them to the autonomous agent. This means you don't need to change your frontend code!

### What Triggers Agent Mode?

Your prompt will automatically use agent mode if it contains:

✅ **Sequential conjunctions**: "then", "next", "after", "and then", "followed by"
```
"go to website THEN click button THEN fill form"
```

✅ **Repetitive actions**: "all", "each", "every", "one by one", "for each"
```
"click on 'View Resume' on ALL boxes one by one"
```

✅ **3+ action verbs**: click, type, navigate, search, etc.
```
"navigate to site, click login, type credentials, submit"
```

✅ **Explicit ordering**: "first", "second", "third"
```
"first click Start Hiring, then click View Resume"
```

## Examples

### Example 1: Multi-Step (Auto Agent Mode)
```json
POST /api/execute
{
  "action": "ai",
  "prompt": "go to https://hyprtask.com/ click on 'Start Hiring' button. after it is navigated to another page and click on 'View Resume' button on all boxes one by one"
}
```

**What happens:**
- System detects: "after", "and", "all...one by one" → Multi-step task
- Routes to autonomous agent automatically
- Agent executes: Navigate → Click Start Hiring → Wait for page load → Click View Resume on box 1 → Click View Resume on box 2 → etc.
- Returns: Full history + Selenium code

### Example 2: Single-Step (Normal Mode)
```json
POST /api/execute
{
  "action": "ai",
  "prompt": "click the login button"
}
```

**What happens:**
- System detects: Simple, single action
- Uses single-step mode
- Executes: Click login button
- Returns: Single result

### Example 3: Explicit Agent Mode
```json
POST /api/execute
{
  "action": "ai_agent",
  "prompt": "Go to Amazon and search for laptops",
  "agentConfig": {
    "maxSteps": 20,
    "maxRetriesPerAction": 3,
    "generateSelenium": true
  }
}
```

## Self-Healing Features

When in agent mode, the system automatically:

1. **Detects Wrong Clicks**
   - Tracks URL changes and DOM state
   - If click had no effect, tries alternative elements

2. **Automatic Retries**
   - Up to 3 retries per failed action
   - Uses exponential backoff (500ms, 1000ms, 1500ms)

3. **Alternative Element Matching**
   - If exact selector fails, finds similar elements by text/role
   - Avoids re-clicking elements that already failed

4. **Action History Awareness**
   - Passes previous actions to LLM
   - Prevents infinite loops on same element

5. **State Change Verification**
   - Compares before/after state
   - Warns if action succeeded but nothing changed

## Response Format

### Agent Mode Response
```json
{
  "success": true,
  "message": "Attempted to: [goal]. Completed 5 of 5 steps. Self-healed with 2 retry attempts.",
  "screenshot": "data:image/png;base64,...",
  "selectors": [...],
  "seleniumCode": "# Python Selenium code...",
  "data": {
    "goal": "original prompt",
    "totalSteps": 5,
    "steps": [
      {
        "stepNumber": 1,
        "action": { "type": "navigate", "url": "...", "thought": "..." },
        "success": true,
        "message": "Navigated to ...",
        "urlBefore": "...",
        "urlAfter": "...",
        "stateChanged": true,
        "screenshot": "...",
        "retryCount": 0
      },
      // ... more steps
    ],
    "commands": [
      { "action": "navigate", "target": "...", "description": "..." },
      { "action": "click", "target": "...", "selectors": {...}, "description": "..." }
    ]
  }
}
```

## Configuration Options

```typescript
interface AgentConfig {
  maxSteps?: number;              // Default: 20
  maxRetriesPerAction?: number;   // Default: 3
  generateSelenium?: boolean;     // Default: true
  onStepComplete?: (step: AgentStepResult) => void;
  onThought?: (thought: string, action: AgentAction) => void;
}
```

## WebSocket Events

When using agent mode, the server broadcasts real-time events:

```javascript
// Agent reasoning
{
  "type": "log",
  "message": "ai_thought: I need to click the Start Hiring button first...",
  "data": {
    "role": "agent-reasoning",
    "thought": "...",
    "actionType": "click"
  }
}

// Step completion
{
  "type": "log",
  "message": "Step 1: Clicked button 'Start Hiring'",
  "data": {
    "stepNumber": 1,
    "action": {...},
    "success": true,
    "stateChanged": true,
    "retryCount": 0
  }
}

// Final completion
{
  "type": "success",
  "message": "ai_agent completed: Successfully completed all tasks",
  "data": {
    "totalSteps": 5,
    "success": true
  }
}
```

## Migration Guide

### No Changes Needed!

If you're already using the `ai` action, multi-step prompts will automatically use agent mode. Your existing code works as-is.

### Optional: Explicit Control

If you want explicit control over which mode to use:

```typescript
// Force agent mode
fetch('/api/execute', {
  method: 'POST',
  body: JSON.stringify({
    action: 'ai_agent',  // Explicit
    prompt: 'complex task...'
  })
})

// Force single-step mode (disable auto-detection)
// Currently not supported - modify detectMultiStepPrompt() to always return false
```

## Troubleshooting

### Issue: Agent Stops After One Step

**Possible causes:**
1. Prompt doesn't contain multi-step indicators → Add "then", "and", "all", etc.
2. Using old code without auto-detection → Pull latest changes
3. Agent decided task is complete → Check the "thought" field in logs

### Issue: Agent Gets Stuck in Loop

**Solution:** The agent has built-in loop prevention:
- Tracks failed elements (won't retry same selector)
- Max 20 steps by default
- Action history prevents repeating same approach

### Issue: Wrong Element Clicked

**Self-healing will:**
1. Detect the click had no effect (no state change)
2. On next iteration, find alternative element with similar text
3. Retry with exponential backoff
4. If still fails after 3 retries, move to different approach

## Advanced: Custom Detection Rules

To modify what triggers agent mode, edit `detectMultiStepPrompt()` in `backend/src/server.ts`:

```typescript
function detectMultiStepPrompt(prompt: string): boolean {
  // Add your custom patterns here
  const customPatterns = [
    /\bworkflow\b/,  // Any mention of "workflow"
    /\bautomation\b/ // Any mention of "automation"
  ];
  
  // ...existing logic
}
```
