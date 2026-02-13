// ─────────────────────────────────────────────────────────────────────────────
// Phantom Pool Relayer — Shared Types
// ─────────────────────────────────────────────────────────────────────────────

// Direction: 0 = buy (paying USDC to receive wBTC), 1 = sell (paying wBTC to receive USDC)
export type Direction = 0 | 1;

// ─── Order (off-chain representation) ────────────────────────────────────────
// Sent by the user to the relayer via POST /order.
// The commitment is verified locally; private fields (price, amount, nonce)
// are used only inside the relayer and are never published.
export interface Order {
  direction: Direction;
  /** Limit price in scaled units: price = USD_per_BTC * 1e4 (e.g. $96,800 → 968000000) */
  price: bigint;
  /** Order size in satoshis (e.g. 0.1 BTC → 10_000_000) */
  amount: bigint;
  /** 32-byte random nonce, as a hex string  */
  nonce: bigint;
  /** Pedersen(direction, price, amount, nonce) — must match on-chain commitment */
  commitment: string; // 0x-prefixed hex felt252
  /** Starknet address of the submitter */
  traderAddress: string;
  /** Tongo Pedersen-derived public key (felt252 hex) */
  tongoPublicKey: string;
  /** Unix timestamp ms when the relayer received this order */
  receivedAt: number;
}

// ─── Sealed order (API request body) ─────────────────────────────────────────
// What the user's client POSTs to /order.
export interface SealedOrderRequest {
  direction: 0 | 1;
  price: string;   // bigint as decimal string
  amount: string;  // bigint as decimal string
  nonce: string;   // bigint as hex string (0x-prefixed)
  commitment: string; // felt252 0x hex
  traderAddress: string;
  tongoPublicKey: string;
}

// ─── Matched pair (off-chain) ─────────────────────────────────────────────────
export interface MatchResult {
  matchId: string; // UUID
  buyCommitment: string;   // felt252 hex
  sellCommitment: string;  // felt252 hex
  /** Pedersen(settlement_amount, settlement_price) — published on-chain */
  settlementCommitment: string; // felt252 hex
  /** Off-chain only: relayer communicates these to traders */
  settlementAmount: bigint;
  settlementPrice: bigint;
  /** Raw proof bytes (UltraKeccakZK Honk) */
  proofBytes?: Buffer;
  /** Raw public inputs bytes */
  publicInputsBytes?: Buffer;
  /** Garaga calldata (felt252 array) ready for submit_match */
  proofCalldata?: string[]; // hex strings
  /** Timestamp the match was found */
  matchedAt: number;
  status: "pending_proof" | "proving" | "submitting" | "confirmed" | "settling" | "settled" | "failed";
  /** On-chain match_id (u64) once confirmed */
  onChainMatchId?: number;
  txHash?: string;
  
  // Tongo specific fields (calldata supplied by the user clients for settlement)
  buyerTransferCalldata?: string[];
  sellerTransferCalldata?: string[];
}

// ─── Order status (mirrors Cairo OrderStatus enum) ───────────────────────────
export type OrderStatus = 0 | 1 | 2 | 3 | 4;
// 0 = Inactive, 1 = Active, 2 = Matched, 3 = Settled, 4 = Cancelled

// ─── WebSocket events ─────────────────────────────────────────────────────────
export type WsEventType =
  | "order_submitted"
  | "order_matched"
  | "order_settled"
  | "order_cancelled"
  | "match_confirmed"
  | "error";

export interface WsEvent {
  type: WsEventType;
  data: unknown;
}
