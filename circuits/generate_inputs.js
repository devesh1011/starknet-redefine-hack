const fs = require('fs');
const { buildPoseidon } = require('circomlibjs');

async function main() {
    const poseidon = await buildPoseidon();
    function poseidonHash(inputs) {
        return poseidon.F.toString(poseidon(inputs.map(x => BigInt(x))));
    }

    // --- Order Validity ---
    const orderInputs = {
        price: "1000",
        amount: "500",
        nonce: "12345",
        direction: "0",
        tongo_balance: "1000",
        user_secret: "423456789"
    };

    const commitment = poseidonHash([
        orderInputs.direction,
        orderInputs.price,
        orderInputs.amount,
        orderInputs.nonce
    ]);
    const trader_tongo_pubkey = poseidonHash([orderInputs.user_secret]);

    fs.writeFileSync('./order_validity/input.json', JSON.stringify({
        ...orderInputs,
        commitment,
        trader_tongo_pubkey
    }, null, 2));

    // --- Match Correctness ---
    const buyInputs = { buy_price: "1000", buy_amount: "500", buy_nonce: "12345" };
    const sellInputs = { sell_price: "900", sell_amount: "600", sell_nonce: "54321" };

    const buy_commitment = poseidonHash([0, buyInputs.buy_price, buyInputs.buy_amount, buyInputs.buy_nonce]);
    const sell_commitment = poseidonHash([1, sellInputs.sell_price, sellInputs.sell_amount, sellInputs.sell_nonce]);

    const settlement_amount = "500"; // min(500, 600)
    const settlement_price = "950";  // (1000 + 900) / 2
    const settlement_commitment = poseidonHash([settlement_amount, settlement_price]);

    fs.writeFileSync('./match_correctness/input.json', JSON.stringify({
        ...buyInputs,
        ...sellInputs,
        settlement_amount,
        settlement_price,
        buy_commitment,
        sell_commitment,
        settlement_commitment
    }, null, 2));

    // --- Condenser ---
    // tongo_pubkey, r, phantom_addr, amount, deposit_timestamp
    const condenseInputs = {
        tongo_pubkey: trader_tongo_pubkey,
        r: "987654321",
        phantom_addr: "111222333444",
        amount: "100000000", // DENOM_ONE
        deposit_timestamp: "1720000000"
    };

    const salt = poseidonHash([condenseInputs.tongo_pubkey, condenseInputs.r]);
    const leaf = poseidonHash([salt, condenseInputs.phantom_addr, condenseInputs.amount, condenseInputs.deposit_timestamp]);

    // Dummy merkle tree (all zeros, depth 20)
    const merkle_siblings = new Array(20).fill("0");
    const merkle_path_bits = new Array(20).fill(0);

    let current = BigInt(leaf);
    for (let i = 0; i < 20; i++) {
        // path bit is 0, so current is left, sibling is right
        const sib = BigInt(merkle_siblings[i]);
        current = poseidon.F.toString(poseidon([current, sib]));
    }
    const accumulator_root = current.toString();

    const tongo_account_commitment = poseidonHash([condenseInputs.tongo_pubkey, "54321"]);
    const phantom_address_nullifier = poseidonHash([condenseInputs.tongo_pubkey, condenseInputs.r, "12345", "0"]);

    fs.writeFileSync('./condenser/input.json', JSON.stringify({
        ...condenseInputs,
        merkle_siblings,
        merkle_path_bits,
        accumulator_root,
        tongo_account_commitment,
        denomination: condenseInputs.amount,
        phantom_address_nullifier
    }, null, 2));

    console.log("Generated input.json for all three circuits.");
}

main().catch(console.error);
