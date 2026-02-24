import { RpcProvider } from "starknet";
import { Account as TongoAccount, pubKeyBase58ToAffine} from "@fatsolutions/tongo-sdk";

// Fetch configurations strictly from environment variables
const TONGO_BTC_ADDRESS = process.env.NEXT_PUBLIC_TONGO_BTC_ADDRESS as string;
const TONGO_USDC_ADDRESS = process.env.NEXT_PUBLIC_TONGO_USDC_ADDRESS as string;
const PHANTOM_POOL_TONGO_PUBKEY = process.env.NEXT_PUBLIC_PHANTOM_POOL_TONGO_PUBKEY as string;

if (!TONGO_BTC_ADDRESS || !TONGO_USDC_ADDRESS || !PHANTOM_POOL_TONGO_PUBKEY) {
  console.warn("WARNING: Missing Tongo configuration in environment variables");
}

// Shared SDK instances
let btcAccount: TongoAccount | null = null;
let usdcAccount: TongoAccount | null = null;
let starknetProvider: RpcProvider | null = null;
let cachedPrivateKey: string | null = null;

export const LOCAL_STORAGE_KEY = "phantom_pool_tongo_secret";

/**
 * Generates a random starknet-compatible private key
 */
function generateRandomPrivateKey(): string {
  const chars = "0123456789abcdef";
  let randomHex = "0x";
  for(let i=0; i<63; i++) {
    randomHex += chars[Math.floor(Math.random() * 16)];
  }
  return randomHex;
}

/**
 * Initializes the TongoSDK Accounts and returns the user's keys.
 * If the user has a saved secret in localStorage, it uses it.
 * Otherwise, generates a new private key and saves the secret.
 */
export async function initializeTongoSdk() {
  if (btcAccount && usdcAccount && cachedPrivateKey) {
    return { keyPair: { secretKey: cachedPrivateKey, publicKey: btcAccount.tongoAddress() } };
  }

  const rpcUrl = process.env.NEXT_PUBLIC_SEPOLIA_PROVIDER_URL || "https://starknet-sepolia.public.blastapi.io";

  // Initialize Provider
  starknetProvider = new RpcProvider({ nodeUrl: rpcUrl, specVersion: "0.8.1" });

  // Try to load existing key from localStorage
  let privateKey = localStorage.getItem(LOCAL_STORAGE_KEY);
  
  if (!privateKey) {
    privateKey = generateRandomPrivateKey();
    localStorage.setItem(LOCAL_STORAGE_KEY, privateKey);
  }
  cachedPrivateKey = privateKey;

  btcAccount = new TongoAccount(privateKey, TONGO_BTC_ADDRESS, starknetProvider as any);
  usdcAccount = new TongoAccount(privateKey, TONGO_USDC_ADDRESS, starknetProvider as any);
  
  return { 
    keyPair: { 
      secretKey: privateKey, 
      publicKey: btcAccount.tongoAddress() // Base58 encoded
    } 
  };
}

/**
 * Convenience method to get the available decrypted balance of a Tongo token
 */
export async function getTongoBalance(token: "wBTC" | "USDC") {
  const account = token === "wBTC" ? btcAccount : usdcAccount;
  if (!account) {
    throw new Error("SDK not initialized. Call initializeTongoSdk first.");
  }
  
  try {
    const state = await account.state();
    return state.balance + state.pending;
  } catch (error) {
    console.warn(`Failed to get balance for ${token}:`, error);
    return 0n;
  }
}

/**
 * Helper to prepare the settlement payload using TongoSDK 
 * Output is sent to our relayer to batch with matching!
 */
export async function prepareTongoSettlementTransfer(
  token: "wBTC" | "USDC",
  amount: bigint,
  starknetSenderAddress: string
): Promise<string[]> {
  const account = token === "wBTC" ? btcAccount : usdcAccount;
  if (!account) {
    throw new Error("SDK not initialized. Call initializeTongoSdk first.");
  }
  if (!PHANTOM_POOL_TONGO_PUBKEY) {
    throw new Error("Phantom Pool Tongo PubKey is not set in environment");
  }

  // Parse the base58 public key provided via ENV
  const receiverPubKey = pubKeyBase58ToAffine(PHANTOM_POOL_TONGO_PUBKEY);
  
  const transfer = await account.transfer({
    to: receiverPubKey as any, // Cast to match internal SDK typing
    amount: amount,
    sender: starknetSenderAddress
  });
  
  const call = transfer.toCalldata();
  return call.calldata as unknown as string[];
}
