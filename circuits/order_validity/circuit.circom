pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";

template OrderValidityProof() {
    // === Private inputs (never revealed on-chain) ===
    signal input price;          // limit price
    signal input amount;         // order size in satoshis
    signal input nonce;          // random secret to prevent brute-force
    signal input direction;      // 0 = buy, 1 = sell
    signal input tongo_balance;  // user's client-decrypted current Tongo balance
    signal input user_secret;    // user's Tongo private key

    // === Public inputs (published on-chain) ===
    signal input commitment;          // Poseidon(direction, price, amount, nonce)
    signal input trader_tongo_pubkey; // user's Tongo account public key

    // 1. Verify the on-chain commitment matches the private order
    component poseidon4 = Poseidon(4);
    poseidon4.inputs[0] <== direction;
    poseidon4.inputs[1] <== price;
    poseidon4.inputs[2] <== amount;
    poseidon4.inputs[3] <== nonce;
    commitment === poseidon4.out;

    // 2. Verify balance sufficiency
    component gte = GreaterEqThan(252);
    gte.in[0] <== tongo_balance;
    gte.in[1] <== amount;
    gte.out === 1;

    component gtZero = GreaterThan(252);
    gtZero.in[0] <== amount;
    gtZero.in[1] <== 0;
    gtZero.out === 1;

    // 3. Verify user owns the Tongo account (Simplified logic)
    component derived_pubkey = Poseidon(1); 
    derived_pubkey.inputs[0] <== user_secret;
    trader_tongo_pubkey === derived_pubkey.out;
}
component main {public [commitment, trader_tongo_pubkey]} = OrderValidityProof();
