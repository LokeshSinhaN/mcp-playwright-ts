# Backend for mcp-playwright-ts

## What This Backend Does
This backend implements a **Model Context Protocol (MCP) server** that provides AI models with web browsing and automation capabilities. It acts as a bridge between AI assistants and web browsers, allowing them to navigate websites, interact with elements, extract information, and perform complex web tasks through natural language commands.

The server uses Google's Gemini AI to interpret user instructions and translate them into specific browser actions using Playwright. It maintains a headless browser session and streams real-time updates (screenshots, logs, results) to connected clients via WebSocket connections.

## Technologies Used
- **Express.js**: Web server framework for HTTP endpoints
- **WebSocket**: Real-time bidirectional communication
- **Playwright**: Headless browser automation library
- **Google Gemini AI**: Large language model for command interpretation
- **TypeScript**: Type-safe JavaScript development
- **CORS**: Cross-origin resource sharing support

## Folder Structure

```
backend/
├── package.json
├── README.md
├── tsconfig.json
└── src/
    ├── browserManager.ts
    ├── index.ts
    ├── mcpTools.ts
    ├── selectorExtractor.ts
    ├── seleniumGenerator.ts
    ├── server.ts
    └── types.ts
```

## Installation

1. Navigate to the backend directory:
   ```bash
   cd backend
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file with required environment variables:
   ```env
   GEMINI_API_KEY=your_google_gemini_api_key_here
   GEMINI_MODEL=gemini-2.5-flash
   PORT=5000
   CHROMEDRIVER_PATH=/path/to/chromium  # Optional
   ```

4. Obtain a Google Gemini API key from [Google AI Studio](https://makersuite.google.com/app/apikey)

## Running the Backend

- For development:
  ```bash
  npm run dev
  ```

- For production:
  ```bash
  npm run build
  npm start
  ```

## API Endpoints

The server provides both HTTP REST endpoints and WebSocket connections:

### HTTP Endpoints
- `POST /execute` - Execute a natural language command (navigation, clicking, typing)
- `GET /screenshot` - Get current browser screenshot
- `POST /close` - Close the browser session

### WebSocket Events
- **Incoming**: Commands from clients (execute actions, take screenshots)
- **Outgoing**: Real-time updates (logs, screenshots, execution results, errors)

### Environment Variables
- `GEMINI_API_KEY`: Required API key for Google Gemini AI
- `GEMINI_MODEL`: Model name (default: gemini-2.5-flash)
- `PORT`: Server port (default: 5000)
- `CHROMEDRIVER_PATH`: Path to Chrome/Chromium executable

## Development

- `npm run type-check`: Check TypeScript types
- `npm run clean`: Clean build directory
