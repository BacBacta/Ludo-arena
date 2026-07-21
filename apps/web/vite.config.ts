import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// A unique id per build. Injected as __APP_VERSION__ AND written to /version.json,
// so a long-open app can poll for a newer deployment and reload itself (see App.tsx).
const BUILD_ID = Date.now().toString(36);

/** Emit /version.json (the deployed build id) alongside the bundle, and stamp the
 *  build id into the service worker's CACHE name so sw.js is byte-different every
 *  deploy. That is what makes the browser's SW update check install the new worker
 *  (→ skipWaiting/clients.claim → controllerchange → the app auto-reloads onto the
 *  fresh assets). A static CACHE name only turns the worker over on a manual bump —
 *  the single point of failure that stranded users on stale code. */
function versionManifest(): Plugin {
  return {
    name: 'version-manifest',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version: BUILD_ID }) });
    },
    writeBundle(options) {
      if (!options.dir) return;
      const swPath = join(options.dir, 'sw.js');
      try {
        const src = readFileSync(swPath, 'utf8');
        writeFileSync(swPath, src.replace(/const CACHE = '[^']*'/, `const CACHE = 'ludo-${BUILD_ID}'`));
      } catch {
        /* sw.js not emitted for this build — nothing to stamp */
      }
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
