pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";

template MatchCorrectnessProof() {
    // === Private inputs — none of these ever appear on-chain ===
    signal input buy_price;
    signal input buy_amount;
    signal input buy_nonce;
    signal input sell_price;
    signal input sell_amount;
    signal input sell_nonce;
    signal input settlement_amount;  // min(buy_amount, sell_amount)
    signal input settlement_price;   // midpoint: (buy_price + sell_price) / 2

    // === Public inputs ===
    signal input buy_commitment;
    signal input sell_commitment;
    signal input settlement_commitment;

    // 1. Verify both order commitments match the private order data
    component expected_buy = Poseidon(4);
    expected_buy.inputs[0] <== 0; // buy = 0
    expected_buy.inputs[1] <== buy_price;
    expected_buy.inputs[2] <== buy_amount;
    expected_buy.inputs[3] <== buy_nonce;
    buy_commitment === expected_buy.out;

    component expected_sell = Poseidon(4);
    expected_sell.inputs[0] <== 1; // sell = 1
    expected_sell.inputs[1] <== sell_price;
    expected_sell.inputs[2] <== sell_amount;
    expected_sell.inputs[3] <== sell_nonce;
    sell_commitment === expected_sell.out;

    // 2. Verify price crossing
    component gtePrice = GreaterEqThan(252);
    gtePrice.in[0] <== buy_price;
    gtePrice.in[1] <== sell_price;
    gtePrice.out === 1;

    // 3. Verify settlement amount = min(buy_amount, sell_amount)
    component lteBuyAmount = LessEqThan(252);
    lteBuyAmount.in[0] <== settlement_amount;
    lteBuyAmount.in[1] <== buy_amount;
    lteBuyAmount.out === 1;

    component lteSellAmount = LessEqThan(252);
    lteSellAmount.in[0] <== settlement_amount;
    lteSellAmount.in[1] <== sell_amount;
    lteSellAmount.out === 1;

    component gtZero = GreaterThan(252);
    gtZero.in[0] <== settlement_amount;
    gtZero.in[1] <== 0;
    gtZero.out === 1;

    // 4. Verify settlement price is midpoint
    settlement_price * 2 === buy_price + sell_price;

    // 5. Commit to settlement terms
    component expected_settlement = Poseidon(2);
    expected_settlement.inputs[0] <== settlement_amount;
    expected_settlement.inputs[1] <== settlement_price;
    settlement_commitment === expected_settlement.out;
}
component main {public [buy_commitment, sell_commitment, settlement_commitment]} = MatchCorrectnessProof();
