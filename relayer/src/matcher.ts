// ─────────────────────────────────────────────────────────────────────────────
// Phantom Pool Relayer — Matching Engine
// ─────────────────────────────────────────────────────────────────────────────
// Finds crossing order pairs (buy.price >= sell.price) from the order book
// and computes settlement terms.
//
// Settlement rules (mirrors MatchCorrectnessProof circuit):
//   settlement_amount = min(buy_amount, sell_amount)
//   settlement_price  = (buy_price + sell_price) / 2   [integer midpoint]
//   settlement_commitment = Pedersen(settlement_amount, settlement_price)

import { hash } from "starknet";
import type { Order, MatchResult } from "./types.js";
import type { OrderBook } from "./orderbook.js";
import { randomUUID } from "crypto";

// ─── Commitment helpers ────────────────────────────────────────────────────────
// Mirrors Noir: dep::std::hash::pedersen_hash([settlement_amount as Field, settlement_price as Field])
export function computeSettlementCommitment(
  settlementAmount: bigint,
  settlementPrice: bigint
): string {
  return hash.computePedersenHashOnElements([
    `0x${settlementAmount.toString(16)}`,
    `0x${settlementPrice.toString(16)}`,
  ]);
}

// ─── MatchingEngine ───────────────────────────────────────────────────────────
export class MatchingEngine {
  constructor(private readonly book: OrderBook) {}

  /**
   * Run one matching iteration.
   * Greedy: repeatedly pull best buy + best sell and match if they cross.
   * Returns an array of pending MatchResults (proofs not yet generated).
   */
  match(): MatchResult[] {
    const results: MatchResult[] = [];

    while (true) {
      const buy = this.book.bestBuy();
      const sell = this.book.bestSell();

      // Need both sides
      if (!buy || !sell) break;

      // Price crossing check: buy.price >= sell.price
      if (buy.price < sell.price) {
        // Spread hasn't closed — no match possible
        break;
      }

      // ── Compute settlement terms ────────────────────────────────────────────
      const settlementAmount: bigint =
        buy.amount < sell.amount ? buy.amount : sell.amount;

      // Integer midpoint. Note: if sum is odd this may produce a non-integer
      // pricepoint.  The Noir circuit asserts `settlement_price * 2 == buy_price + sell_price`,
      // so both prices must sum to an even number.  We enforce this here and
      // skip non-matching pairs (shouldn't happen with well-formed orders but
      // guards against rogue inputs).
      const priceSum = buy.price + sell.price;
      if (priceSum % 2n !== 0n) {
        // Odd sum — cannot form a valid midpoint without fractions.
        // Skip this pair: remove the older order and try next iteration.
        console.warn(
          `[matcher] Skipping pair — odd price sum prevents exact midpoint. ` +
            `buy=${buy.price} sell=${sell.price}`
        );
        // Remove the older order (by receivedAt) to avoid getting stuck
        if (buy.receivedAt < sell.receivedAt) {
          this.book.remove(buy.commitment);
        } else {
          this.book.remove(sell.commitment);
        }
        continue;
      }
      const settlementPrice: bigint = priceSum / 2n;

      if (settlementAmount === 0n) {
        // Should not happen — sanity guard
        this.book.remove(buy.commitment);
        this.book.remove(sell.commitment);
        continue;
      }

      const settlementCommitment = computeSettlementCommitment(
        settlementAmount,
        settlementPrice
      );

      const result: MatchResult = {
        matchId: randomUUID(),
        buyCommitment: buy.commitment,
        sellCommitment: sell.commitment,
        settlementCommitment,
        settlementAmount,
        settlementPrice,
        matchedAt: Date.now(),
        status: "pending_proof",
      };

      results.push(result);

      // Remove fully filled orders; partial fills not supported in MVP
      this.book.remove(buy.commitment);
      this.book.remove(sell.commitment);

      console.log(
        `[matcher] ✅ Match found | buy=${buy.commitment.slice(0, 10)}… ` +
          `sell=${sell.commitment.slice(0, 10)}… ` +
          `amount=${settlementAmount} price=${settlementPrice}`
      );
    }

    return results;
  }

  /**
   * Validate a match client-side before sending to prover.
   * Ensures the private order data satisfies all Noir circuit constraints.
   * Returns an error string if validation fails.
   */
  static validateMatch(
    buy: Order,
    sell: Order,
    result: MatchResult
  ): string | null {
    if (buy.price < sell.price) return "Orders do not cross";

    const expectedAmount =
      buy.amount < sell.amount ? buy.amount : sell.amount;
    if (result.settlementAmount !== expectedAmount)
      return `Settlement amount mismatch: expected ${expectedAmount}, got ${result.settlementAmount}`;

    const expectedPrice = (buy.price + sell.price) / 2n;
    if (result.settlementPrice !== expectedPrice)
      return `Settlement price mismatch: expected ${expectedPrice}, got ${result.settlementPrice}`;

    const expectedCommitment = computeSettlementCommitment(
      result.settlementAmount,
      result.settlementPrice
    );
    if (
      expectedCommitment.toLowerCase() !==
      result.settlementCommitment.toLowerCase()
    )
      return `Settlement commitment mismatch`;

    return null;
  }
}
