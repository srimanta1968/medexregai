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
    // Containers reach us as host.docker.internal; Vite rejects unknown Host headers with 403.
    allowedHosts: ['host.docker.internal'],
    proxy: {
      '/api': {
        // API_PROXY_TARGET overrides the API address when port 3000 is taken locally.
        target: process.env.API_PROXY_TARGET ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
};

export default defineConfig(config);
