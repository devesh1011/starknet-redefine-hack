// ─────────────────────────────────────────────────────────────────────────────
// Phantom Pool Relayer — Main Orchestrator
// ─────────────────────────────────────────────────────────────────────────────
// Wires together the order book, matching engine, prover, and Starknet
// submitter into two background loops:
//
//   matchLoop  — runs every `config.matchIntervalMs`:
//     1. Call MatchingEngine.match() → get pending MatchResults
//     2. For each result: call prove() → get Garaga calldata
//     3. Call submitter.submitMatch() → broadcast on Starknet
//     4. Notify connected clients via WebSocket
//
//   pollLoop   — runs every `config.pollIntervalMs`:
//     1. Call submitter.pollOrderEvents() → get new on-chain commitments
//     2. Log / emit events so the UI can show on-chain status

import { config } from "./config.js";
import { OrderBook } from "./orderbook.js";
import { MatchingEngine } from "./matcher.js";
import { prove } from "./prover.js";
import { Submitter } from "./submitter.js";
import { notifier } from "./notifier.js";
import type { MatchResult, Order } from "./types.js";

export class Relay {
  readonly book = new OrderBook();
  readonly matches = new Map<string, MatchResult>();

  private readonly engine: MatchingEngine;
  private readonly submitter: Submitter;

  // Lookup: commitment → Order (so prover can access private inputs)
  // Only orders currently in the book (or recently matched) are held here.
  private readonly orderSecrets = new Map<string, Order>();

  private matchTimer?: Timer;
  private pollTimer?: Timer;
  private running = false;

  constructor() {
    this.engine = new MatchingEngine(this.book);
    this.submitter = new Submitter();
  }

  // ── Register order secrets (private inputs for proving) ───────────────────
  // Called when a user submits an order via POST /order. The server calls this
  // so the relay has the private data available when it needs to prove a match.
  registerOrderSecrets(order: Order): void {
    this.orderSecrets.set(order.commitment, order);
  }

  // ── Start loops ───────────────────────────────────────────────────────────
  start(): void {
    if (this.running) return;
    this.running = true;

    console.log(
      `[relay] Starting matchLoop every ${config.matchIntervalMs}ms, ` +
        `pollLoop every ${config.pollIntervalMs}ms`
    );

    this.matchTimer = setInterval(
      () => this._runMatchLoop().catch((e) => console.error("[relay] matchLoop error:", e)),
      config.matchIntervalMs
    );

    this.pollTimer = setInterval(
      () => this._runPollLoop().catch((e) => console.error("[relay] pollLoop error:", e)),
      config.pollIntervalMs
    );

    // Run immediately for faster startup feedback
    this._runMatchLoop().catch(() => {});
    this._runPollLoop().catch(() => {});
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.matchTimer) clearInterval(this.matchTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    console.log("[relay] Stopped.");
  }

  // ── Match loop ─────────────────────────────────────────────────────────────
  private async _runMatchLoop(): Promise<void> {
    const pending = this.engine.match();
    if (pending.length === 0) return;

    console.log(`[relay] matchLoop: ${pending.length} new match(es) found`);

    for (const match of pending) {
      this.matches.set(match.matchId, match);

      // Notify clients that a match was found (before proof is ready)
      notifier.emit({
        type: "order_matched",
        data: {
          matchId: match.matchId,
          buyCommitment: match.buyCommitment,
          sellCommitment: match.sellCommitment,
          settlementCommitment: match.settlementCommitment,
          // Settlement terms published so both parties can build Tongo proofs
          settlementAmount: match.settlementAmount.toString(),
          settlementPrice: match.settlementPrice.toString(),
          status: "pending_proof",
        },
      });

      // Kick off proof + submission asynchronously (don't block loop)
      this._proveAndSubmit(match).catch((e) =>
        console.error(`[relay] _proveAndSubmit error for ${match.matchId}:`, e)
      );
    }
  }

  // ── Prove + submit (async, per match) ──────────────────────────────────────
  private async _proveAndSubmit(match: MatchResult): Promise<void> {
    const buyOrder = this.orderSecrets.get(match.buyCommitment);
    const sellOrder = this.orderSecrets.get(match.sellCommitment);

    if (!buyOrder || !sellOrder) {
      console.error(
        `[relay] Missing order secrets for match ${match.matchId}. ` +
          `buy=${!!buyOrder} sell=${!!sellOrder}. Skipping proof.`
      );
      match.status = "failed";
      this.matches.set(match.matchId, { ...match });
      return;
    }

    // ── 1. Prove ────────────────────────────────────────────────────────────
    match.status = "proving";
    this.matches.set(match.matchId, { ...match });
    console.log(`[relay] Proving match ${match.matchId}…`);

    let calldata: string[];
    let proofBytes: Buffer | undefined;
    let publicInputsBytes: Buffer | undefined;

    try {
      const result = await prove(buyOrder, sellOrder, match);
      calldata = result.calldata;
      proofBytes = result.proofBytes;
      publicInputsBytes = result.publicInputsBytes;
    } catch (err) {
      console.error(`[relay] Proof failed for match ${match.matchId}:`, err);
      match.status = "failed";
      this.matches.set(match.matchId, { ...match });
      notifier.emit({
        type: "error",
        data: { matchId: match.matchId, reason: String(err) },
      });
      return;
    }

    match.proofCalldata = calldata;
    match.proofBytes = proofBytes;
    match.publicInputsBytes = publicInputsBytes;
    this.matches.set(match.matchId, { ...match });

    // ── 2. Submit ───────────────────────────────────────────────────────────
    match.status = "submitting";
    this.matches.set(match.matchId, { ...match });
    console.log(`[relay] Submitting match ${match.matchId}…`);

    try {
      const txHash = await this.submitter.submitMatch(match);
      match.status = "confirmed";
      match.txHash = txHash;
      this.matches.set(match.matchId, { ...match });

      console.log(`[relay] ✅ Match ${match.matchId} confirmed → tx ${txHash}`);

      notifier.emit({
        type: "match_confirmed",
        data: {
          matchId: match.matchId,
          txHash,
          buyCommitment: match.buyCommitment,
          sellCommitment: match.sellCommitment,
          settlementCommitment: match.settlementCommitment,
          settlementAmount: match.settlementAmount.toString(),
          settlementPrice: match.settlementPrice.toString(),
        },
      });

      // Clean up private order data (no longer needed once confirmed)
      this.orderSecrets.delete(match.buyCommitment);
      this.orderSecrets.delete(match.sellCommitment);
    } catch (err) {
      console.error(`[relay] Submit failed for match ${match.matchId}:`, err);
      match.status = "failed";
      this.matches.set(match.matchId, { ...match });
      notifier.emit({
        type: "error",
        data: { matchId: match.matchId, reason: String(err) },
      });
    }
  }

  // ── 3. Try settlement mechanism ─────────────────────────────────────────────
  private async _trySubmitSettlement(match: MatchResult): Promise<void> {
    if (match.status !== "confirmed") return;
    if (!match.buyerTransferCalldata || !match.sellerTransferCalldata) return;

    match.status = "settling";
    this.matches.set(match.matchId, { ...match });

    console.log(`[relay] Executing Tongo Settlement for match ${match.matchId}…`);

    try {
      const txHash = await this.submitter.submitSettlement(match);
      match.status = "settled";
      // Update with the final settlement tx hash instead of the match hash
      match.txHash = txHash;
      this.matches.set(match.matchId, { ...match });

      console.log(`[relay] ✅ Match ${match.matchId} completely settled on-chain!`);

      notifier.emit({
        type: "order_settled",
        data: {
          matchId: match.matchId,
          txHash,
        },
      });
    } catch (err) {
      console.error(`[relay] Settlement failed for match ${match.matchId}:`, err);
      // Revert to confirmed so it can be retried or debugged
      match.status = "confirmed";
      this.matches.set(match.matchId, { ...match });
      notifier.emit({
        type: "error",
        data: { matchId: match.matchId, reason: String(err) },
      });
    }
  }

  // ── Poll loop ──────────────────────────────────────────────────────────────
  private async _runPollLoop(): Promise<void> {
    // 1. Poll Starknet for new event commitments
    const newCommitments = await this.submitter.pollOrderEvents();
    if (newCommitments.length > 0) {
      console.log(
        `[relay] pollLoop: ${newCommitments.length} new on-chain commitment(s)`
      );
      for (const commitment of newCommitments) {
        notifier.emit({
          type: "order_submitted",
          data: { commitment, source: "on_chain" },
        });
      }
    }

    // 2. Continually try to process pending Tongo Settlements
    for (const match of this.matches.values()) {
      if (
        match.status === "confirmed" &&
        match.buyerTransferCalldata &&
        match.sellerTransferCalldata
      ) {
        this._trySubmitSettlement(match).catch((e) =>
          console.error(`[relay] _trySubmitSettlement error:`, e)
        );
      }
    }
  }

  // ── Accessors ──────────────────────────────────────────────────────────────
  isOnChain(commitment: string): boolean {
    return this.submitter.isOnChain(commitment);
  }

  knownOnChainOrders(): string[] {
    return this.submitter.knownOnChainOrders();
  }
}
