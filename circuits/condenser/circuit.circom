pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "merkle.circom";

template CondenseProof() {
    // === Private inputs ===
    signal input tongo_pubkey;
    signal input r;
    signal input phantom_addr;
    signal input amount;
    signal input deposit_timestamp;
    signal input merkle_siblings[20];
    signal input merkle_path_bits[20];

    // === Public inputs ===
    signal input accumulator_root;
    signal input tongo_account_commitment;
    signal input denomination;
    signal input phantom_address_nullifier;

    // Constants
    var NULLIFIER_DOMAIN = 12345; 
    var TONGO_COMMITMENT_DOMAIN = 54321;
    var DENOM_TENTH = 10000000;
    var DENOM_ONE = 100000000;
    var DENOM_TEN = 1000000000;

    // 1. Derive phantom entry address salt
    component saltHasher = Poseidon(2);
    saltHasher.inputs[0] <== tongo_pubkey;
    saltHasher.inputs[1] <== r;
    signal salt <== saltHasher.out;

    // 2. Reconstruct the deposit tree leaf
    component leafHasher = Poseidon(4);
    leafHasher.inputs[0] <== salt;
    leafHasher.inputs[1] <== phantom_addr;
    leafHasher.inputs[2] <== amount;
    leafHasher.inputs[3] <== deposit_timestamp;
    signal leaf <== leafHasher.out;

    // 3. Verify the deposit is in the accumulator tree
    component merkleChecker = VerifyMerkleProof(20);
    merkleChecker.leaf <== leaf;
    merkleChecker.root <== accumulator_root;
    for (var i = 0; i < 20; i++) {
        merkleChecker.pathElements[i] <== merkle_siblings[i];
        merkleChecker.pathIndices[i] <== merkle_path_bits[i];
    }

    // 4. Verify the denomination
    component isTenth = IsEqual();
    isTenth.in[0] <== amount;
    isTenth.in[1] <== DENOM_TENTH;
    
    component isOne = IsEqual();
    isOne.in[0] <== amount;
    isOne.in[1] <== DENOM_ONE;

    component isTen = IsEqual();
    isTen.in[0] <== amount;
    isTen.in[1] <== DENOM_TEN;

    isTenth.out + isOne.out + isTen.out === 1;
    denomination === amount;

    // 5. Verify tongo_account_commitment binds to the recipient
    component recipientHasher = Poseidon(2);
    recipientHasher.inputs[0] <== tongo_pubkey;
    recipientHasher.inputs[1] <== TONGO_COMMITMENT_DOMAIN;
    tongo_account_commitment === recipientHasher.out;

    // 6. Verify nullifier
    component nullifierHasher = Poseidon(4);
    nullifierHasher.inputs[0] <== tongo_pubkey;
    nullifierHasher.inputs[1] <== r;
    nullifierHasher.inputs[2] <== NULLIFIER_DOMAIN;
    nullifierHasher.inputs[3] <== 0;
    phantom_address_nullifier === nullifierHasher.out;
}
component main {public [accumulator_root, tongo_account_commitment, denomination, phantom_address_nullifier]} = CondenseProof();
