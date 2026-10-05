import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development, `vite` (5173) serves the frontend with HMR and proxies /api to `wrangler pages dev` (8788).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8788',
    },
  },
});
