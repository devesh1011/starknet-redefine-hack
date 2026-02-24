/**
 * prover.ts — Browser-side ZK Proof generation
 *
 * Exports:
 *   generateCondenserProof — Groth16 condense proof (Phase 2)
 *   generateOrderValidityProof — Order validity proof (order submission)
 *   bn254Poseidon, computeBn254MerkleRoot, buildMerklePath — helpers
 */

// ─── BN254 Poseidon (matches circomlibjs inside all circom circuits) ──────────
let _poseidon: any = null;
async function getPoseidon() {
  if (_poseidon) return _poseidon;
  const { buildPoseidon } = await import("circomlibjs");
  _poseidon = await buildPoseidon();
  return _poseidon;
}

export async function bn254Poseidon(...inputs: bigint[]): Promise<bigint> {
  const poseidon = await getPoseidon();
  const result = poseidon(inputs);
  return BigInt(poseidon.F.toString(result));
}

// ─── Merkle tree helpers (BN254 Poseidon, depth 20) ─────────────────────────
const DEPTH = 20;

export async function buildMerklePath(
  leafIdx: number,
  allLeaves: bigint[],
): Promise<{ siblings: bigint[]; pathBits: number[] }> {
  const poseidon = await getPoseidon();
  const size = 1 << DEPTH;
  const level: bigint[] = new Array(size).fill(0n);
  for (let i = 0; i < allLeaves.length; i++) level[i] = allLeaves[i];

  const siblings: bigint[] = [];
  const pathBits: number[] = [];
  let idx = leafIdx;

  const nodes: bigint[][] = [level];
  for (let d = 0; d < DEPTH; d++) {
    const cur = nodes[d];
    const next: bigint[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      const l = cur[i];
      const r = cur[i + 1] ?? 0n;
      const hash =
        l === 0n && r === 0n
          ? 0n
          : BigInt(poseidon.F.toString(poseidon([l, r])));
      next.push(hash);
    }
    nodes.push(next);
    const sibIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
    siblings.push(nodes[d][sibIdx] ?? 0n);
    pathBits.push(idx % 2);
    idx = Math.floor(idx / 2);
  }

  return { siblings, pathBits };
}

export async function computeBn254MerkleRoot(
  leaves: bigint[],
): Promise<bigint> {
  const poseidon = await getPoseidon();
  const size = 1 << DEPTH;
  const level: bigint[] = new Array(size).fill(0n);
  for (let i = 0; i < leaves.length; i++) level[i] = leaves[i];

  let cur = level;
  for (let d = 0; d < DEPTH; d++) {
    const next: bigint[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      const l = cur[i];
      const r = cur[i + 1] ?? 0n;
      const hash =
        l === 0n && r === 0n
          ? 0n
          : BigInt(poseidon.F.toString(poseidon([l, r])));
      next.push(hash);
    }
    cur = next;
  }
  return cur[0];
}

// ─── Garaga converters ────────────────────────────────────────────────────────
function vkToGaraga(vkey: any) {
  return {
    alpha: {
      x: BigInt(vkey.vk_alpha_1[0]),
      y: BigInt(vkey.vk_alpha_1[1]),
      curveId: 0,
    },
    beta: {
      x: [BigInt(vkey.vk_beta_2[0][0]), BigInt(vkey.vk_beta_2[0][1])] as [
        bigint,
        bigint,
      ],
      y: [BigInt(vkey.vk_beta_2[1][0]), BigInt(vkey.vk_beta_2[1][1])] as [
        bigint,
        bigint,
      ],
      curveId: 0,
    },
    gamma: {
      x: [BigInt(vkey.vk_gamma_2[0][0]), BigInt(vkey.vk_gamma_2[0][1])] as [
        bigint,
        bigint,
      ],
      y: [BigInt(vkey.vk_gamma_2[1][0]), BigInt(vkey.vk_gamma_2[1][1])] as [
        bigint,
        bigint,
      ],
      curveId: 0,
    },
    delta: {
      x: [BigInt(vkey.vk_delta_2[0][0]), BigInt(vkey.vk_delta_2[0][1])] as [
        bigint,
        bigint,
      ],
      y: [BigInt(vkey.vk_delta_2[1][0]), BigInt(vkey.vk_delta_2[1][1])] as [
        bigint,
        bigint,
      ],
      curveId: 0,
    },
    ic: vkey.IC.map((s: string[]) => ({
      x: BigInt(s[0]),
      y: BigInt(s[1]),
      curveId: 0,
    })),
  };
}

function proofToGaraga(proof: any, publicSignals: string[]) {
  return {
    a: { x: BigInt(proof.pi_a[0]), y: BigInt(proof.pi_a[1]), curveId: 0 },
    b: {
      x: [BigInt(proof.pi_b[0][0]), BigInt(proof.pi_b[0][1])] as [
        bigint,
        bigint,
      ],
      y: [BigInt(proof.pi_b[1][0]), BigInt(proof.pi_b[1][1])] as [
        bigint,
        bigint,
      ],
      curveId: 0,
    },
    c: { x: BigInt(proof.pi_c[0]), y: BigInt(proof.pi_c[1]), curveId: 0 },
    publicInputs: publicSignals.map(BigInt),
    curveId: 0,
  };
}

// ─── Order Validity Proof (used in trade/page.tsx) ────────────────────────────
export async function generateOrderValidityProof(
  inputs: Record<string, string | number>,
) {
  const snarkjs = await import("snarkjs");
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    inputs,
    "/circuits/order_validity/circuit.wasm",
    "/circuits/order_validity/circuit_final.zkey",
  );
  return { proof, publicSignals };
}

// ─── Condenser Proof (Phase 2 deposit claim) ──────────────────────────────────
export interface CondenserInputs {
  tongoPubkey: bigint;
  r: bigint;
  phantomAddr: bigint;
  amount: bigint;
  depositTimestamp: bigint;
  leafIndex: number;
  allBn254Leaves: bigint[];
  bn254AccumulatorRoot: bigint;
}

export interface CondenserProofResult {
  proof: any;
  publicSignals: string[];
  calldataFelts: string[];
  publicInputs: {
    accumulatorRoot: string;
    tongoAccountCommitment: string;
    denomination: string;
    nullifier: string;
  };
}

const TONGO_COMMITMENT_DOMAIN = 54321n;
const NULLIFIER_DOMAIN = 12345n;

export async function generateCondenserProof(
  inputs: CondenserInputs,
  onProgress?: (msg: string) => void,
): Promise<CondenserProofResult> {
  const log = (msg: string) => {
    console.log("[prover]", msg);
    onProgress?.(msg);
  };

  log("Initialising BN254 Poseidon...");
  await getPoseidon();

  log("Deriving BN254 salt and leaf...");
  const salt = await bn254Poseidon(inputs.tongoPubkey, inputs.r);
  const leaf = await bn254Poseidon(
    salt,
    inputs.phantomAddr,
    inputs.amount,
    inputs.depositTimestamp,
  );

  log("Building Merkle path (depth 20)...");
  const { siblings, pathBits } = await buildMerklePath(
    inputs.leafIndex,
    inputs.allBn254Leaves,
  );

  const tongoCommitment = await bn254Poseidon(
    inputs.tongoPubkey,
    TONGO_COMMITMENT_DOMAIN,
  );
  const nullifier = await bn254Poseidon(
    inputs.tongoPubkey,
    inputs.r,
    NULLIFIER_DOMAIN,
    0n,
  );

  const circuitInputs = {
    tongo_pubkey: inputs.tongoPubkey.toString(),
    r: inputs.r.toString(),
    phantom_addr: inputs.phantomAddr.toString(),
    amount: inputs.amount.toString(),
    deposit_timestamp: inputs.depositTimestamp.toString(),
    merkle_siblings: siblings.map((s) => s.toString()),
    merkle_path_bits: pathBits,
    accumulator_root: inputs.bn254AccumulatorRoot.toString(),
    tongo_account_commitment: tongoCommitment.toString(),
    denomination: inputs.amount.toString(),
    phantom_address_nullifier: nullifier.toString(),
  };

  log("Generating Groth16 witness + proof (this may take 10-30s)...");
  const snarkjs = await import("snarkjs");
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInputs,
    "/circuits/condenser/circuit.wasm",
    "/circuits/condenser/circuit_final.zkey",
  );
  log("Proof generated ✓");

  log("Formatting Garaga calldata...");
  const garaga = await import("garaga");
  await garaga.init();

  const vkeyRaw = await fetch("/circuits/condenser/verification_key.json").then(
    (r) => r.json(),
  );
  const vkeyGaraga = vkToGaraga(vkeyRaw);
  const proofGaraga = proofToGaraga(proof, publicSignals);

  const calldata = await (garaga as any).getGroth16CallData(
    proofGaraga,
    vkeyGaraga,
    (garaga as any).CurveId.BN254,
  );
  const calldataFelts: string[] = calldata
    .slice(1)
    .map((x: bigint) => "0x" + x.toString(16));
  log("Calldata formatted ✓");

  return {
    proof,
    publicSignals,
    calldataFelts,
    publicInputs: {
      accumulatorRoot: publicSignals[0],
      tongoAccountCommitment: publicSignals[1],
      denomination: publicSignals[2],
      nullifier: publicSignals[3],
    },
  };
}
