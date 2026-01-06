# Frontend for mcp-playwright-ts

## What This Frontend Does
This frontend provides a user-friendly web interface for interacting with the MCP Playwright server. It features a chat-based UI where users can type natural language commands to control web browser automation. The interface displays real-time screenshots of the browser session and shows live logs of AI actions and decisions.

Users can:
- Send commands like "navigate to google.com" or "click the search button"
- View live browser screenshots as actions are performed
- See AI reasoning and action logs in real-time
- Monitor WebSocket connection status
- Take manual screenshots on demand

## Technologies Used
- **Vanilla TypeScript**: No framework overhead for simple, fast interface
- **WebSocket API**: Real-time connection to the backend server
- **HTML5 Canvas/CSS3**: For displaying screenshots and styling
- **Vite**: Modern build tool for development and production
- **Fetch API**: For HTTP requests to the backend

## Folder Structure

```
frontend/
├── package.json
├── README.md
├── tsconfig.json
├── vite.config.ts
└── src/
    ├── index.html
    ├── main.js
    ├── main.ts
    ├── styles.css
    └── services/
        ├── api.js
        ├── api.ts
        ├── websocket.js
        └── websocket.ts
```

## Installation

1. Navigate to the frontend directory:
   ```bash
   cd frontend
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

## Running the Frontend

- For development:
  ```bash
  npm run dev
  ```

- For production build:
  ```bash
  npm run build
  npm run preview
  ```

## Development

- `npm run type-check`: Check TypeScript types
