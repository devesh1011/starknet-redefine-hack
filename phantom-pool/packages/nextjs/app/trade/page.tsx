"use client";

import { useState, useEffect, useCallback } from "react";
import { useAccount, useNetwork } from "@starknet-react/core";
import { initializeTongoSdk, getTongoBalance } from "~~/utils/tongo/client";
import { Address } from "~~/components/scaffold-stark";
import { formatUnits } from "viem";
import { DepositModal } from "~~/components/DepositModal";

export default function TradePage() {
  const { account, status, address } = useAccount();
  const { chain } = useNetwork();

  const [isTongoReady, setIsTongoReady] = useState(false);
  const [keyPair, setKeyPair] = useState<any>(null);
  const [wbtcBalance, setWbtcBalance] = useState<bigint>(0n);
  const [usdcBalance, setUsdcBalance] = useState<bigint>(0n);
  const [isLoadingSecret, setIsLoadingSecret] = useState(false);

  // Form state
  const [direction, setDirection] = useState<"buy" | "sell">("buy");
  const [price, setPrice] = useState("");
  const [amount, setAmount] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDepositOpen, setIsDepositOpen] = useState(false);

  // Close deposit modal and refresh on-chain balances
  const handleDepositClose = () => {
    setIsDepositOpen(false);
    setTimeout(() => {
      if (address) fetchOnChainBalances(address);
    }, 2000);
  };

  // Real on-chain balances (MockWBTC in wallet + phantom deposits)
  const [walletWbtcBalance, setWalletWbtcBalance] = useState<bigint>(0n);
  const [phantomDepositCount, setPhantomDepositCount] = useState<number>(0);

  // Initialize Tongo SDK automatically when wallet connects
  useEffect(() => {
    if (status === "connected" && !isTongoReady) {
      initTongo();
    }
  }, [status, isTongoReady]);

  // Fetch on-chain balances whenever address is available
  useEffect(() => {
    if (address) fetchOnChainBalances(address);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  const MOCK_WBTC =
    process.env.NEXT_PUBLIC_MOCK_WBTC_ADDRESS ||
    "0x01fdb23eabedd63ea661df7d606f88888ec1d5064f4a968bd272d51f73c10370";
  const PHANTOM_POOL =
    process.env.NEXT_PUBLIC_PHANTOM_POOL_ADDRESS ||
    "0x05f3afe3866247fbd2f461cbc9cee9b025fc7a670eaa9dfd8703d05edef0cbe4";
  const RPC_URL =
    process.env.NEXT_PUBLIC_SEPOLIA_PROVIDER_URL ||
    "https://api.cartridge.gg/x/starknet/sepolia";

  const fetchOnChainBalances = async (userAddr: string) => {
    try {
      const { RpcProvider: RP, Contract: C } = await import("starknet");
      const provider = new RP({ nodeUrl: RPC_URL });

      // 1. Read wallet MockWBTC balance
      const erc20 = new C({
        abi: [
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
        ],
        address: MOCK_WBTC,
        providerOrAccount: provider,
      });
      const balRaw = await erc20.balanceOf(userAddr).catch(() => 0n);
      setWalletWbtcBalance(typeof balRaw === "bigint" ? balRaw : 0n);

      // 2. Read next_leaf_index from PhantomPool (= number of recorded deposits)
      const pool = new C({
        abi: [
          {
            type: "function",
            name: "next_leaf_index",
            inputs: [],
            outputs: [{ type: "core::integer::u64" }],
            state_mutability: "view",
          },
        ],
        address: PHANTOM_POOL,
        providerOrAccount: provider,
      });
      const leafIdx = await pool.next_leaf_index().catch(() => 0n);
      setPhantomDepositCount(Number(leafIdx));
    } catch (e) {
      console.warn("fetchOnChainBalances error:", e);
    }
  };

  const initTongo = async () => {
    setIsLoadingSecret(true);
    try {
      const { keyPair } = await initializeTongoSdk();
      setIsTongoReady(true);
      setKeyPair(keyPair);

      // Fetch initial balances
      refreshBalances();
    } catch (e) {
      console.error("Failed to initialize Tongo", e);
    }
    setIsLoadingSecret(false);
  };

  const refreshBalances = async () => {
    try {
      const wbtc = await getTongoBalance("wBTC");
      const usdc = await getTongoBalance("USDC");
      setWbtcBalance(wbtc);
      setUsdcBalance(usdc);
    } catch (e) {
      console.error("Failed to fetch balances", e);
    }
  };

  const handlePlaceOrder = async () => {
    if (!isTongoReady || !price || !amount || !address) return;

    setIsSubmitting(true);
    try {
      // 1. Convert decimals to atoms
      // Simplified: Just use raw ints for hackathon. e.g. price=65000, amount=1 => BigInts
      // In production, decimals need to be precise
      const priceInt = BigInt(Math.floor(parseFloat(price)));

      // Amount in sats (assuming 8 decimals for WBTC)
      // Since amount is WBTC, let's treat it as is but scaled by 10^8
      const isWbtc = true;
      const decimals = isWbtc ? 8 : 6;
      const scale = 10 ** decimals;
      const amountInt = BigInt(Math.floor(parseFloat(amount) * scale));

      const dirNum = direction === "buy" ? 0 : 1;

      // 2. Compute Nonce
      // We need a random nonce to ensure commitments are unique
      // For now we just use Date.now() as a simple proxy for entropy
      // Noir expects a Field, so a random big integer works.
      const nonceInt = BigInt(Date.now());

      // 3. Poseidon ZK Commitment
      // We must match exactly what `computeCommitment` does inside the relayer
      const { generateOrderValidityProof } = await import("~~/utils/prover");
      const { buildPoseidon } = await import("circomlibjs");

      const poseidon = await buildPoseidon();
      const hashInput = [BigInt(dirNum), priceInt, amountInt, nonceInt];
      const commitmentRaw = poseidon(hashInput);
      const commitment =
        "0x" + poseidon.F.toString(commitmentRaw, 16).padStart(64, "0");

      // 4. Client-side Proof Generation
      // Tongo keyPair generates our public/private mapping
      console.log("Generating ZK Proof in Browser...");

      const inputs = {
        price: priceInt.toString(),
        amount: amountInt.toString(),
        nonce: nonceInt.toString(),
        direction: dirNum,
        tongo_balance:
          direction === "sell"
            ? wbtcBalance.toString()
            : usdcBalance.toString(),
        user_secret: BigInt(keyPair.secretKey).toString(),
      };

      // WARNING: In real production, this takes a few seconds and should be off-main-thread (web workers).
      const { proof, publicSignals } = await generateOrderValidityProof(inputs);
      console.log("ZK Proof Generated!", { proof, publicSignals });

      // 5. Submit to Relayer
      // Note: We don't send `proof` to Relayer, we send it to Starknet via Relayer OR
      // we just send order data offchain to the relayer and let the user send `submit_order` themselves.
      // For this hackathon scope, Relayer just takes the order data and the user submits the onchain tx directly!

      const { submitOrderToRelay } = await import("~~/utils/api/relayer");

      await submitOrderToRelay({
        commitment,
        direction: dirNum,
        price: priceInt.toString(),
        amount: amountInt.toString(),
        nonce: nonceInt.toString(),
        traderAddress: address as string,
        tongoPublicKey: keyPair.publicKey.toString(),
      });

      alert(
        `Order securely placed! Sealed commitment: ${commitment.slice(0, 10)}...`,
      );
      setPrice("");
      setAmount("");
    } catch (e) {
      console.error("Order placement failed", e);
      alert("Failed to place order. See console for details.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col h-screen pt-24 pb-4 px-4 bg-[#0a0a0a] text-white font-geist">
      <DepositModal
        isOpen={isDepositOpen}
        onClose={handleDepositClose}
        tongoPublicKey={keyPair?.publicKey?.toString() || null}
        tongoReady={isTongoReady}
      />
      {!address ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="bg-black/50 border border-white/10 p-8 rounded-3xl text-center max-w-md w-full shadow-2xl backdrop-blur-md">
            <div className="text-5xl mb-6">🦇</div>
            <h2 className="text-2xl font-bold mb-4">Welcome to Phantom Pool</h2>
            <p className="opacity-70 mb-6">
              Please connect your Starknet wallet to access the decentralized
              dark pool.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 gap-2 overflow-hidden">
          {/* LEFT COLUMN: Chart + Bottom Panel */}
          <div className="flex flex-col flex-1 gap-2 min-w-0">
            {/* Chart Area */}
            <div className="flex-1 bg-[#111111] border border-white/5 rounded-lg p-4 flex flex-col relative overflow-hidden">
              <div className="flex items-center gap-6 mb-4 pb-4 border-b border-white/5">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-full bg-orange-500/20 flex items-center justify-center text-orange-500 font-bold text-xs">
                    ₿
                  </div>
                  <h2 className="text-xl font-bold">
                    wBTC<span className="text-white/30 text-lg">/USDC</span>
                  </h2>
                </div>
                <div className="text-sm">
                  <span className="text-white/50 block text-xs mb-1">
                    Price
                  </span>
                  <div className="text-[#ff4e4e] font-mono font-medium text-base">
                    65,420.00
                  </div>
                </div>
                <div className="text-sm">
                  <span className="text-white/50 block text-xs mb-1">
                    24h Change
                  </span>
                  <div className="text-[#00cfa7] font-mono font-medium text-base">
                    +0.55%
                  </div>
                </div>
                <div className="text-sm">
                  <span className="text-white/50 block text-xs mb-1">
                    24h Volume
                  </span>
                  <div className="text-white font-mono text-base">
                    52,292,078 USDC
                  </div>
                </div>
              </div>
              <div className="flex-1 flex items-center justify-center border border-white/5 rounded relative group">
                <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[size:20px_20px]"></div>
                <span className="opacity-30 z-10 flex flex-col items-center gap-2">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={1.5}
                    stroke="currentColor"
                    className="w-8 h-8"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z"
                    />
                  </svg>
                  Trading View Chart Placeholder
                </span>
              </div>
            </div>

            {/* Bottom Panel (Balances / Positions) */}
            <div className="h-64 bg-[#111111] border border-white/5 rounded-lg p-4 flex flex-col">
              <div className="flex gap-6 border-b border-white/5 pb-2 mb-4 text-sm font-medium">
                <button className="text-white border-b-2 border-[#00cfa7] pb-2 -mb-[9px]">
                  Balances
                </button>
                <button className="text-white/50 hover:text-white transition-colors pb-2">
                  Positions
                </button>
                <button className="text-white/50 hover:text-white transition-colors pb-2">
                  Open Orders (0)
                </button>
                <button className="text-white/50 hover:text-white transition-colors pb-2">
                  Trade History
                </button>
              </div>

              <div className="flex-1 overflow-y-auto">
                {isLoadingSecret ? (
                  <div className="animate-pulse flex gap-4">
                    <div className="h-12 bg-white/5 rounded w-full"></div>
                  </div>
                ) : !isTongoReady ? (
                  <div className="flex items-center justify-center h-full">
                    <button
                      className="bg-white text-black hover:bg-gray-200 px-6 py-2 rounded-lg font-medium transition-colors"
                      onClick={initTongo}
                    >
                      Unlock Tongo Account to Load Balances
                    </button>
                  </div>
                ) : (
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="text-white/40 border-b border-white/5 uppercase text-xs tracking-wider">
                        <th className="pb-3 font-medium">Asset</th>
                        <th className="pb-3 font-medium text-right">Wallet</th>
                        <th className="pb-3 font-medium text-right">
                          Phantom Pool 🔒
                        </th>
                        <th className="pb-3 font-medium text-right">
                          Trading (Tongo)
                        </th>
                        <th className="pb-3 font-medium text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-b border-white/5 hover:bg-white/[0.02]">
                        <td className="py-3 flex items-center gap-2">
                          <div className="w-4 h-4 rounded-full bg-orange-500"></div>{" "}
                          wBTC
                        </td>
                        {/* Wallet */}
                        <td className="py-3 font-mono text-right">
                          {(Number(walletWbtcBalance) / 1e8).toFixed(4)}
                          <span className="text-white/30 text-xs ml-1">
                            wBTC
                          </span>
                        </td>
                        {/* Phantom Pool locked */}
                        <td className="py-3 text-right">
                          {phantomDepositCount > 0 ? (
                            <div className="flex flex-col items-end">
                              <span className="text-[#00cfa7] font-mono text-sm">
                                {phantomDepositCount} deposit
                                {phantomDepositCount !== 1 ? "s" : ""}
                              </span>
                              <span className="text-[10px] text-white/30">
                                awaiting ZK claim
                              </span>
                            </div>
                          ) : (
                            <span className="text-white/20">—</span>
                          )}
                        </td>
                        {/* Tongo trading balance */}
                        <td className="py-3 font-mono text-white/50 text-right">
                          <div className="flex flex-col items-end">
                            <span>{formatUnits(wbtcBalance, 8)}</span>
                            {wbtcBalance === 0n && phantomDepositCount > 0 && (
                              <span className="text-[10px] text-white/25">
                                after condense ↗
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-3 flex justify-end gap-2">
                          <button
                            className="text-xs bg-[#00cfa7]/20 text-[#00cfa7] hover:bg-[#00cfa7]/30 px-3 py-1.5 rounded transition-colors font-bold"
                            onClick={() => setIsDepositOpen(true)}
                          >
                            Deposit
                          </button>
                          <button
                            className="text-xs bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded transition-colors"
                            onClick={() =>
                              address && fetchOnChainBalances(address)
                            }
                          >
                            Sync
                          </button>
                        </td>
                      </tr>
                      <tr className="border-b border-white/5 hover:bg-white/[0.02]">
                        <td className="py-3 flex items-center gap-2">
                          <div className="w-4 h-4 rounded-full bg-blue-500"></div>{" "}
                          USDC
                        </td>
                        <td className="py-3 font-mono text-right">
                          {formatUnits(usdcBalance, 6)}
                        </td>
                        <td className="py-3 font-mono text-white/50 text-right">
                          {formatUnits(usdcBalance, 6)}
                        </td>
                        <td className="py-3 font-mono text-right">—</td>
                        <td className="py-3 text-right">
                          <button
                            className="text-xs bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded transition-colors"
                            onClick={refreshBalances}
                          >
                            Sync
                          </button>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>

          {/* MIDDLE COLUMN: Orderbook */}
          <div className="w-[300px] bg-[#111111] border border-white/5 rounded-lg p-4 flex flex-col shrink-0">
            <div className="flex gap-4 border-b border-white/5 pb-2 mb-3 text-sm justify-between">
              <span className="text-white border-b-2 border-[#00cfa7] pb-2 -mb-[13px] font-medium">
                Order Book
              </span>
              <span className="text-white/50 cursor-not-allowed">Trades</span>
              <span className="text-white/50 cursor-not-allowed">⋮</span>
            </div>

            <div className="flex justify-between text-xs text-white/40 mb-3 mt-1 font-medium tracking-wide">
              <span>Price(USDC)</span>
              <span>Size(wBTC)</span>
              <span>Total</span>
            </div>

            {/* Fake Asks (Red) */}
            <div className="flex flex-col gap-[1px] text-xs font-mono text-[#ff4e4e] mb-3 relative">
              <div className="flex justify-between hover:bg-white/5 py-1 cursor-pointer relative group">
                <div className="absolute right-0 top-0 bottom-0 bg-[#ff4e4e]/10 w-[85%] group-hover:bg-[#ff4e4e]/20 transition-colors"></div>
                <span className="relative z-10 w-1/3">65430.0</span>
                <span className="text-white/80 relative z-10 w-1/3 text-right">
                  0.124
                </span>
                <span className="text-white/50 relative z-10 w-1/3 text-right">
                  0.500
                </span>
              </div>
              <div className="flex justify-between hover:bg-white/5 py-1 cursor-pointer relative group">
                <div className="absolute right-0 top-0 bottom-0 bg-[#ff4e4e]/10 w-[45%] group-hover:bg-[#ff4e4e]/20 transition-colors"></div>
                <span className="relative z-10 w-1/3">65425.5</span>
                <span className="text-white/80 relative z-10 w-1/3 text-right">
                  0.050
                </span>
                <span className="text-white/50 relative z-10 w-1/3 text-right">
                  0.376
                </span>
              </div>
              <div className="flex justify-between hover:bg-white/5 py-1 cursor-pointer relative group">
                <div className="absolute right-0 top-0 bottom-0 bg-[#ff4e4e]/10 w-[30%] group-hover:bg-[#ff4e4e]/20 transition-colors"></div>
                <span className="relative z-10 w-1/3">65422.0</span>
                <span className="text-white/80 relative z-10 w-1/3 text-right">
                  0.326
                </span>
                <span className="text-white/50 relative z-10 w-1/3 text-right">
                  0.326
                </span>
              </div>
            </div>

            <div className="text-lg font-mono text-center my-1 text-white flex items-center justify-center gap-2">
              <span className="text-[#00cfa7]">65,420.00</span>
              <span className="text-xs text-white/40 border-l border-white/20 pl-2">
                Mid
              </span>
            </div>

            {/* Fake Bids (Green) */}
            <div className="flex flex-col gap-[1px] text-xs font-mono text-[#00cfa7] mt-3">
              <div className="flex justify-between hover:bg-white/5 py-1 cursor-pointer relative group">
                <div className="absolute right-0 top-0 bottom-0 bg-[#00cfa7]/10 w-[25%] group-hover:bg-[#00cfa7]/20 transition-colors"></div>
                <span className="relative z-10 w-1/3">65418.5</span>
                <span className="text-white/80 relative z-10 w-1/3 text-right">
                  0.240
                </span>
                <span className="text-white/50 relative z-10 w-1/3 text-right">
                  0.240
                </span>
              </div>
              <div className="flex justify-between hover:bg-white/5 py-1 cursor-pointer relative group">
                <div className="absolute right-0 top-0 bottom-0 bg-[#00cfa7]/10 w-[60%] group-hover:bg-[#00cfa7]/20 transition-colors"></div>
                <span className="relative z-10 w-1/3">65415.0</span>
                <span className="text-white/80 relative z-10 w-1/3 text-right">
                  0.850
                </span>
                <span className="text-white/50 relative z-10 w-1/3 text-right">
                  1.090
                </span>
              </div>
              <div className="flex justify-between hover:bg-white/5 py-1 cursor-pointer relative group">
                <div className="absolute right-0 top-0 bottom-0 bg-[#00cfa7]/10 w-[90%] group-hover:bg-[#00cfa7]/20 transition-colors"></div>
                <span className="relative z-10 w-1/3">65410.0</span>
                <span className="text-white/80 relative z-10 w-1/3 text-right">
                  1.500
                </span>
                <span className="text-white/50 relative z-10 w-1/3 text-right">
                  2.590
                </span>
              </div>
            </div>

            <div className="mt-auto border-t border-white/5 pt-3">
              {/* Dark pool badge */}
              <div className="bg-purple-500/10 text-purple-400 border border-purple-500/20 text-xs px-3 py-2 rounded-lg text-center flex items-center justify-center gap-2">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className="w-4 h-4"
                >
                  <path
                    fillRule="evenodd"
                    d="M3.28 2.22a.75.75 0 00-1.06 1.06l14.5 14.5a.75.75 0 101.06-1.06l-1.48-1.48C17.44 14.36 18.25 13.06 19 12c-2.02-2.94-5.06-5-8.5-5-1.12 0-2.18.2-3.17.56L3.28 2.22zM10 9.5c.34 0 .68.04 1 .11l-2.61 2.61a3 3 0 011.61-2.72zM10 5C6.56 5 3.52 7.06 1.5 10c.53.77 1.13 1.48 1.8 2.12l1.63-1.63C4.54 10.05 4.88 9.5 5.5 9.5c.67 0 1.25.43 1.44 1.04l2.12-2.12c-.34-.14-.7-.22-1.06-.22-1.8 0-3.32 1.25-3.8 2.92L2.73 12.6A9.971 9.971 0 0110 6.5c1.47 0 2.87.32 4.14.88l1.41-1.41A11.96 11.96 0 0010 5z"
                    clipRule="evenodd"
                  />
                </svg>
                Phantom Pool Active
              </div>
            </div>
          </div>

          {/* RIGHT COLUMN: Order Entry */}
          <div className="w-[320px] bg-[#111111] border border-white/5 rounded-lg p-4 flex flex-col shrink-0 overflow-y-auto">
            {/* Deposit button — always visible */}
            <button
              onClick={() => setIsDepositOpen(true)}
              className="w-full mb-4 py-2.5 rounded-lg border border-[#00cfa7]/40 bg-[#00cfa7]/10 text-[#00cfa7] hover:bg-[#00cfa7]/20 transition-all text-sm font-bold flex items-center justify-center gap-2 shadow-[0_0_12px_rgba(0,207,167,0.1)]"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                className="w-4 h-4"
              >
                <path d="M10.75 2.75a.75.75 0 00-1.5 0v8.614L7.29 9.22a.75.75 0 00-1.08 1.04l3.25 3.5a.75.75 0 001.08 0l3.25-3.5a.75.75 0 10-1.08-1.04l-1.96 2.144V2.75z" />
                <path d="M3.5 12.75a.75.75 0 00-1.5 0v2.5A2.75 2.75 0 004.75 18h10.5A2.75 2.75 0 0018 15.25v-2.5a.75.75 0 00-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5z" />
              </svg>
              Private BTC Deposit
            </button>
            <div className="flex gap-4 border-b border-white/5 pb-2 mb-4 text-sm justify-between font-medium">
              <button className="text-white/50 hover:text-white transition-colors">
                Market
              </button>
              <button className="text-white border-b-2 border-[#00cfa7] pb-2 -mb-[9px]">
                Limit
              </button>
              <button className="text-white/50 hover:text-white transition-colors">
                Stop
              </button>
              <button className="text-white/50 hover:text-white transition-colors ml-auto mr-1">
                Pro
              </button>
            </div>

            <div className="bg-black/40 rounded-lg p-1 flex mb-6">
              <button
                className={`flex-1 rounded-md py-1.5 text-sm font-bold transition-all ${direction === "buy" ? "bg-[#00cfa7] text-black shadow-[0_0_15px_rgba(0,207,167,0.3)]" : "text-white/50 hover:text-white"}`}
                onClick={() => setDirection("buy")}
              >
                Buy
              </button>
              <button
                className={`flex-1 rounded-md py-1.5 text-sm font-bold transition-all ${direction === "sell" ? "bg-[#ff4e4e] text-white shadow-[0_0_15px_rgba(255,78,78,0.3)]" : "text-white/50 hover:text-white"}`}
                onClick={() => setDirection("sell")}
              >
                Sell
              </button>
            </div>

            <div className="flex justify-between text-xs mb-4">
              <span
                className="text-white/50 underline decoration-dashed underline-offset-4 cursor-help"
                title="Funds available in Tongo"
              >
                Available to Trade
              </span>
              <span className="font-mono text-white/90">
                {isTongoReady
                  ? direction === "buy"
                    ? `${formatUnits(usdcBalance, 6)} USDC`
                    : `${formatUnits(wbtcBalance, 8)} wBTC`
                  : "0.00 USDC"}
              </span>
            </div>

            <div className="flex flex-col gap-3 mb-6">
              <div className="bg-black/30 border border-white/10 rounded border-b border-b-white/20 focus-within:border-[#00cfa7] focus-within:border-b-[#00cfa7] flex items-center px-3 py-2.5 transition-colors">
                <span className="text-white/50 text-sm w-12 text-left">
                  Price
                </span>
                <input
                  type="number"
                  className="bg-transparent flex-1 text-right font-mono text-white outline-none"
                  placeholder="0.00"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                />
                <span className="text-white text-sm ml-2">USDC</span>
              </div>

              <div className="bg-black/30 border border-white/10 rounded border-b border-b-white/20 focus-within:border-[#00cfa7] focus-within:border-b-[#00cfa7] flex items-center px-3 py-2.5 transition-colors">
                <span className="text-white/50 text-sm w-12 text-left">
                  Size
                </span>
                <input
                  type="number"
                  className="bg-transparent flex-1 text-right font-mono text-white outline-none"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
                <span className="text-white text-sm ml-2">wBTC</span>
              </div>
            </div>

            {/* Slider placeholder */}
            <div className="flex items-center gap-3 mb-8 px-1">
              <input
                type="range"
                min="0"
                max="100"
                defaultValue="0"
                className="flex-1 accent-[#00cfa7] h-1 bg-white/20 rounded-lg appearance-none cursor-pointer"
              />
              <div className="bg-white/10 text-xs px-2 py-1 rounded font-mono">
                0%
              </div>
            </div>

            <div className="mb-6 pt-2">
              <div className="flex justify-between text-xs mb-3 font-mono">
                <span className="text-white/50">Order Value</span>
                <span className="text-white">
                  {price && amount
                    ? (parseFloat(price) * parseFloat(amount)).toLocaleString(
                        undefined,
                        { minimumFractionDigits: 2, maximumFractionDigits: 2 },
                      )
                    : "0.00"}{" "}
                  USDC
                </span>
              </div>
              <div className="flex justify-between text-xs font-mono">
                <span className="text-white/50">Maker / Taker Fees</span>
                <span className="text-white">0.050% / 0.050%</span>
              </div>
            </div>

            <button
              className={`w-full py-4 rounded font-bold text-sm tracking-wide transition-all flex items-center justify-center shadow-lg hover:-translate-y-0.5 ${
                !isTongoReady
                  ? "bg-white/10 text-white/50 cursor-not-allowed shadow-none hover:translate-y-0"
                  : direction === "buy"
                    ? "bg-[#00cfa7] text-black shadow-[0_4px_14px_rgba(0,207,167,0.39)]"
                    : "bg-[#ff4e4e] text-white shadow-[0_4px_14px_rgba(255,78,78,0.39)]"
              }`}
              disabled={!isTongoReady || !price || !amount || isSubmitting}
              onClick={handlePlaceOrder}
            >
              {!isTongoReady ? (
                "Unlock Tongo Account First"
              ) : isSubmitting ? (
                <>
                  <div className="animate-spin h-4 w-4 border-2 border-current border-t-transparent rounded-full mr-2"></div>{" "}
                  Generating ZK Proof...
                </>
              ) : (
                `Place ${direction === "buy" ? "Buy" : "Sell"} Order`
              )}
            </button>

            <div className="mt-8 pt-4 border-t border-white/5 space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-white/50">Time in Force (TIF)</span>
                <span className="text-white">GTC</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-white/50">Post Only</span>
                <span className="text-white">No</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-white/50">Reduce Only</span>
                <span className="text-white">No</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
