import { defineConfig, type UserConfig } from 'vite';
import react from '@vitejs/plugin-react';

const config: UserConfig = {
  plugins: [react()],
  server: {
    port: 5173,
    // Fail loudly if 5173 is taken instead of silently moving to 5174: tests,
    // CORS and tests/config/test-config.json all expect 5173.
    strictPort: true,
    // Listen on all interfaces so the ProjexLight Test MCP container can reach the UI.
    host: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
};

export default defineConfig(config);
