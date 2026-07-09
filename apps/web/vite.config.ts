import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2020',
    // MiniPay budget: watch the size (AGENTS.md rule 4)
    chunkSizeWarningLimit: 300,
  },
  server: { port: 5173 },
});
