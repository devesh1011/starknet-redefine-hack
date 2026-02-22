// ─────────────────────────────────────────────────────────────────────────────
// Phantom Pool Relayer — In-Memory Order Book
// ─────────────────────────────────────────────────────────────────────────────
// Holds sealed orders revealed by traders to the relayer for matching.
// Orders are kept in two priority queues:
//   • Buys  — descending by price (highest bid first)
//   • Sells — ascending  by price (lowest ask first)
//
// Commitment verification:
//   Noir circuit: commitment = Pedersen(direction, price, amount, nonce)
//   We verify this on the Starknet Pedersen curve using starknet.js before
//   accepting an order into the book.

// @ts-ignore
import { buildPoseidon } from 'circomlibjs';
import type { Order, Direction } from "./types.js";

let poseidon: any;

export async function initCrypto() {
  if (!poseidon) {
    poseidon = await buildPoseidon();
  }
}

// ─── Commitment helper ───────────────────────────────────────────────
export function computeCommitment(
  direction: Direction,
  price: bigint,
  amount: bigint,
  nonce: bigint
): string {
  if (!poseidon) throw new Error("Crypto not initialized");
  
  const hash = poseidon([direction, price, amount, nonce]);
  return "0x" + poseidon.F.toString(hash, 16).padStart(64, '0');
}

// ─── OrderBook ────────────────────────────────────────────────────────────────
export class OrderBook {
  // commitment hex → Order
  private readonly _orders = new Map<string, Order>();

  // Sorted arrays maintained for O(n) best-price access.
  // For a hackathon scale (hundreds of orders) this is perfectly fine.
  private _buys: Order[] = [];  // descending price
  private _sells: Order[] = []; // ascending price

  // ── Add ─────────────────────────────────────────────────────────────────────
  /**
   * Validate and add an order to the book.
   * Returns an error string if the order is invalid.
   */
  add(order: Order): string | null {
    // 1. Verify commitment
    const expected = computeCommitment(
      order.direction,
      order.price,
      order.amount,
      order.nonce
    );
    if (expected.toLowerCase() !== order.commitment.toLowerCase()) {
      return `Commitment mismatch: expected ${expected}, got ${order.commitment}`;
    }

    // 2. Reject duplicates
    if (this._orders.has(order.commitment)) {
      return `Order already in book: ${order.commitment}`;
    }

    // 3. Basic sanity
    if (order.amount <= 0n) return "Amount must be > 0";
    if (order.price <= 0n) return "Price must be > 0";

    this._orders.set(order.commitment, order);

    if (order.direction === 0) {
      this._buys.push(order);
      this._buys.sort((a, b) => (a.price > b.price ? -1 : a.price < b.price ? 1 : 0));
    } else {
      this._sells.push(order);
      this._sells.sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0));
    }

    return null; // success
  }

  // ── Remove ───────────────────────────────────────────────────────────────────
  remove(commitment: string): void {
    const order = this._orders.get(commitment);
    if (!order) return;
    this._orders.delete(commitment);

    if (order.direction === 0) {
      this._buys = this._buys.filter((o) => o.commitment !== commitment);
    } else {
      this._sells = this._sells.filter((o) => o.commitment !== commitment);
    }
  }

  // ── Best bid / ask ───────────────────────────────────────────────────────────
  bestBuy(): Order | undefined {
    return this._buys[0];
  }

  bestSell(): Order | undefined {
    return this._sells[0];
  }

  // ── Accessors ────────────────────────────────────────────────────────────────
  get(commitment: string): Order | undefined {
    return this._orders.get(commitment);
  }

  allOrders(): Order[] {
    return [...this._orders.values()];
  }

  buyCount(): number {
    return this._buys.length;
  }

  sellCount(): number {
    return this._sells.length;
  }

  size(): number {
    return this._orders.size;
  }

  /**
   * Return public view of active orders (omits private fields price/amount/nonce).
   */
  publicOrders(): Array<{
    commitment: string;
    direction: Direction;
    traderAddress: string;
    receivedAt: number;
  }> {
    return this.allOrders().map((o) => ({
      commitment: o.commitment,
      direction: o.direction,
      traderAddress: o.traderAddress,
      receivedAt: o.receivedAt,
    }));
  }
}
