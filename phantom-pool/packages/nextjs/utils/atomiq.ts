/**
 * atomiq.ts — Phantom vault address utilities.
 *
 * The Atomiq bridge has been replaced with a direct wBTC transfer.
 * This file now only exports the two helpers needed by DepositModal:
 *   - tongoBase58PubKeyToFelt252: converts Tongo Base58 pubkey → felt252 hex
 *   - derivePhantomAddress: Poseidon hash → counterfactual Starknet address
 */

import { hash } from "starknet";
import { poseidonHashMany } from "@scure/starknet";
import { pubKeyBase58ToAffine } from "@fatsolutions/tongo-sdk";

// ─── Environment ─────────────────────────────────────────────────────────────
// PhantomVault declared class hash on Sepolia
// sncast declare output: 0x0266db1c4c1829d96eeb70b75d7434c18f2887563d9a9996f88ab43a8d54f363
const PHANTOM_VAULT_CLASS_HASH =
  process.env.NEXT_PUBLIC_PHANTOM_VAULT_CLASS_HASH ||
  "0x0266db1c4c1829d96eeb70b75d7434c18f2887563d9a9996f88ab43a8d54f363";

/**
 * Converts a Base58-encoded Tongo public key to a felt252 hex string
 * (the x-coordinate of the affine point on the Stark curve).
 *
 * Tongo's btcAccount.tongoAddress() returns Base58 — this converts it
 * to the hex felt252 that poseidonHashMany expects.
 */
export function tongoBase58PubKeyToFelt252(base58PubKey: string): string {
  const affine = pubKeyBase58ToAffine(base58PubKey);
  // affine = { x: bigint, y: bigint } — use x as the felt252
  return "0x" + (affine as any).x.toString(16);
}

/**
 * Derives the phantom vault address (counterfactual Starknet address).
 *
 * Algorithm (§2.5 of technical-details.md):
 *   r    = random 31-byte secret
 *   salt = Poseidon(tongo_pubkey_felt, r_felt)
 *   addr = calculateContractAddressFromHash(
 *            salt,
 *            PHANTOM_VAULT_CLASS_HASH,
 *            [phantomPoolAddress],   // constructor arg
 *            0,                     // deployer = 0 (permissionless)
 *          )
 *
 * @param tongoPubKeyFelt  Felt252 hex string of the Tongo public key x-coord
 * @param phantomPoolAddress  Address of the deployed PhantomPool contract
 * @param wbtcAddress  Address of the WBTC token
 */
export function derivePhantomAddress(
  tongoPubKeyFelt: string,
  phantomPoolAddress: string,
  wbtcAddress: string,
): { phantomAddress: string; salt: bigint; r: string } {
  // 31-byte random secret padded to felt252 range
  const rBytes = crypto.getRandomValues(new Uint8Array(31));
  const rFelt =
    "0x" + Array.from(rBytes, (b) => b.toString(16).padStart(2, "0")).join("");

  // salt = Poseidon(tongo_pubkey, r)
  const salt = poseidonHashMany([BigInt(tongoPubKeyFelt), BigInt(rFelt)]);

  // Starknet counterfactual address
  const phantomAddress = hash.calculateContractAddressFromHash(
    "0x" + salt.toString(16),
    PHANTOM_VAULT_CLASS_HASH,
    [phantomPoolAddress, wbtcAddress], // constructor_calldata = [condenser_addr, wbtc_addr]
    "0x0", // deployer_address = 0 → permissionless deploy
  );

  return { phantomAddress, salt, r: rFelt };
}
