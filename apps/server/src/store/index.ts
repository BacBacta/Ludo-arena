import { MemoryStore } from './memory.js';
import { PersistentStore } from './persistent.js';
import type { Store } from './types.js';

export * from './types.js';
export { MemoryStore } from './memory.js';
export { PersistentStore } from './persistent.js';

/**
 * Redis + Postgres when both URLs are configured, in-memory otherwise.
 * Partial configuration is a mistake we refuse to guess around.
 */
export async function createStore(env: NodeJS.ProcessEnv = process.env): Promise<Store> {
  const redisUrl = env.REDIS_URL;
  const databaseUrl = env.DATABASE_URL;
  if (redisUrl && databaseUrl) {
    const store = new PersistentStore(redisUrl, databaseUrl);
    await store.init();
    console.log('[ludo-server] persistence: redis + postgres');
    return store;
  }
  if (redisUrl || databaseUrl) {
    throw new Error('Set both REDIS_URL and DATABASE_URL, or neither (in-memory dev mode).');
  }
  console.warn('[ludo-server] persistence: in-memory (no restart survival — set REDIS_URL + DATABASE_URL)');
  return new MemoryStore();
}
