// ─────────────────────────────────────────────────────────────────────────────
// Phantom Pool Relayer — Configuration
// ─────────────────────────────────────────────────────────────────────────────
// Read from environment variables (use a .env file in development).

import { resolve } from "path";

// Load .env from the relayer/ directory
const envPath = resolve(import.meta.dir, "../.env");
try {
  // Bun natively supports .env files when running with bun — this is a manual
  // fallback for programmatic access early in boot.
  const file = Bun.file(envPath);
  if (await file.exists()) {
    const text = await file.text();
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!(key in process.env)) process.env[key] = val;
    }
  }
} catch {
  // .env not present — rely on actual environment variables
}

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env variable: ${key}`);
  return v;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const config = {
  // ── Starknet ──────────────────────────────────────────────────────────────
  rpcUrl: optional("STARKNET_RPC_URL", "http://127.0.0.1:5050"),
  /** Relayer's Starknet account address (pays gas for submit_match) */
  relayerAddress: optional(
    "RELAYER_ADDRESS",
    "0x064b48806902a367c8598f4f95c305e8c1a1acba5f082d294a43793113115691"
  ),
  /** Relayer's private key (KEEP SECRET) */
  relayerPrivateKey: optional(
    "RELAYER_PRIVATE_KEY",
    "0x0000000000000000000000000000000000000000000000000000000000000001"
  ),

  // ── Deployed contract addresses ───────────────────────────────────────────
  phantomPoolAddress: optional("PHANTOM_POOL_ADDRESS", "0x0"),
  matchCorrectnessVerifierAddress: optional(
    "MATCH_CORRECTNESS_VERIFIER_ADDRESS",
    "0x0"
  ),

  // ── Proof toolchain paths ─────────────────────────────────────────────────
  /** Absolute path to the match_correctness circuit directory */
  circuitDir: optional(
    "CIRCUIT_DIR",
    resolve(
      import.meta.dir,
      "../../circuits/match_correctness"
    )
  ),
  /** Path to the `bb` binary (Barretenberg) */
  bbBin: optional("BB_BIN", "bb"),
  /** Path to the `nargo` binary  */
  nargoBin: optional("NARGO_BIN", "nargo"),
  /** Path to the `garaga` binary / python module runner */
  garagaBin: optional("GARAGA_BIN", "garaga"),


  // ── API server ────────────────────────────────────────────────────────────
  port: Number(optional("PORT", "3001")),
  /** Shared secret for any admin endpoints (optional) */
  adminSecret: optional("ADMIN_SECRET", "phantom-dev"),

  // ── Matching loop ─────────────────────────────────────────────────────────
  /** How often (ms) to run the matching engine */
  matchIntervalMs: Number(optional("MATCH_INTERVAL_MS", "2000")),
  /** How often (ms) to poll Starknet for OrderSubmitted events */
  pollIntervalMs: Number(optional("POLL_INTERVAL_MS", "5000")),
  /** Starting block to scan for events (0 = from genesis; set after deploy) */
  fromBlock: Number(optional("FROM_BLOCK", "0")),
} as const;

export type Config = typeof config;
