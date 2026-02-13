// ─────────────────────────────────────────────────────────────────────────────
// Phantom Pool Relayer — Starknet Submitter
// ─────────────────────────────────────────────────────────────────────────────
// Handles two jobs:
//   A) Polling Starknet for OrderSubmitted events so the relayer knows which
//      commitments are live on-chain (useful for validation / UI display).
//   B) Submitting MatchCorrectnessProof to PhantomPool.submit_match().

import {
  Account,
  CallData,
  Contract,
  RpcProvider,
  hash as starkHash,
  type ContractOptions,
} from "starknet";
import { config } from "./config.js";
import type { MatchResult } from "./types.js";

// ─── PhantomPool ABI (minimal — only what the relayer calls) ──────────────────
const PHANTOM_POOL_ABI = [
  {
    type: "function",
    name: "submit_match",
    inputs: [
      {
        name: "full_proof_with_hints",
        type: "core::array::Span::<core::felt252>",
      },
    ],
    outputs: [],
    state_mutability: "external",
  },
  {
    type: "function",
    name: "order_status",
    inputs: [{ name: "commitment", type: "core::felt252" }],
    outputs: [{ type: "core::integer::u8" }],
    state_mutability: "view",
  },
  {
    type: "function",
    name: "match_pair",
    inputs: [{ name: "match_id", type: "core::integer::u64" }],
    outputs: [
      {
        type: "tuple",
        // MatchedPair struct fields
        items: [
          { name: "buy_commitment", type: "core::felt252" },
          { name: "sell_commitment", type: "core::felt252" },
          { name: "settlement_commitment", type: "core::felt252" },
          { name: "settled", type: "core::bool" },
        ],
      },
    ],
    state_mutability: "view",
  },
  // Events
  {
    type: "event",
    name: "contracts::phantom_pool::PhantomPool::OrderSubmitted",
    kind: "struct",
    members: [
      { name: "commitment", type: "core::felt252", kind: "key" },
      { name: "trader", type: "core::starknet::contract_address::ContractAddress", kind: "data" },
      { name: "trader_pubkey", type: "core::felt252", kind: "data" },
      { name: "order_id", type: "core::integer::u64", kind: "data" },
    ],
  },
  {
    type: "event",
    name: "contracts::phantom_pool::PhantomPool::MatchSubmitted",
    kind: "struct",
    members: [
      { name: "match_id", type: "core::integer::u64", kind: "key" },
      { name: "buy_commitment", type: "core::felt252", kind: "data" },
      { name: "sell_commitment", type: "core::felt252", kind: "data" },
      { name: "settlement_commitment", type: "core::felt252", kind: "data" },
    ],
  },
  {
    type: "event",
    name: "contracts::phantom_pool::PhantomPool::Event",
    kind: "enum",
    variants: [
      {
        name: "OrderSubmitted",
        type: "contracts::phantom_pool::PhantomPool::OrderSubmitted",
        kind: "nested",
      },
      {
        name: "MatchSubmitted",
        type: "contracts::phantom_pool::PhantomPool::MatchSubmitted",
        kind: "nested",
      },
    ],
  },
] as const;

// ─── Submitter class ──────────────────────────────────────────────────────────
export class Submitter {
  private readonly provider: RpcProvider;
  private readonly account: Account;
  private readonly pool: Contract;

  /** Block from which we last scanned events (incremented after each poll) */
  private lastScannedBlock: number;

  /** Commitments seen on-chain via events (commitment hex → on-chain order_id) */
  private readonly onChainOrders = new Map<string, bigint>();

  constructor() {
    this.provider = new RpcProvider({ nodeUrl: config.rpcUrl });

    // starknet.js v8 — Account takes a single options object
    this.account = new Account({
      provider: this.provider,
      address: config.relayerAddress,
      signer: config.relayerPrivateKey,
    });

    // starknet.js v8+ / v9: Contract takes a single options object
    this.pool = new Contract({
      abi: PHANTOM_POOL_ABI as unknown as ContractOptions["abi"],
      address: config.phantomPoolAddress,
      providerOrAccount: this.provider,
    });

    this.lastScannedBlock = config.fromBlock;
  }

  // ── A) Poll for OrderSubmitted events ──────────────────────────────────────
  /**
   * Fetches OrderSubmitted events from PhantomPool since lastScannedBlock.
   * Returns the list of new commitments seen on-chain.
   */
  async pollOrderEvents(): Promise<string[]> {
    if (
      !config.phantomPoolAddress ||
      config.phantomPoolAddress === "0x0"
    ) {
      // Contract not yet deployed — nothing to poll
      return [];
    }

    try {
      const block = await this.provider.getBlockLatestAccepted();
      const latestBlock = block.block_number;

      if (latestBlock <= this.lastScannedBlock) return [];

      const fromBlock = this.lastScannedBlock;
      const toBlock = latestBlock;

      // starknet.js getEvents: filter by contract address + event name key
      const orderSubmittedKey = starkHash.getSelectorFromName("OrderSubmitted");
      const eventsPage = await this.provider.getEvents({
        from_block: { block_number: fromBlock },
        to_block: { block_number: toBlock },
        address: config.phantomPoolAddress,
        keys: [[orderSubmittedKey]],
        chunk_size: 100,
      });

      const newCommitments: string[] = [];
      for (const event of eventsPage.events) {
        // First key after the event selector is `commitment` (#[key] field)
        const commitment = event.keys[1] as string;
        if (commitment && !this.onChainOrders.has(commitment)) {
          // data[0] = trader, data[1] = trader_pubkey, data[2] = order_id
          const orderId = event.data[2] ? BigInt(event.data[2]) : 0n;
          this.onChainOrders.set(commitment, orderId);
          newCommitments.push(commitment);
          console.log(
            `[submitter] 🔔 On-chain order seen: ${commitment.slice(0, 12)}… order_id=${orderId}`
          );
        }
      }

      this.lastScannedBlock = toBlock;
      return newCommitments;
    } catch (err) {
      console.error(`[submitter] Event polling error:`, err);
      return [];
    }
  }

  /** Returns true if the commitment has been seen on-chain */
  isOnChain(commitment: string): boolean {
    return this.onChainOrders.has(commitment);
  }

  /** Returns all on-chain commitments seen so far */
  knownOnChainOrders(): string[] {
    return [...this.onChainOrders.keys()];
  }

  // ── B) Submit match proof ───────────────────────────────────────────────────
  /**
   * Calls PhantomPool.submit_match(full_proof_with_hints).
   * Returns the transaction hash.
   */
  async submitMatch(match: MatchResult): Promise<string> {
    if (
      !config.phantomPoolAddress ||
      config.phantomPoolAddress === "0x0"
    ) {
      throw new Error(
        "PHANTOM_POOL_ADDRESS not configured — cannot submit match"
      );
    }

    if (!match.proofCalldata || match.proofCalldata.length === 0) {
      throw new Error(`No proof calldata available for match ${match.matchId}`);
    }

    console.log(
      `[submitter] Submitting match ${match.matchId} (${match.proofCalldata.length} calldata elements)…`
    );

    // Encode the Span<felt252> calldata
    const spanCalldata = CallData.compile({
      full_proof_with_hints: match.proofCalldata,
    });

    // starknet v8: execute takes AllowArray<Call>
    const { transaction_hash } = await this.account.execute({
      contractAddress: config.phantomPoolAddress,
      entrypoint: "submit_match",
      calldata: spanCalldata,
    });

    console.log(`[submitter] submit_match tx sent: ${transaction_hash}`);

    // Wait for inclusion (2-arg form: txHash + options)
    await this.provider.waitForTransaction(transaction_hash, {
      retryInterval: 1500,
    });

    console.log(`[submitter] ✅ Match confirmed on-chain: ${transaction_hash}`);
    return transaction_hash;
  }

  // ── C) Submit Tongo settlement proof ─────────────────────────────────────────
  /**
   * Calls PhantomPool.submit_settlement(match_id, seller_calldata, buyer_calldata).
   * Atomically executes the Tongo encrypted transfers.
   */
  async submitSettlement(match: MatchResult): Promise<string> {
    if (!config.phantomPoolAddress || config.phantomPoolAddress === "0x0") {
      throw new Error("PHANTOM_POOL_ADDRESS not configured — cannot submit settlement");
    }

    if (match.onChainMatchId === undefined) {
      throw new Error(`Match ${match.matchId} has no onChainMatchId`);
    }

    if (!match.buyerTransferCalldata || !match.sellerTransferCalldata) {
      throw new Error(`Match ${match.matchId} is missing buyer or seller Tongo payloads`);
    }

    console.log(`[submitter] Submitting settlement for match ${match.matchId} (ID: ${match.onChainMatchId})…`);

    // Prepare the CallData for submit_settlement 
    // Types from Cairo: match_id: u64, seller_calldata: Span<felt252>, buyer_calldata: Span<felt252>
    const spanCalldata = CallData.compile({
      match_id: match.onChainMatchId,
      seller_transfer_calldata: match.sellerTransferCalldata,
      buyer_transfer_calldata: match.buyerTransferCalldata,
    });

    try {
      const { transaction_hash } = await this.account.execute({
        contractAddress: config.phantomPoolAddress,
        entrypoint: "submit_settlement",
        calldata: spanCalldata,
      });

      console.log(`[submitter] submit_settlement tx sent: ${transaction_hash}`);

      await this.provider.waitForTransaction(transaction_hash, {
        retryInterval: 1500,
      });

      console.log(`[submitter] ✅ Settlement confirmed on-chain: ${transaction_hash}`);
      return transaction_hash;
    } catch (error) {
      console.error(`[submitter] Failed to submit settlement:`, error);
      throw error;
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  /** Query on-chain order status (0=Inactive,1=Active,2=Matched,3=Settled,4=Cancelled) */
  async getOrderStatus(commitment: string): Promise<number> {
    try {
      const status = await this.pool.order_status(commitment);
      return Number(status);
    } catch {
      return 0;
    }
  }

  /** Retrieve the on-chain MatchedPair record by match_id */
  async getMatchPair(matchId: number): Promise<{
    buyCommitment: string;
    sellCommitment: string;
    settlementCommitment: string;
    settled: boolean;
  } | null> {
    try {
      const pair = await this.pool.match_pair(matchId);
      return {
        buyCommitment: pair.buy_commitment as string,
        sellCommitment: pair.sell_commitment as string,
        settlementCommitment: pair.settlement_commitment as string,
        settled: pair.settled as boolean,
      };
    } catch {
      return null;
    }
  }
}
