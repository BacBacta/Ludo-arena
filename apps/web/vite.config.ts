import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// A unique id per build. Injected as __APP_VERSION__ AND written to /version.json,
// so a long-open app can poll for a newer deployment and reload itself (see App.tsx).
const BUILD_ID = Date.now().toString(36);

/** Emit /version.json (the deployed build id) alongside the bundle. */
function versionManifest(): Plugin {
  return {
    name: 'version-manifest',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version: BUILD_ID }) });
    },
  };
}

export default defineConfig({
  plugins: [react(), versionManifest()],
  define: { __APP_VERSION__: JSON.stringify(BUILD_ID) },
  build: {
    target: 'es2020',
    // MiniPay budget: watch the size (AGENTS.md rule 4)
    chunkSizeWarningLimit: 300,
  },
  server: { port: 5173 },
});
