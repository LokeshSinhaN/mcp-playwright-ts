import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src', // Set src as root
  build: {
    outDir: '../dist', // Output to parent dist folder
    emptyOutDir: true
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
