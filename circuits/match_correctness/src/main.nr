// MatchCorrectnessProof
//
// Proves two orders cross (buy.price >= sell.price) and settlement terms
// are correctly derived without revealing prices or amounts on-chain.

fn main(
    buy_price: u64,
    buy_amount: u64,
    buy_nonce: Field,
    sell_price: u64,
    sell_amount: u64,
    sell_nonce: Field,
    settlement_amount: u64,
    settlement_price: u64,
    buy_commitment: pub Field,
    sell_commitment: pub Field,
    settlement_commitment: pub Field,
) {
    let expected_buy =
        dep::std::hash::pedersen_hash([0, buy_price as Field, buy_amount as Field, buy_nonce]);
    assert(buy_commitment == expected_buy, "buy commitment mismatch");

    let expected_sell =
        dep::std::hash::pedersen_hash([1, sell_price as Field, sell_amount as Field, sell_nonce]);
    assert(sell_commitment == expected_sell, "sell commitment mismatch");

    assert(buy_price >= sell_price, "orders do not cross");

    let min_amount = if buy_amount <= sell_amount {
        buy_amount
    } else {
        sell_amount
    };
    assert(settlement_amount == min_amount, "settlement amount must be minimum of both orders");
    assert(settlement_amount > 0, "zero settlement amount");

    assert(
        (buy_price as u128 + sell_price as u128) == (settlement_price as u128 * 2),
        "settlement price must be exact midpoint",
    );

    let expected_settlement =
        dep::std::hash::pedersen_hash([settlement_amount as Field, settlement_price as Field]);
    assert(settlement_commitment == expected_settlement, "settlement commitment mismatch");
}

#[test]
fn test_crossing_equal_amounts() {
    let buy_price: u64 = 9_680_000_000_000;
    let buy_amount: u64 = 10_000_000;
    let buy_nonce: Field = 0x111;
    let sell_price: u64 = 9_650_000_000_000;
    let sell_amount: u64 = 10_000_000;
    let sell_nonce: Field = 0x222;
    let settlement_amount: u64 = 10_000_000;
    let settlement_price: u64 = 9_665_000_000_000;
    let buy_commitment =
        dep::std::hash::pedersen_hash([0, buy_price as Field, buy_amount as Field, buy_nonce]);
    let sell_commitment =
        dep::std::hash::pedersen_hash([1, sell_price as Field, sell_amount as Field, sell_nonce]);
    let settlement_commitment =
        dep::std::hash::pedersen_hash([settlement_amount as Field, settlement_price as Field]);
    main(
        buy_price,
        buy_amount,
        buy_nonce,
        sell_price,
        sell_amount,
        sell_nonce,
        settlement_amount,
        settlement_price,
        buy_commitment,
        sell_commitment,
        settlement_commitment,
    );
}

#[test]
fn test_crossing_unequal_amounts_settlement_is_min() {
    let buy_price: u64 = 10_000_000_000_000;
    let buy_amount: u64 = 100_000_000;
    let buy_nonce: Field = 0xaaa;
    let sell_price: u64 = 9_900_000_000_000;
    let sell_amount: u64 = 10_000_000;
    let sell_nonce: Field = 0xbbb;
    let settlement_amount: u64 = 10_000_000;
    let settlement_price: u64 = 9_950_000_000_000;
    let buy_commitment =
        dep::std::hash::pedersen_hash([0, buy_price as Field, buy_amount as Field, buy_nonce]);
    let sell_commitment =
        dep::std::hash::pedersen_hash([1, sell_price as Field, sell_amount as Field, sell_nonce]);
    let settlement_commitment =
        dep::std::hash::pedersen_hash([settlement_amount as Field, settlement_price as Field]);
    main(
        buy_price,
        buy_amount,
        buy_nonce,
        sell_price,
        sell_amount,
        sell_nonce,
        settlement_amount,
        settlement_price,
        buy_commitment,
        sell_commitment,
        settlement_commitment,
    );
}

#[test(should_fail_with = "orders do not cross")]
fn test_non_crossing_orders_fail() {
    let buy_price: u64 = 9_500_000_000_000;
    let buy_amount: u64 = 10_000_000;
    let buy_nonce: Field = 0x333;
    let sell_price: u64 = 9_800_000_000_000;
    let sell_amount: u64 = 10_000_000;
    let sell_nonce: Field = 0x444;
    let settlement_amount: u64 = 10_000_000;
    let settlement_price: u64 = 9_650_000_000_000;
    let buy_commitment =
        dep::std::hash::pedersen_hash([0, buy_price as Field, buy_amount as Field, buy_nonce]);
    let sell_commitment =
        dep::std::hash::pedersen_hash([1, sell_price as Field, sell_amount as Field, sell_nonce]);
    let settlement_commitment =
        dep::std::hash::pedersen_hash([settlement_amount as Field, settlement_price as Field]);
    main(
        buy_price,
        buy_amount,
        buy_nonce,
        sell_price,
        sell_amount,
        sell_nonce,
        settlement_amount,
        settlement_price,
        buy_commitment,
        sell_commitment,
        settlement_commitment,
    );
}

#[test]
fn __print_values() {
    let buy_price: u64 = 9_680_000_000_000;
    let buy_amount: u64 = 10_000_000;
    let buy_nonce: Field = 0x111;
    let sell_price: u64 = 9_650_000_000_000;
    let sell_amount: u64 = 10_000_000;
    let sell_nonce: Field = 0x222;
    let settlement_amount: u64 = 10_000_000;
    let settlement_price: u64 = 9_665_000_000_000;
    let bc = dep::std::hash::pedersen_hash([0, buy_price as Field, buy_amount as Field, buy_nonce]);
    let sc =
        dep::std::hash::pedersen_hash([1, sell_price as Field, sell_amount as Field, sell_nonce]);
    let stc =
        dep::std::hash::pedersen_hash([settlement_amount as Field, settlement_price as Field]);
    println(f"buy_commitment={bc}");
    println(f"sell_commitment={sc}");
    println(f"settlement_commitment={stc}");
}
