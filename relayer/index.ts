// ─────────────────────────────────────────────────────────────────────────────
// Phantom Pool Relayer — Entry Point
// ─────────────────────────────────────────────────────────────────────────────
// Boot sequence:
//   1. Load config from .env
//   2. Create Relay (orderbook + matching engine + prover + submitter)
//   3. Create Hono HTTP + WebSocket server and wire it to the relay
//   4. Start background loops (matchLoop + pollLoop)

import { config } from "./src/config.js";
import { Relay } from "./src/relay.js";
import { createServer, startServer } from "./src/server.js";

// ── Print startup banner ──────────────────────────────────────────────────────
console.log(`
╔══════════════════════════════════════════════════════╗
║   🌑  Phantom Pool — Off-chain Relayer               ║
║       Private BTC Dark Pool DEX on Starknet          ║
╠══════════════════════════════════════════════════════╣
║  RPC         ${config.rpcUrl.padEnd(38)} ║
║  Pool addr   ${config.phantomPoolAddress.padEnd(38)} ║
║  Match every ${String(config.matchIntervalMs + "ms").padEnd(38)} ║
║  Poll every  ${String(config.pollIntervalMs + "ms").padEnd(38)} ║
╚══════════════════════════════════════════════════════╝
`);

// ── Instantiate core components ───────────────────────────────────────────────
const relay = new Relay();

// ── Build Hono app ────────────────────────────────────────────────────────────
const app = createServer(relay.book, relay.matches);

// ── Wire POST /order to also register order secrets in the relay ──────────────
// We override the route registration: the server already handles validation and
// adds to book; the relay needs the private data too. We achieve this via a
// middleware that reads the body and calls relay.registerOrderSecrets().
//
// NOTE: Hono composes routes in registration order. The second `post("/order")`
// below runs AFTER the one in server.ts because `app` is returned from
// createServer. We use app.use() on the path with a clone-body trick.
app.use("/order", async (c, next) => {
  // Only intercept POST — Hono middleware runs for all methods unless filtered
  if (c.req.method !== "POST") return next();

  // Clone the request body so both middleware and the handler can read it
  const cloned = c.req.raw.clone();
  await next(); // Let server.ts handler run first (validates + adds to book)

  // If the response is 201 Created the order was accepted; extract private fields
  if (c.res.status === 201) {
    try {
      const body = await cloned.json() as { commitment?: string };
      const order = relay.book.get(body.commitment?.toLowerCase() ?? "");
      if (order) {
        relay.registerOrderSecrets(order);
      }
    } catch {
      // Body parse error — ignore; order secrets just won't be available for proving
    }
  }
});

// ── Start HTTP + WS server ────────────────────────────────────────────────────
startServer(app, config.port);

// ── Start background loops ────────────────────────────────────────────────────
relay.start();

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on("SIGINT", () => {
  console.log("\n[main] Received SIGINT — shutting down…");
  relay.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n[main] Received SIGTERM — shutting down…");
  relay.stop();
  process.exit(0);
});