# Backend for mcp-playwright-ts

## What This Backend Does
This backend is the server part of the app. It provides APIs for the frontend to use. For example, it handles user data and runs automated tasks. It connects to the frontend by sending and receiving data through HTTP requests.

## Technologies Used
- Express: Framework to build the server and routes
- TypeScript: Adds types to JavaScript for fewer errors
- Dotenv: Loads secret settings from .env file
- Cors: Allows the frontend to talk to the backend
- Mongoose: Connects to MongoDB database
- JWT: Handles user authentication

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

- Add details about API endpoints here if available.

## Development

- `npm run type-check`: Check TypeScript types
- `npm run clean`: Clean build directory
