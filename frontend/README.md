# Frontend for mcp-playwright-ts

## What This Frontend Does
This frontend is the user interface of the app. It has pages where users can log in, create tasks, and see results. Users click buttons and fill forms to interact with the app.

## Technologies Used
- React: Library for building UI components
- TypeScript: For typed JavaScript
- Playwright: For testing the UI
- Vite: Tool for fast development
- Axios: For calling backend APIs
- Tailwind CSS: For styling the pages

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
