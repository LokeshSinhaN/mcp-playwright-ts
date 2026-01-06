# mcp-playwright-ts

[![Version](https://img.shields.io/badge/version-1.0.0-blue)](https://github.com/LokeshSinhaN/mcp-playwright-ts)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

## Table of Contents
- [Project Overview](#project-overview)
- [Technology Stack](#technology-stack)
- [Project Structure](#project-structure)
- [Installation and Setup](#installation-and-setup)
- [Running the Application](#running-the-application)
- [Features and Functionality](#features-and-functionality)
- [Development Workflow](#development-workflow)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

## Project Overview
This application is a full-stack TypeScript project that helps users automate web tasks using Playwright. It has a backend server that handles data and logic, and a frontend interface where users can interact with it. Anyone who wants to test or automate websites can use this app, like developers or testers.

### Key Features
- ✅ Automate browser actions with Playwright
- ✅ Simple web interface to control tasks
- ✅ Backend API for managing data
- ✅ TypeScript for better code quality

## Technology Stack
### Frontend Technologies
- React: For building the user interface
- TypeScript: For adding types to JavaScript
- Playwright: For testing and automating web pages
- Vite: For fast development builds
- Axios: For making API calls

### Backend Technologies
- Express: For creating the server and APIs
- TypeScript: For typed JavaScript
- Dotenv: For managing secret settings
- Cors: For allowing cross-origin requests
- Mongoose: For connecting to MongoDB database

### Development Tools
- Node.js: Runtime for running JavaScript
- npm: Package manager for installing tools
- Git: For version control

### Database and Authentication
- MongoDB: Database to store data
- JWT: For user login and security

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

3. Create a `.env` file in the backend directory with necessary environment variables (e.g., database URL, JWT secret).

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

- **Browser Automation**: Use Playwright to automate web tasks.
- **Web Interface**: User-friendly interface for managing tasks.
- **API Backend**: RESTful API for data management.
- **TypeScript Support**: Full TypeScript implementation for better code quality.

## Development Workflow

1. Clone the repository.
2. Set up the backend and frontend as described in Installation.
3. Make changes to the code.
4. Run tests and type checks.
5. Commit and push changes.

## Troubleshooting

- Ensure Node.js version is 18+.
- Check that all dependencies are installed.
- Verify environment variables are set correctly.
- For frontend issues, check browser console for errors.

## Contributing

1. Fork the repository.
2. Create a feature branch.
3. Make your changes.
4. Submit a pull request.

## License

This project is licensed under the MIT License - see the LICENSE file for details.
