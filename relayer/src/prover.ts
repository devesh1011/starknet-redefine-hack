import { $ } from "bun";
import { join } from "path";
import { mkdtemp, writeFile, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { config } from "./config.js";
import type { Order, MatchResult } from "./types.js";
// @ts-ignore
import * as snarkjs from "snarkjs";

// ─── Main prove function ──────────────────────────────────────────────────────
export async function prove(
  buy: Order,
  sell: Order,
  match: MatchResult
): Promise<{ calldata: string[]; proofBytes?: Buffer; publicInputsBytes?: Buffer }> {

  console.log(`[prover] Generating MatchCorrectnessProof via snarkjs...`);
  const workDir = await mkdtemp(join(tmpdir(), "phantom-proof-"));
  console.log(`[prover] Working dir: ${workDir}`);

  try {
    const input = {
      buy_price: buy.price.toString(),
      buy_amount: buy.amount.toString(),
      buy_nonce: buy.nonce.toString(),
      sell_price: sell.price.toString(),
      sell_amount: sell.amount.toString(),
      sell_nonce: sell.nonce.toString(),
      settlement_amount: match.settlementAmount.toString(),
      settlement_price: match.settlementPrice.toString(),
    };

    // 1. Generate proof via snarkjs
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      input,
      config.wasmPath,
      config.zkeyPath
    );

    const proofPath = join(workDir, "proof.json");
    const publicPath = join(workDir, "public.json");

    await writeFile(proofPath, JSON.stringify(proof));
    await writeFile(publicPath, JSON.stringify(publicSignals));

    // 2. Generate Garaga calldata
    console.log(`[prover] Generating Garaga calldata...`);
    const calldataJsonPath = join(workDir, "calldata.json");

    const garagaScript = `
import sys, json
from garaga.starknet.groth16_contract_generator.calldata import get_groth16_calldata_from_vk_and_proof
from garaga.precompiled_circuits.groth16 import Groth16Proof, Groth16Vk

vk_path = "${config.zkeyPath.replace('.zkey', '_vk.json')}" # hack assuming vk is alongside zkey
proof_json = json.load(open('${proofPath}'))
public_json = json.load(open('${publicPath}'))
vk_json = json.load(open(vk_path))

vk = Groth16Vk.from_json(vk_json)
proof = Groth16Proof.from_snarkjs(proof_json, public_json, vk)
calldata = get_groth16_calldata_from_vk_and_proof(vk=vk, proof=proof)

with open('${calldataJsonPath}', 'w') as f:
    json.dump([hex(x) for x in calldata], f)
print("OK")
`;
    const scriptPath = join(workDir, "gen_calldata.py");
    await writeFile(scriptPath, garagaScript, "utf8");

    // Execute Python script within Garaga venv
    const pyResult = await $`source ${config.pythonVenvPath}/bin/activate && python3 ${scriptPath}`.quiet();
    if (pyResult.exitCode !== 0) {
      throw new Error(`Garaga calldata generation failed: ${pyResult.stderr.toString()}`);
    }

    const calldataJson = await readFile(calldataJsonPath, "utf8");
    const calldata: string[] = JSON.parse(calldataJson);
    console.log(`[prover] Garaga calldata: ${calldata.length} felt252 elements`);

    return { calldata, proofBytes: Buffer.from(JSON.stringify(proof)), publicInputsBytes: Buffer.from(JSON.stringify(publicSignals)) };

  } finally {
    // Clean up
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
