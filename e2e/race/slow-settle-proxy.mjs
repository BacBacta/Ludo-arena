/**
 * Mainnet-latency emulator for the bench: a JSON-RPC proxy that forwards
 * everything to hardhat INSTANTLY except the SETTLE-family transactions
 * (settle / settleBatch), which it holds for SETTLE_DELAY_MS before
 * forwarding. Hardhat settles in ~75 ms, which hides a whole class of
 * "payout still in flight" bugs that are routine on Celo (settlement takes
 * seconds); this proxy restores that window deterministically. Faucet drips,
 * approvals, joins and every read pass through untouched.
 *
 * Usage: node e2e/race/slow-settle-proxy.mjs [listenPort=8546] [upstream=http://127.0.0.1:8545] [delayMs=10000]
 * Point ONLY the server's SETTLEMENT_RPC at the proxy.
 */
import { createServer } from 'node:http';
import { parseTransaction, keccak256, stringToBytes } from 'viem';

const LISTEN = Number(process.argv[2] ?? 8546);
const UPSTREAM = process.argv[3] ?? 'http://127.0.0.1:8545';
const DELAY_MS = Number(process.argv[4] ?? 10_000);

const SETTLE_SELECTORS = new Set(
  [
    'settle(bytes32,address,string,string,string,bytes)',
    'settleBatch(bytes32[],address[],bytes[])',
  ].map((sig) => keccak256(stringToBytes(sig)).slice(0, 10)),
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function forward(body) {
  const res = await fetch(UPSTREAM, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  return res.text();
}

createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    let delay = 0;
    try {
      const msg = JSON.parse(raw);
      const calls = Array.isArray(msg) ? msg : [msg];
      for (const c of calls) {
        if (c.method === 'eth_sendRawTransaction') {
          const tx = parseTransaction(c.params[0]);
          const selector = (tx.data ?? '0x').slice(0, 10);
          if (SETTLE_SELECTORS.has(selector)) {
            delay = DELAY_MS;
            console.log(`[slow-settle] holding a settle tx for ${DELAY_MS}ms (to=${tx.to})`);
          }
        }
      }
    } catch {
      /* non-JSON or unparsable tx: pass through untouched */
    }
    if (delay) await sleep(delay);
    try {
      const out = await forward(raw);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(out);
    } catch (e) {
      res.writeHead(502);
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: String(e) } }));
    }
  });
}).listen(LISTEN, '127.0.0.1', () => {
  console.log(`[slow-settle] :${LISTEN} → ${UPSTREAM}, settle txs delayed ${DELAY_MS}ms`);
});
