// OrderValidityProof
//
// Proves an order is valid: correct commitment, sufficient balance,
// and the submitter owns the Tongo account -- without revealing price or amount.
//
// Public inputs published on-chain: commitment, trader_tongo_pubkey

fn main(
    price: u64,
    amount: u64,
    nonce: Field,
    direction: u8,
    tongo_balance: u64,
    user_secret: Field,
    commitment: pub Field,
    trader_tongo_pubkey: pub Field,
) {
    let expected_commitment =
        dep::std::hash::pedersen_hash([direction as Field, price as Field, amount as Field, nonce]);
    assert(commitment == expected_commitment, "commitment mismatch");
    assert(tongo_balance >= amount, "insufficient tongo balance");
    assert(amount > 0, "zero amount not allowed");
    let derived_pubkey = dep::std::hash::pedersen_hash([user_secret]);
    assert(derived_pubkey == trader_tongo_pubkey, "pubkey mismatch");
}

#[test]
fn test_valid_buy_order() {
    let price: u64 = 9_680_000_000_000;
    let amount: u64 = 10_000_000;
    let nonce: Field = 0x123456789abcdef;
    let direction: u8 = 0;
    let tongo_balance: u64 = 100_000_000;
    let user_secret: Field = 0xdeadbeefcafe;
    let commitment =
        dep::std::hash::pedersen_hash([direction as Field, price as Field, amount as Field, nonce]);
    let trader_tongo_pubkey = dep::std::hash::pedersen_hash([user_secret]);
    main(
        price,
        amount,
        nonce,
        direction,
        tongo_balance,
        user_secret,
        commitment,
        trader_tongo_pubkey,
    );
}

#[test]
fn test_valid_sell_order() {
    let price: u64 = 9_650_000_000_000;
    let amount: u64 = 100_000_000;
    let nonce: Field = 0xfeedface1337;
    let direction: u8 = 1;
    let tongo_balance: u64 = 200_000_000;
    let user_secret: Field = 0xcafebabedeadbeef;
    let commitment =
        dep::std::hash::pedersen_hash([direction as Field, price as Field, amount as Field, nonce]);
    let trader_tongo_pubkey = dep::std::hash::pedersen_hash([user_secret]);
    main(
        price,
        amount,
        nonce,
        direction,
        tongo_balance,
        user_secret,
        commitment,
        trader_tongo_pubkey,
    );
}

#[test(should_fail_with = "insufficient tongo balance")]
fn test_insufficient_balance_fails() {
    let price: u64 = 9_680_000_000_000;
    let amount: u64 = 100_000_000;
    let nonce: Field = 0xabc;
    let direction: u8 = 0;
    let tongo_balance: u64 = 10_000_000;
    let user_secret: Field = 0x999;
    let commitment =
        dep::std::hash::pedersen_hash([direction as Field, price as Field, amount as Field, nonce]);
    let trader_tongo_pubkey = dep::std::hash::pedersen_hash([user_secret]);
    main(
        price,
        amount,
        nonce,
        direction,
        tongo_balance,
        user_secret,
        commitment,
        trader_tongo_pubkey,
    );
}

#[test(should_fail_with = "commitment mismatch")]
fn test_wrong_commitment_fails() {
    let price: u64 = 9_680_000_000_000;
    let amount: u64 = 10_000_000;
    let nonce: Field = 0x123;
    let direction: u8 = 0;
    let tongo_balance: u64 = 100_000_000;
    let user_secret: Field = 0xdeadbeef;
    let wrong_commitment: Field = 0xbaddeadbeef;
    let trader_tongo_pubkey = dep::std::hash::pedersen_hash([user_secret]);
    main(
        price,
        amount,
        nonce,
        direction,
        tongo_balance,
        user_secret,
        wrong_commitment,
        trader_tongo_pubkey,
    );
}

#[test]
fn __print_values() {
    let price: u64 = 9_680_000_000_000;
    let amount: u64 = 10_000_000;
    let nonce: Field = 0x123456789abcdef;
    let direction: u8 = 0;
    let user_secret: Field = 0xdeadbeefcafe;
    let commitment =
        dep::std::hash::pedersen_hash([direction as Field, price as Field, amount as Field, nonce]);
    let pubkey = dep::std::hash::pedersen_hash([user_secret]);
    println(f"commitment={commitment}");
    println(f"trader_tongo_pubkey={pubkey}");
}
