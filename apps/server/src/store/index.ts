import { MemoryStore } from './memory.js';
import { PersistentStore } from './persistent.js';
import { RedisOnlyStore } from './redisOnly.js';
import type { Store } from './types.js';

export * from './types.js';
export { MemoryStore } from './memory.js';
export { PersistentStore } from './persistent.js';
export { RedisOnlyStore } from './redisOnly.js';

/**
 * Persistence backend by configuration:
 *   REDIS_URL + DATABASE_URL → Redis (hot) + Postgres (durable), full E2.1
 *   REDIS_URL only           → Redis (hot) + in-memory durable — restart
 *                              survival for in-progress games (e.g. Upstash)
 *   neither                  → in-memory (dev; no restart survival)
 *   DATABASE_URL only        → refused (Redis is required for hot state)
 */
export async function createStore(env: NodeJS.ProcessEnv = process.env): Promise<Store> {
  const redisUrl = env.REDIS_URL?.trim();
  const databaseUrl = env.DATABASE_URL?.trim();
  if (redisUrl && databaseUrl) {
    const store = new PersistentStore(redisUrl, databaseUrl);
    await store.init();
    console.log('[ludo-server] persistence: redis + postgres');
    return store;
  }
  if (redisUrl) {
    const store = new RedisOnlyStore(redisUrl);
    await store.init();
    console.log('[ludo-server] persistence: redis (hot state) + in-memory durable');
    return store;
  }
  if (databaseUrl) {
    throw new Error('DATABASE_URL set without REDIS_URL; Redis is required for hot state.');
  }
  console.warn('[ludo-server] persistence: in-memory (no restart survival — set REDIS_URL)');
  return new MemoryStore();
}
