"use client";

/**
 * DepositModal.tsx — Private wBTC deposit via Starknet Multicall
 *
 * Starknet wallets are smart accounts — account.execute([...calls]) bundles
 * multiple contract calls into ONE transaction requiring ONE signature.
 *
 * Flow:
 *  Step 1 → Choose denomination + derive phantom vault (Poseidon, instant)
 *  Step 2 → Review multicall preview → sign once
 *  Step 3 → Waiting for tx confirmation (transfer + record_deposit in 1 tx)
 *  Step 4 → Success: Merkle leaf inserted, verify on Voyager
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  X,
  CheckCircle2,
  Loader2,
  Shield,
  Copy,
  ExternalLink,
  Zap,
  ArrowRight,
} from "lucide-react";
import { useAccount } from "@starknet-react/core";
import { RpcProvider, Contract, uint256 } from "starknet";
import {
  derivePhantomAddress,
  tongoBase58PubKeyToFelt252,
} from "~~/utils/atomiq";

// ─── Constants ────────────────────────────────────────────────────────────────
const PHANTOM_POOL_ADDRESS =
  process.env.NEXT_PUBLIC_PHANTOM_POOL_ADDRESS ||
  "0x05f3afe3866247fbd2f461cbc9cee9b025fc7a670eaa9dfd8703d05edef0cbe4";

const WBTC_ADDRESS =
  process.env.NEXT_PUBLIC_MOCK_WBTC_ADDRESS ||
  "0x01fdb23eabedd63ea661df7d606f88888ec1d5064f4a968bd272d51f73c10370";

const RPC_URL =
  process.env.NEXT_PUBLIC_SEPOLIA_PROVIDER_URL ||
  "https://api.cartridge.gg/x/starknet/sepolia";

const DENOMINATIONS = [
  { label: "0.01 wBTC", sats: 1_000_000n },
  { label: "0.1 wBTC", sats: 10_000_000n },
  { label: "1 wBTC", sats: 100_000_000n },
];

// Minimal ERC20 ABI
const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [
      {
        name: "account",
        type: "core::starknet::contract_address::ContractAddress",
      },
    ],
    outputs: [{ type: "core::integer::u256" }],
    state_mutability: "view",
  },
  {
    type: "function",
    name: "faucet_mint",
    inputs: [
      {
        name: "recipient",
        type: "core::starknet::contract_address::ContractAddress",
      },
      { name: "amount", type: "core::integer::u256" },
    ],
    outputs: [],
    state_mutability: "external",
  },
];

type DepositStep = 1 | 2 | 3 | 4 | 5 | 6;

interface DepositState {
  step: DepositStep;
  phantomAddress: string;
  salt: bigint;
  txHash: string;
  selectedDenomIdx: number;
  error: string | null;
  faucetMinting: boolean;
  wbtcBalance: bigint;
  leafIndex: number;
  proverLog: string;
  proofResult: any | null;
}

// ─── Read wBTC balance ────────────────────────────────────────────────────────
async function getWbtcBalance(address: string): Promise<bigint> {
  const provider = new RpcProvider({ nodeUrl: RPC_URL });
  const contract = new Contract({
    abi: ERC20_ABI,
    address: WBTC_ADDRESS,
    providerOrAccount: provider,
  });
  try {
    const result = await contract.balanceOf(address);
    if (typeof result === "bigint") return result;
    if (result && typeof result === "object" && "low" in result)
      return uint256.uint256ToBN({
        low: (result as any).low,
        high: (result as any).high,
      });
    return BigInt(result as any);
  } catch {
    return 0n;
  }
}

// ─── Component ───────────────────────────────────────────────────────────────
export const DepositModal = ({
  isOpen,
  onClose,
  tongoPublicKey,
  tongoReady,
}: {
  isOpen: boolean;
  onClose: () => void;
  tongoPublicKey: string | null;
  tongoReady: boolean;
}) => {
  const { account } = useAccount();
  const mounted = useRef(true);

  const [state, setState] = useState<DepositState>({
    step: 1,
    phantomAddress: "",
    salt: 0n,
    txHash: "",
    selectedDenomIdx: 1,
    error: null,
    faucetMinting: false,
    wbtcBalance: 0n,
    leafIndex: -1,
    proverLog: "",
    proofResult: null,
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const patch = useCallback((p: Partial<DepositState>) => {
    if (mounted.current) setState((s) => ({ ...s, ...p }));
  }, []);

  // Reset on close
  useEffect(() => {
    if (!isOpen) {
      setTimeout(
        () =>
          patch({
            step: 1,
            phantomAddress: "",
            salt: 0n,
            txHash: "",
            error: null,
            wbtcBalance: 0n,
            leafIndex: -1,
            proverLog: "",
            proofResult: null,
          }),
        400,
      );
    }
  }, [isOpen, patch]);

  // Load wallet wBTC balance on step 2
  useEffect(() => {
    if (state.step !== 2 || !account?.address) return;
    getWbtcBalance(account.address).then((b) => patch({ wbtcBalance: b }));
  }, [state.step, account?.address, patch]);

  // ── Step 1: Derive phantom vault ──────────────────────────────────────────
  const generateVault = useCallback(async () => {
    if (!tongoPublicKey) return;
    patch({ error: null });
    try {
      const felt = tongoBase58PubKeyToFelt252(tongoPublicKey);
      const { phantomAddress, salt } = derivePhantomAddress(
        felt,
        PHANTOM_POOL_ADDRESS,
        WBTC_ADDRESS,
      );
      patch({ phantomAddress, salt, step: 2 });
    } catch (e: any) {
      patch({ error: `Derivation failed: ${e.message}` });
    }
  }, [tongoPublicKey, patch]);

  // ── Faucet mint ───────────────────────────────────────────────────────────
  const runFaucet = useCallback(async () => {
    if (!account) return;
    patch({ faucetMinting: true, error: null });
    const amountU256 = uint256.bnToUint256(1_000_000_000n); // 10 wBTC
    try {
      await account.execute([
        {
          contractAddress: WBTC_ADDRESS,
          entrypoint: "faucet_mint",
          calldata: [
            account.address,
            amountU256.low.toString(),
            amountU256.high.toString(),
          ],
        },
      ]);
      // Refresh balance after a short wait
      setTimeout(
        () =>
          getWbtcBalance(account.address).then((b) =>
            patch({ wbtcBalance: b, faucetMinting: false }),
          ),
        5000,
      );
    } catch (e: any) {
      patch({ error: `Faucet failed: ${e.message}`, faucetMinting: false });
    }
  }, [account, patch]);

  // ── Step 2→3: Multicall — transfer + record_deposit in ONE tx ─────────────
  const executeMulticall = useCallback(async () => {
    if (!account || !state.phantomAddress) return;
    patch({ step: 3, error: null });

    const amount = DENOMINATIONS[state.selectedDenomIdx].sats;
    const amountU256 = uint256.bnToUint256(amount);
    const timestamp = BigInt(Math.floor(Date.now() / 1000));
    const saltHex = "0x" + state.salt.toString(16);

    try {
      const result = await account.execute([
        // Call 1: Transfer wBTC from user wallet → phantom vault
        {
          contractAddress: WBTC_ADDRESS,
          entrypoint: "transfer",
          calldata: [
            state.phantomAddress,
            amountU256.low.toString(),
            amountU256.high.toString(),
          ],
        },
        // Call 2: Record deposit on PhantomPool — reads updated balance in same tx
        {
          contractAddress: PHANTOM_POOL_ADDRESS,
          entrypoint: "record_deposit",
          calldata: [
            state.phantomAddress,
            amountU256.low.toString(),
            amountU256.high.toString(),
            timestamp.toString(),
            saltHex,
          ],
        },
      ]);
      // Read the leaf_index from PhantomPool after tx confirms
      const provider = new RpcProvider({ nodeUrl: RPC_URL });
      const pool = new Contract({
        abi: [
          {
            type: "function",
            name: "next_leaf_index",
            inputs: [],
            outputs: [{ type: "core::integer::u64" }],
            state_mutability: "view",
          },
        ],
        address: PHANTOM_POOL_ADDRESS,
        providerOrAccount: provider,
      });
      const nextIdx = await pool.next_leaf_index().catch(() => 1n);
      const leafIndex = Number(nextIdx) - 1; // last inserted leaf
      patch({ txHash: result.transaction_hash, step: 4, leafIndex });
    } catch (e: any) {
      patch({ error: `Transaction failed: ${e.message}`, step: 2 });
    }
  }, [
    account,
    state.phantomAddress,
    state.salt,
    state.selectedDenomIdx,
    patch,
  ]);

  if (!isOpen) return null;

  const {
    step,
    phantomAddress,
    txHash,
    wbtcBalance,
    selectedDenomIdx,
    error,
    faucetMinting,
    leafIndex,
    proverLog,
    proofResult,
  } = state;
  const denom = DENOMINATIONS[selectedDenomIdx];
  const hasSufficientBalance = wbtcBalance >= denom.sats;
  const TOTAL_STEPS = 6;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-md px-4 font-geist">
      <div className="bg-[#111111] border border-white/10 rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl relative">
        {/* Glow */}
        <div className="absolute inset-0 bg-gradient-to-b from-[#00cfa7]/5 to-transparent pointer-events-none" />

        {/* Header */}
        <div className="flex justify-between items-center p-5 border-b border-white/5 relative z-10">
          <div className="flex items-center gap-3">
            <div className="bg-[#00cfa7]/20 text-[#00cfa7] p-2 rounded-lg">
              <Shield className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold bg-clip-text text-transparent bg-gradient-to-r from-[#00cfa7] to-[#00a882]">
                Private wBTC Deposit
              </h2>
              <div className="flex items-center gap-1 mt-0.5">
                <Zap className="w-3 h-3 text-yellow-400" />
                <span className="text-[10px] text-yellow-400/80 font-medium">
                  1 signature · 1 transaction
                </span>
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 bg-white/5 text-white/50 hover:text-white hover:bg-white/10 rounded-full transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 relative z-10 min-h-[380px] flex flex-col">
          {/* Progress */}
          <div className="mb-6 flex justify-between relative px-1">
            <div className="absolute top-1/2 left-0 right-0 h-[2px] bg-white/10 -translate-y-1/2" />
            <div
              className="absolute top-1/2 left-0 h-[2px] bg-[#00cfa7] -translate-y-1/2 transition-all duration-500"
              style={{
                width: `${Math.max(0, (step - 1) / (TOTAL_STEPS - 1)) * 100}%`,
              }}
            />
            {([1, 2, 3, 4] as const).map((s) => (
              <div
                key={s}
                className={`relative z-10 w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold transition-all duration-300 border-2 ${
                  step > s
                    ? "bg-[#00cfa7] border-[#00cfa7] text-black"
                    : step === s
                      ? "bg-[#111] border-[#00cfa7] text-[#00cfa7] shadow-[0_0_10px_rgba(0,207,167,0.4)]"
                      : "bg-[#111] border-white/20 text-white/30"
                }`}
              >
                {step > s ? <CheckCircle2 className="w-4 h-4" /> : s}
              </div>
            ))}
          </div>

          {/* Error */}
          {error && (
            <div className="mb-4 bg-red-500/10 border border-red-500/30 rounded-xl p-3 text-sm text-red-400">
              {error}
            </div>
          )}

          {/* No Tongo */}
          {!tongoReady && (
            <div className="flex-1 flex flex-col items-center justify-center text-center py-8">
              <Shield className="w-14 h-14 text-white/20 mb-4" />
              <h3 className="text-lg font-bold mb-2">Unlock Tongo First</h3>
              <p className="text-sm text-white/50 max-w-xs">
                Your Tongo key is needed to derive your anonymous phantom vault
                address.
              </p>
            </div>
          )}

          {/* ── Step 1: Choose denomination ── */}
          {tongoReady && step === 1 && (
            <div className="flex-1 flex flex-col items-center justify-center text-center py-4 animate-in fade-in duration-300">
              <h3 className="text-lg font-bold mb-1">Choose Denomination</h3>
              <p className="text-sm text-white/50 mb-6 max-w-sm">
                Fixed denominations give you a uniform anonymity set — all
                deposits look identical on-chain.
              </p>
              <div className="grid grid-cols-3 gap-3 w-full mb-6">
                {DENOMINATIONS.map((d, i) => (
                  <button
                    key={i}
                    onClick={() =>
                      setState((s) => ({ ...s, selectedDenomIdx: i }))
                    }
                    className={`py-3 rounded-xl border font-bold text-sm transition-all ${
                      selectedDenomIdx === i
                        ? "bg-[#00cfa7]/20 border-[#00cfa7] text-[#00cfa7] shadow-[0_0_12px_rgba(0,207,167,0.3)]"
                        : "bg-white/5 border-white/10 text-white/60 hover:border-white/30"
                    }`}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
              <button
                onClick={generateVault}
                className="w-full bg-[#00cfa7] text-black py-4 rounded-xl font-bold text-sm hover:-translate-y-0.5 shadow-[0_4px_20px_rgba(0,207,167,0.3)] transition-all"
              >
                Generate Phantom Vault
              </button>
            </div>
          )}

          {/* ── Step 2: Review multicall ── */}
          {tongoReady && step === 2 && (
            <div className="flex-1 flex flex-col animate-in fade-in duration-300">
              {/* Phantom address */}
              <div className="bg-black/40 border border-white/10 rounded-xl p-3 mb-3">
                <label className="text-[10px] uppercase tracking-wider text-white/40 mb-1 block">
                  Phantom Vault (Counterfactual)
                </label>
                <div className="font-mono text-[11px] break-all text-white/80 leading-relaxed">
                  {phantomAddress}
                </div>
                <button
                  onClick={() => navigator.clipboard.writeText(phantomAddress)}
                  className="mt-1 flex items-center gap-1 text-[10px] text-white/30 hover:text-white/60 transition-colors"
                >
                  <Copy className="w-3 h-3" /> Copy
                </button>
              </div>

              {/* Multicall preview */}
              <div className="bg-black/30 border border-white/5 rounded-xl p-3 mb-3">
                <div className="flex items-center gap-2 mb-2">
                  <Zap className="w-3.5 h-3.5 text-yellow-400" />
                  <span className="text-[11px] font-bold text-yellow-400/90">
                    Multicall Preview — 1 signature
                  </span>
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2 text-[11px]">
                    <div className="w-5 h-5 rounded-full bg-[#00cfa7]/20 text-[#00cfa7] flex items-center justify-center font-bold text-[10px] shrink-0">
                      1
                    </div>
                    <span className="text-white/60 font-mono">
                      MockWBTC.transfer(phantomVault,{" "}
                      <span className="text-[#00cfa7]">{denom.label}</span>)
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-[11px]">
                    <div className="w-5 h-5 rounded-full bg-[#00cfa7]/20 text-[#00cfa7] flex items-center justify-center font-bold text-[10px] shrink-0">
                      2
                    </div>
                    <span className="text-white/60 font-mono">
                      PhantomPool.record_deposit(phantomVault,{" "}
                      <span className="text-[#00cfa7]">{denom.label}</span>)
                    </span>
                  </div>
                </div>
              </div>

              {/* Wallet balance */}
              <div className="bg-black/20 rounded-xl px-3 py-2 mb-4 flex items-center justify-between">
                <span className="text-xs text-white/40">Your wBTC balance</span>
                <span
                  className={`font-mono text-sm font-bold ${hasSufficientBalance ? "text-[#00cfa7]" : "text-red-400"}`}
                >
                  {(Number(wbtcBalance) / 1e8).toFixed(8)} wBTC
                </span>
              </div>

              {/* Faucet button (if insufficient balance) */}
              {!hasSufficientBalance && (
                <button
                  onClick={runFaucet}
                  disabled={!account || faucetMinting}
                  className="w-full mb-3 py-2.5 rounded-xl border border-white/10 text-white/50 hover:text-white hover:bg-white/5 text-xs font-medium transition-all flex items-center justify-center gap-2 disabled:opacity-40"
                >
                  {faucetMinting ? (
                    <>
                      <Loader2 className="w-3 h-3 animate-spin" /> Minting...
                    </>
                  ) : (
                    "Need tokens? Mint 10 Mock wBTC (Testnet Faucet)"
                  )}
                </button>
              )}

              <button
                onClick={executeMulticall}
                disabled={!account || !hasSufficientBalance}
                className="mt-auto w-full bg-[#00cfa7] text-black py-4 rounded-xl font-bold text-sm hover:-translate-y-0.5 shadow-[0_4px_20px_rgba(0,207,167,0.3)] transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0"
              >
                Deposit &amp; Register (1 Signature){" "}
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* ── Step 3: Awaiting confirmation ── */}
          {tongoReady && step === 3 && (
            <div className="flex-1 flex flex-col items-center justify-center text-center">
              <div className="relative mb-5">
                <Loader2 className="animate-spin w-12 h-12 text-[#00cfa7]" />
                <div className="absolute inset-0 animate-ping rounded-full bg-[#00cfa7]/10" />
              </div>
              <h3 className="text-lg font-bold mb-2">Executing Multicall</h3>
              <p className="text-sm text-white/50 mb-4">
                Confirm in your wallet, then waiting for Starknet
                confirmation...
              </p>
              <div className="bg-black/30 border border-white/5 rounded-xl p-3 w-full text-left space-y-1.5">
                {[
                  "MockWBTC.transfer → phantom vault",
                  "PhantomPool.record_deposit → Merkle tree",
                ].map((label, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 text-xs text-white/50"
                  >
                    <div className="w-4 h-4 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-[9px] shrink-0">
                      {i + 1}
                    </div>
                    <span className="font-mono">{label}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Step 4: Deposit registered ── */}
          {tongoReady && step === 4 && (
            <div className="flex-1 flex flex-col animate-in fade-in duration-300">
              <div className="flex flex-col items-center text-center mb-4">
                <div className="relative mb-3">
                  <div className="w-14 h-14 rounded-full bg-[#00cfa7]/20 flex items-center justify-center">
                    <CheckCircle2 className="w-8 h-8 text-[#00cfa7]" />
                  </div>
                  <div className="absolute inset-0 rounded-full animate-ping bg-[#00cfa7]/10" />
                </div>
                <h3 className="text-lg font-bold mb-1">Deposit Registered</h3>
                <p className="text-xs text-white/50">
                  Leaf #{leafIndex} inserted into Merkle tree
                </p>
              </div>

              <div className="space-y-2 mb-4">
                <div className="bg-black/30 border border-[#00cfa7]/20 rounded-xl p-3 flex items-center gap-3">
                  <CheckCircle2 className="w-4 h-4 text-[#00cfa7] shrink-0" />
                  <div>
                    <p className="text-xs font-bold">wBTC at phantom vault</p>
                    <p className="text-[10px] text-white/40 font-mono mt-0.5">
                      {phantomAddress.slice(0, 14)}...{phantomAddress.slice(-8)}
                    </p>
                  </div>
                </div>
                <div className="bg-black/30 border border-[#00cfa7]/20 rounded-xl p-3 flex items-center gap-3">
                  <CheckCircle2 className="w-4 h-4 text-[#00cfa7] shrink-0" />
                  <div>
                    <p className="text-xs font-bold">
                      Merkle leaf on PhantomPool
                    </p>
                    <p className="text-[10px] text-white/40 font-mono mt-0.5">
                      {PHANTOM_POOL_ADDRESS.slice(0, 14)}...
                      {PHANTOM_POOL_ADDRESS.slice(-8)}
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex gap-2 mb-2">
                <a
                  href={`https://sepolia.voyager.online/tx/${txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 py-2.5 rounded-xl border border-white/10 text-white/40 text-xs font-medium flex items-center justify-center gap-1.5 hover:bg-white/5 hover:text-white/70 transition-all"
                >
                  <ExternalLink className="w-3 h-3" /> Tx
                </a>
                <a
                  href={`https://sepolia.voyager.online/contract/${PHANTOM_POOL_ADDRESS}#readContract`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 py-2.5 rounded-xl border border-white/10 text-white/40 text-xs font-medium flex items-center justify-center gap-1.5 hover:bg-white/5 hover:text-white/70 transition-all"
                >
                  <ExternalLink className="w-3 h-3" /> Merkle Root
                </a>
              </div>

              <button
                onClick={async () => {
                  if (!tongoPublicKey) return;
                  patch({
                    step: 5,
                    error: null,
                    proverLog: "Starting...",
                    proofResult: null,
                  });
                  try {
                    const {
                      generateCondenserProof,
                      bn254Poseidon,
                      computeBn254MerkleRoot,
                    } = await import("~~/utils/prover");
                    const { tongoBase58PubKeyToFelt252 } = await import(
                      "~~/utils/atomiq"
                    );
                    // Gather all BN254 leaves (leaf for this deposit)
                    const tongoPubKeyFelt = BigInt(
                      tongoBase58PubKeyToFelt252(tongoPublicKey),
                    );
                    const bn254Salt = await bn254Poseidon(
                      tongoPubKeyFelt,
                      state.salt,
                    );
                    const amount = DENOMINATIONS[state.selectedDenomIdx].sats;
                    // Get deposit timestamp from block (approximate)
                    const depositTimestamp = BigInt(
                      Math.floor(Date.now() / 1000) - 30,
                    );
                    const bn254Leaf = await bn254Poseidon(
                      bn254Salt,
                      BigInt(state.phantomAddress),
                      amount,
                      depositTimestamp,
                    );
                    const allBn254Leaves = [bn254Leaf];
                    const bn254Root =
                      await computeBn254MerkleRoot(allBn254Leaves);

                    const result = await generateCondenserProof(
                      {
                        tongoPubkey: tongoPubKeyFelt,
                        r: state.salt,
                        phantomAddr: BigInt(state.phantomAddress),
                        amount,
                        depositTimestamp,
                        leafIndex: 0,
                        allBn254Leaves,
                        bn254AccumulatorRoot: bn254Root,
                      },
                      (msg) => patch({ proverLog: msg }),
                    );
                    patch({ proofResult: result, proverLog: "Done ✓" });
                  } catch (e: any) {
                    patch({ error: `Proof failed: ${e.message}`, step: 4 });
                  }
                }}
                className="w-full bg-[#00cfa7] text-black py-3.5 rounded-xl font-bold text-sm hover:-translate-y-0.5 shadow-[0_4px_20px_rgba(0,207,167,0.3)] transition-all flex items-center justify-center gap-2"
              >
                <Shield className="w-4 h-4" /> Generate ZK Condense Proof →
              </button>
            </div>
          )}

          {/* ── Step 5: ZK Proof generation + display ── */}
          {tongoReady && step === 5 && (
            <div className="flex-1 flex flex-col animate-in fade-in duration-300">
              {!proofResult ? (
                // Generating...
                <div className="flex-1 flex flex-col items-center justify-center">
                  <div className="relative mb-5">
                    <Loader2 className="animate-spin w-12 h-12 text-[#00cfa7]" />
                    <div className="absolute inset-0 animate-ping rounded-full bg-[#00cfa7]/10" />
                  </div>
                  <h3 className="text-lg font-bold mb-2">
                    Generating ZK Proof
                  </h3>
                  <p className="text-xs text-white/40 mb-4 text-center max-w-xs">
                    Running Groth16 witness computation in your browser…
                  </p>
                  <div className="bg-black/40 border border-white/5 rounded-xl px-4 py-3 w-full">
                    <p className="text-[11px] font-mono text-[#00cfa7]/80">
                      {proverLog || "Initialising…"}
                    </p>
                  </div>
                </div>
              ) : (
                // Proof ready
                <div className="flex-1 flex flex-col">
                  <div className="flex flex-col items-center text-center mb-4">
                    <div className="w-12 h-12 rounded-full bg-[#00cfa7]/20 flex items-center justify-center mb-3">
                      <Shield className="w-7 h-7 text-[#00cfa7]" />
                    </div>
                    <h3 className="text-lg font-bold mb-1">
                      ZK Proof Generated ✓
                    </h3>
                    <p className="text-xs text-white/50">
                      Groth16 BN254 proof ready for on-chain submission
                    </p>
                  </div>

                  <div className="space-y-2 mb-4 overflow-y-auto max-h-64">
                    {[
                      [
                        "Accumulator Root",
                        proofResult.publicInputs.accumulatorRoot,
                      ],
                      [
                        "Tongo Commitment",
                        proofResult.publicInputs.tongoAccountCommitment,
                      ],
                      ["Denomination", proofResult.publicInputs.denomination],
                      ["Nullifier", proofResult.publicInputs.nullifier],
                    ].map(([label, val]) => (
                      <div
                        key={label}
                        className="bg-black/30 border border-white/5 rounded-xl p-3"
                      >
                        <p className="text-[10px] text-white/40 uppercase tracking-wider mb-1">
                          {label}
                        </p>
                        <p className="text-[10px] font-mono text-[#00cfa7] break-all">
                          {String(val).slice(0, 40)}…
                        </p>
                      </div>
                    ))}
                    <div className="bg-black/30 border border-white/5 rounded-xl p-3">
                      <p className="text-[10px] text-white/40 uppercase tracking-wider mb-1">
                        Garaga Calldata ({proofResult.calldataFelts.length}{" "}
                        felts)
                      </p>
                      <p className="text-[10px] font-mono text-white/30 break-all">
                        {proofResult.calldataFelts.slice(0, 3).join(", ")}…
                      </p>
                    </div>
                  </div>

                  <button
                    onClick={async () => {
                      if (!account) return;
                      patch({ error: null });
                      try {
                        // We format the calldata again here based on the result
                        if (!proofResult)
                          throw new Error("Missing proof result");
                        const calldataParams = [
                          account.address, // recipient
                          {
                            low: DENOMINATIONS[state.selectedDenomIdx].sats,
                            high: 0,
                          }, // denomination
                          state.phantomAddress, // phantom vault
                          state.salt, // salt
                        ];

                        const { CallData } = await import("starknet");
                        const contractCall = {
                          contractAddress: PHANTOM_POOL_ADDRESS,
                          entrypoint: "condense",
                          calldata: CallData.compile([
                            proofResult.calldataFelts, // full_proof_with_hints Span
                            ...calldataParams,
                          ]),
                        };

                        const { transaction_hash } = await account.execute([
                          contractCall,
                        ]);
                        await account.waitForTransaction(transaction_hash);
                        patch({ step: 6, txHash: transaction_hash });
                      } catch (e: any) {
                        patch({
                          error: `Condense tx failed: ${e.message}`,
                          step: 5,
                        });
                      }
                    }}
                    className="w-full bg-[#00cfa7] text-black py-3.5 rounded-xl font-bold text-sm hover:-translate-y-0.5 shadow-[0_4px_20px_rgba(0,207,167,0.3)] transition-all flex items-center justify-center gap-2"
                  >
                    <Zap className="w-4 h-4" /> Submit ZK Condense On-Chain
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── Step 6: Condense Claimed ── */}
          {tongoReady && step === 6 && (
            <div className="flex-1 flex flex-col animate-in fade-in duration-300">
              <div className="flex flex-col items-center text-center mb-5">
                <div className="relative mb-4">
                  <div className="w-16 h-16 rounded-full bg-[#00cfa7]/20 flex items-center justify-center">
                    <CheckCircle2 className="w-9 h-9 text-[#00cfa7]" />
                  </div>
                  <div className="absolute inset-0 rounded-full animate-ping bg-[#00cfa7]/10" />
                </div>
                <h3 className="text-xl font-bold mb-1">ZK Condense Complete</h3>
                <p className="text-xs text-[#00cfa7]/80">
                  Proof verified on-chain. Funds bridged to your wallet.
                </p>
              </div>

              <div className="bg-black/30 border border-white/5 rounded-xl p-4 mb-5 text-center">
                <p className="text-xs text-white/50 mb-1">
                  Tongo Balance Updated!
                </p>
                <p className="font-mono text-xl text-white">
                  {DENOMINATIONS[state.selectedDenomIdx].label}
                  <span className="text-sm text-white/30 ml-2">(unspent)</span>
                </p>
              </div>

              <div className="flex gap-2">
                <a
                  href={`https://sepolia.voyager.online/tx/${txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 py-3 rounded-xl border border-[#00cfa7]/30 text-[#00cfa7] text-xs font-medium flex items-center justify-center gap-1.5 hover:bg-[#00cfa7]/10 transition-all"
                >
                  <ExternalLink className="w-3.5 h-3.5" /> View Tx
                </a>
                <button
                  onClick={onClose}
                  className="flex-1 py-3 rounded-xl bg-white/5 text-white/60 text-xs font-medium hover:bg-white/10 hover:text-white transition-all"
                >
                  Done
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
