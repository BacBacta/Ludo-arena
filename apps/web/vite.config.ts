import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2020',
    // MiniPay budget: watch the size (AGENTS.md rule 4)
    chunkSizeWarningLimit: 300,
  },
  // deployments.json lives in packages/contracts (single source of truth)
  server: { port: 5173, fs: { allow: ['../..'] } },
});
