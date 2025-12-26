import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  root: 'src', // Set src as root
  build: {
    outDir: '../dist', // Output to parent dist folder
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'src/index.html')
    }
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true
      },
      '/ws': {
        target: 'ws://localhost:5000',
        ws: true
      }
    }
  }
});
