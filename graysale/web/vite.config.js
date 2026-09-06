import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Node backend (graysale/src/server.js) runs the API on :3030. In dev we
// proxy /api to it so the SPA talks http://localhost:3030/api/v1 with CORS-free
// same-origin requests. Production build outputs to dist/ (can be served by the
// Node server or any static host).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3030',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1200,
  },
});
