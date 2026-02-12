// ─────────────────────────────────────────────────────────────────────────────
// Phantom Pool Relayer — HTTP + WebSocket API Server (Hono on Bun)
// ─────────────────────────────────────────────────────────────────────────────
//
// Endpoints:
//   POST /order                — accept a sealed order from a client
//   GET  /orders               — list all active order commitments (public data only)
//   GET  /matches/:id          — return match status and settlement terms
//   GET  /matches              — list all known matches (summary)
//   GET  /health               — liveness check
//   GET  /ws                   — WebSocket upgrade (real-time order events)

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { z } from "zod";
import { randomUUID } from "crypto";
import { config } from "./config.js";
import { notifier } from "./notifier.js";
import type { OrderBook } from "./orderbook.js";
import type { SealedOrderRequest, Order, MatchResult, Direction } from "./types.js";
import type { ServerWebSocket } from "bun";

// ─── WebSocket data type ──────────────────────────────────────────────────────
type WsData = { clientId: string };

// ─── Input validation schema (Zod) ───────────────────────────────────────────
const OrderSchema = z.object({
  direction: z.union([z.literal(0), z.literal(1)]),
  price: z.string().regex(/^\d+$/, "price must be a decimal integer string"),
  amount: z.string().regex(/^\d+$/, "amount must be a decimal integer string"),
  nonce: z.string().regex(/^0x[0-9a-fA-F]+$/, "nonce must be 0x-prefixed hex"),
  commitment: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/, "commitment must be 0x-prefixed hex felt252"),
  traderAddress: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/, "traderAddress must be 0x-prefixed hex"),
  tongoPublicKey: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/, "tongoPublicKey must be 0x-prefixed hex"),
});

// ─── createServer ─────────────────────────────────────────────────────────────
export function createServer(
  book: OrderBook,
  matches: Map<string, MatchResult>
) {
  const app = new Hono();

  // ── Middleware ──────────────────────────────────────────────────────────────
  app.use("*", cors({ origin: "*" }));
  app.use("*", logger());

  // ── GET /health ─────────────────────────────────────────────────────────────
  app.get("/health", (c) =>
    c.json({
      status: "ok",
      orders: book.size(),
      matches: matches.size,
      wsClients: notifier.wsClientCount(),
      timestamp: Date.now(),
    })
  );

  // ── POST /order ─────────────────────────────────────────────────────────────
  app.post("/order", async (c) => {
    let body: SealedOrderRequest;
    try {
      body = await c.req.json<SealedOrderRequest>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = OrderSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        400
      );
    }

    const data = parsed.data;

    const order: Order = {
      direction: data.direction as Direction,
      price: BigInt(data.price),
      amount: BigInt(data.amount),
      nonce: BigInt(data.nonce),
      commitment: data.commitment.toLowerCase(),
      traderAddress: data.traderAddress.toLowerCase(),
      tongoPublicKey: data.tongoPublicKey.toLowerCase(),
      receivedAt: Date.now(),
    };

    const err = book.add(order);
    if (err) {
      return c.json({ error: err }, 400);
    }

    console.log(
      `[server] Order accepted: ${order.commitment.slice(0, 12)}… ` +
        `dir=${order.direction} price=${order.price} amount=${order.amount}`
    );

    notifier.emit({
      type: "order_submitted",
      data: {
        commitment: order.commitment,
        direction: order.direction,
        traderAddress: order.traderAddress,
        receivedAt: order.receivedAt,
      },
    });

    return c.json({ ok: true, commitment: order.commitment }, 201);
  });

  // ── GET /orders ─────────────────────────────────────────────────────────────
  app.get("/orders", (c) => {
    return c.json({
      orders: book.publicOrders(),
      buys: book.buyCount(),
      sells: book.sellCount(),
      total: book.size(),
    });
  });

  // ── GET /matches ──────────────────────────────────────────────────────────
  app.get("/matches", (c) => {
    const list = [...matches.values()].map((m) => ({
      matchId: m.matchId,
      buyCommitment: m.buyCommitment,
      sellCommitment: m.sellCommitment,
      settlementCommitment: m.settlementCommitment,
      status: m.status,
      matchedAt: m.matchedAt,
      onChainMatchId: m.onChainMatchId,
      txHash: m.txHash,
    }));
    return c.json({ matches: list, total: list.length });
  });

  // ── POST /matches/:id/settle ─────────────────────────────────────────────────
  // Called by standard users with their Tongo SDK payloads for the 
  // PhantomPool.submit_settlement execution!
  app.post("/matches/:id/settle", async (c) => {
    const id = c.req.param("id");
    const match = matches.get(id);
    if (!match) {
      return c.json({ error: "Match not found" }, 404);
    }
    
    // Check if body provides buyer or seller info
    let body: { role?: "buyer" | "seller"; calldata?: string[] };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.role || !body.calldata) {
      return c.json({ error: "role and calldata required" }, 400);
    }

    if (body.role === "buyer") {
      match.buyerTransferCalldata = body.calldata;
      console.log(`[server] Tongo USDC Payload received from BUYER for match ${id}`);
    } else {
      match.sellerTransferCalldata = body.calldata;
      console.log(`[server] Tongo wBTC Payload received from SELLER for match ${id}`);
    }
    
    // The relayer main loop will pick it up and submit_settlement 
    // when both payloads are loaded!
    return c.json({ ok: true });
  });

  // ── GET /matches/:id ────────────────────────────────────────────────────────
  app.get("/matches/:id", (c) => {
    const id = c.req.param("id");
    const match = matches.get(id);
    if (!match) {
      return c.json({ error: "Match not found" }, 404);
    }
    return c.json({
      matchId: match.matchId,
      buyCommitment: match.buyCommitment,
      sellCommitment: match.sellCommitment,
      settlementCommitment: match.settlementCommitment,
      settlementAmount: match.settlementAmount.toString(),
      settlementPrice: match.settlementPrice.toString(),
      status: match.status,
      matchedAt: match.matchedAt,
      onChainMatchId: match.onChainMatchId,
      txHash: match.txHash,
    });
  });

  // ── GET /stats ──────────────────────────────────────────────────────────────
  app.get("/stats", (c) => {
    const allMatches = [...matches.values()];
    return c.json({
      totalOrders: book.size(),
      buyOrders: book.buyCount(),
      sellOrders: book.sellCount(),
      totalMatches: allMatches.length,
      pendingProof: allMatches.filter((m) => m.status === "pending_proof").length,
      proving: allMatches.filter((m) => m.status === "proving").length,
      confirmed: allMatches.filter((m) => m.status === "confirmed").length,
      failed: allMatches.filter((m) => m.status === "failed").length,
      wsClients: notifier.wsClientCount(),
    });
  });

  return app;
}

// ─── startServer ──────────────────────────────────────────────────────────────
export function startServer(
  app: ReturnType<typeof createServer>,
  port: number
): void {
  Bun.serve<WsData>({
    port,
    fetch(req, server) {
      // WebSocket upgrade
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const url = new URL(req.url);
        if (url.pathname === "/ws") {
          const clientId = randomUUID();
          const success = server.upgrade(req, { data: { clientId } });
          if (success) return undefined as unknown as Response;
          return new Response("WebSocket upgrade failed", { status: 500 });
        }
      }
      // Regular HTTP → Hono
      return app.fetch(req);
    },
    websocket: {
      open(ws: ServerWebSocket<WsData>) {
        const { clientId } = ws.data;
        notifier.addWsClient(clientId, (msg) => ws.send(msg));
        ws.send(
          JSON.stringify({
            type: "connected",
            data: { clientId, timestamp: Date.now() },
          })
        );
      },
      message(ws: ServerWebSocket<WsData>, message: string | Buffer) {
        try {
          const parsed = JSON.parse(message.toString()) as { type?: string };
          if (parsed.type === "ping") {
            ws.send(
              JSON.stringify({ type: "pong", data: { timestamp: Date.now() } })
            );
          }
        } catch {
          // Ignore malformed messages
        }
      },
      close(ws: ServerWebSocket<WsData>) {
        notifier.removeWsClient(ws.data.clientId);
      },
    },
  });

  console.log(`\n🌑 Phantom Pool Relayer listening on http://localhost:${port}`);
  console.log(`   WebSocket: ws://localhost:${port}/ws`);
}
