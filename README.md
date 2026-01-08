# mcp-playwright-ts

[![Version](https://img.shields.io/badge/version-1.0.0-blue)](https://github.com/LokeshSinhaN/mcp-playwright-ts)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)



## Project Overview
This project implements a **Model Context Protocol (MCP) server** that enables AI models to interact with and automate web browsers using Playwright. It consists of a backend MCP server that handles AI-driven web automation tasks and a frontend web interface for users to control and monitor the automation in real-time.

The system allows AI assistants to:
- Navigate websites
- Click buttons and links
- Fill forms and input fields
- Extract information from web pages
- Take screenshots
- Handle cookie banners automatically

Users can give natural language instructions through the web interface, and the AI (powered by Google's Gemini) interprets these commands to perform the appropriate browser actions. All activity is streamed in real-time via WebSocket connections.

### Key Features
- ✅ **AI-Powered Web Automation**: Uses Gemini AI to understand natural language commands
- ✅ **Real-Time Web Interface**: Live chat interface with screenshot updates
- ✅ **MCP Protocol Support**: Standard protocol for AI tool integration
- ✅ **Headless Browser Control**: Automated Playwright browser sessions
- ✅ **TypeScript Implementation**: Full type safety and modern development practices

## Technology Stack
### Frontend Technologies
- **Vanilla TypeScript**: For building the interactive web interface
- **WebSocket API**: For real-time communication with the backend
- **HTML5/CSS3**: For the user interface layout and styling
- **Vite**: For fast development builds and hot reloading

### Backend Technologies
- **Express.js**: For creating the HTTP server and REST API endpoints
- **WebSocket Server**: For real-time streaming of browser automation events
- **Playwright**: For headless browser automation and web scraping
- **Google Gemini AI**: For natural language understanding and action planning
- **TypeScript**: For type-safe server-side development
- **CORS**: For cross-origin request handling

### Development Tools
- **Node.js**: Runtime environment for both frontend and backend
- **npm**: Package management and script running
- **Git**: Version control system

### AI and Automation
- **Model Context Protocol (MCP)**: Standard for AI tool integration
- **Headless Chrome/Chromium**: Browser engine for automation

## Project Structure

```
mcp-playwright-ts/
├── README.md
├── backend/
│   ├── package.json
│   ├── README.md
│   ├── tsconfig.json
│   └── src/
│       ├── browserManager.ts
│       ├── index.ts
│       ├── mcpTools.ts
│       ├── selectorExtractor.ts
│       ├── seleniumGenerator.ts
│       ├── server.ts
│       └── types.ts
└── frontend/
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

## Installation and Setup

### Prerequisites
- Node.js (version 18 or higher)
- npm or yarn

### Backend Setup
1. Navigate to the backend directory:
   ```bash
   cd backend
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file in the backend directory with required environment variables:
   ```env
   GEMINI_API_KEY=your_google_gemini_api_key_here
   GEMINI_MODEL=gemini-2.5-flash
   PORT=5000
   CHROMEDRIVER_PATH=/path/to/chromium  # Optional, for custom Chrome path
   ```

4. Get a Google Gemini API key from [Google AI Studio](https://makersuite.google.com/app/apikey)

### Frontend Setup
1. Navigate to the frontend directory:
   ```bash
   cd frontend
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

## Running the Application

### Development Mode
1. Start the backend server:
   ```bash
   cd backend
   npm run dev
   ```

2. In a new terminal, start the frontend:
   ```bash
   cd frontend
   npm run dev
   ```

3. Open your browser and navigate to `http://localhost:5173` (or the port specified by Vite).

### Production Mode
1. Build the backend:
   ```bash
   cd backend
   npm run build
   npm start
   ```

2. Build the frontend:
   ```bash
   cd frontend
   npm run build
   npm run preview
   ```

## Features and Functionality

- **Natural Language Web Control**: Give commands like "go to google.com and search for TypeScript" and watch the AI execute them
- **Real-Time Visual Feedback**: See live screenshots as the browser navigates and interacts with pages
- **Intelligent Element Detection**: AI automatically identifies clickable elements, forms, and interactive components
- **Chat-Based Interface**: Conversational UI for issuing commands and receiving status updates
- **WebSocket Streaming**: Instant updates of browser actions, screenshots, and AI decisions
- **Cookie Banner Handling**: Automatic detection and dismissal of cookie consent banners
- **Selector Extraction**: Advanced algorithms to find reliable CSS selectors and XPath expressions
- **Selenium Code Generation**: Export browser actions as Selenium WebDriver code
- **Headless Operation**: Runs invisibly in the background, perfect for automation scripts

## Development Workflow

1. **Setup**: Clone the repository and follow the installation steps above
2. **Backend Development**: 
   - Modify server logic in `backend/src/`
   - Add new MCP tools in `mcpTools.ts`
   - Test AI integration with different prompts
3. **Frontend Development**:
   - Update the UI in `frontend/src/`
   - Enhance real-time features and user experience
4. **Testing**: 
   - Run both servers and test end-to-end automation
   - Try various natural language commands
   - Verify WebSocket streaming works correctly
5. **Build & Deploy**: Use the production build commands for deployment

## Troubleshooting

- **"GEMINI_API_KEY is not configured"**: Make sure you have set the GEMINI_API_KEY in your backend .env file
- **WebSocket connection fails**: Ensure the backend server is running on the expected port
- **Browser automation not working**: Check that Chrome/Chromium is installed and accessible
- **Screenshots not updating**: Verify WebSocket connection is stable
- **AI not understanding commands**: Try more specific instructions, like "click the blue button" instead of "click that button"
- **Node.js version issues**: Ensure you're using Node.js 18 or higher
- **Port conflicts**: Change the PORT in .env if 5000 is already in use

## Contributing

1. Fork the repository.
2. Create a feature branch.
3. Make your changes.
4. Submit a pull request.

## License

This project is licensed under the MIT License - see the LICENSE file for details.
