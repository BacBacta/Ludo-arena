import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2020',
    // Budget MiniPay : surveiller la taille (AGENTS.md règle 4)
    chunkSizeWarningLimit: 300,
  },
  server: { port: 5173 },
});
