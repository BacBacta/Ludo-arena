/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SERVER_URL?: string;
  readonly VITE_CHAIN?: string;
  /** WalletConnect (Reown) project id — enables browser-wallet connect outside
   *  MiniPay. Absent → the WalletConnect option stays hidden (MiniPay-only). */
  readonly VITE_WC_PROJECT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Build id, injected by vite (see vite.config.ts). Also written to /version.json
 *  so a running app can detect a newer deployment and auto-reload. */
declare const __APP_VERSION__: string;
