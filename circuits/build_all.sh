#!/usr/bin/env bash
set -e

# Base directory
BASEDIR=$(pwd)
PTAU="pot14_final.ptau"

echo "==== Downloading PTAU file (Powers of Tau Phase 1) to save time ===="
if [ ! -f "$PTAU" ]; then
  # We use a pre-existing powers of tau file from hermez to save memory/time. bn128 curve, order 14 (16k constraints)
  curl -L -o $PTAU https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_14.ptau
fi

for dir in "order_validity" "match_correctness" "condenser"; do
    echo "==== Processing $dir ===="
    cd $BASEDIR/$dir

    # 1. Compile Circom
    echo "Compiling circuit..."
    circom circuit.circom --r1cs --wasm --sym -o . -l ../node_modules

    # 2. Generate ZKey (trusted setup)
    echo "Generating zkey..."
    npx snarkjs groth16 setup circuit.r1cs ../$PTAU circuit_0000.zkey
    echo "something" | npx snarkjs zkey contribute circuit_0000.zkey circuit_final.zkey --name="Phase2" -v -e="entropy"
    
    # 3. Export Verification Key
    echo "Exporting verification key..."
    npx snarkjs zkey export verificationkey circuit_final.zkey verification_key.json

    # 4. Generate witness (Needs input.json)
    if [ -f "input.json" ]; then
        echo "Generating witness from input.json..."
        node circuit_js/generate_witness.js circuit_js/circuit.wasm input.json witness.wtns
        
        echo "Generating proof..."
        npx snarkjs groth16 prove circuit_final.zkey witness.wtns proof.json public.json
        
        echo "Verifying proof locally..."
        npx snarkjs groth16 verify verification_key.json public.json proof.json
    else
        echo "No input.json found for $dir, skipping witness & proof generation."
    fi

    echo "==== Done with $dir ===="
done
