mod merkle;

// Denomination values in satoshis (fixed shielded notes, Tornado Cash model)
global DENOM_TENTH: Field = 10_000_000; // 0.1 BTC
global DENOM_ONE: Field = 100_000_000; // 1.0 BTC
global DENOM_TEN: Field = 1_000_000_000; // 10.0 BTC

// Domain separators -- prevent cross-context hash collisions
global TONGO_COMMITMENT_DOMAIN: Field = 1;
global NULLIFIER_DOMAIN: Field = 2;

// CondenseProof
//
// Proves the claimer knows the secret (tongo_pubkey, r) that generated
// a phantom entry address recorded in the deposit accumulator tree,
// and claims that deposit into their Tongo account.
fn main(
    tongo_pubkey: Field,
    r: Field,
    phantom_addr: Field,
    amount: Field,
    deposit_timestamp: Field,
    merkle_siblings: [Field; 20],
    merkle_path_bits: [u1; 20],
    accumulator_root: pub Field,
    tongo_account_commitment: pub Field,
    denomination: pub Field,
    phantom_address_nullifier: pub Field,
) {
    let salt = dep::std::hash::pedersen_hash([tongo_pubkey, r]);
    let leaf = dep::std::hash::pedersen_hash([salt, phantom_addr, amount, deposit_timestamp]);

    merkle::verify_merkle_proof(leaf, merkle_siblings, merkle_path_bits, accumulator_root);

    let valid_denom = (amount == DENOM_TENTH) | (amount == DENOM_ONE) | (amount == DENOM_TEN);
    assert(valid_denom, "invalid denomination -- must be 0.1, 1, or 10 BTC");

    assert(denomination == amount, "denomination public input does not match private amount");

    let expected_commitment =
        dep::std::hash::pedersen_hash([tongo_pubkey, TONGO_COMMITMENT_DOMAIN]);
    assert(tongo_account_commitment == expected_commitment, "tongo account commitment mismatch");

    let expected_nullifier = dep::std::hash::pedersen_hash([tongo_pubkey, r, NULLIFIER_DOMAIN]);
    assert(phantom_address_nullifier == expected_nullifier, "nullifier mismatch");
}

// Helper: build a depth-20 Merkle tree with a single leaf at index 0
fn build_single_leaf_tree(leaf: Field) -> (Field, [Field; 20], [u1; 20]) {
    let zero_hash: Field = 0;
    let siblings: [Field; 20] = [0; 20];
    let path_bits: [u1; 20] = [0; 20];
    let mut current: Field = leaf;
    for _i in 0..20 {
        current = dep::std::hash::pedersen_hash([current, zero_hash]);
    }
    (current, siblings, path_bits)
}

#[test]
fn test_valid_condense_tenth_btc() {
    let tongo_pubkey: Field = 0xabcdef1234;
    let r: Field = 0xdeadbeefcafe11;
    let phantom_addr: Field = 0x1234567890abcdef;
    let amount: Field = DENOM_TENTH;
    let deposit_timestamp: Field = 1740000000;
    let salt = dep::std::hash::pedersen_hash([tongo_pubkey, r]);
    let leaf = dep::std::hash::pedersen_hash([salt, phantom_addr, amount, deposit_timestamp]);
    let (root, siblings, path_bits) = build_single_leaf_tree(leaf);
    let tongo_account_commitment =
        dep::std::hash::pedersen_hash([tongo_pubkey, TONGO_COMMITMENT_DOMAIN]);
    let phantom_address_nullifier =
        dep::std::hash::pedersen_hash([tongo_pubkey, r, NULLIFIER_DOMAIN]);
    main(
        tongo_pubkey,
        r,
        phantom_addr,
        amount,
        deposit_timestamp,
        siblings,
        path_bits,
        root,
        tongo_account_commitment,
        amount,
        phantom_address_nullifier,
    );
}

#[test]
fn test_valid_condense_one_btc() {
    let tongo_pubkey: Field = 0xfeedfacebeef;
    let r: Field = 0x999888777666;
    let phantom_addr: Field = 0xaabbccddeeff0011;
    let amount: Field = DENOM_ONE;
    let deposit_timestamp: Field = 1740100000;
    let salt = dep::std::hash::pedersen_hash([tongo_pubkey, r]);
    let leaf = dep::std::hash::pedersen_hash([salt, phantom_addr, amount, deposit_timestamp]);
    let (root, siblings, path_bits) = build_single_leaf_tree(leaf);
    let tongo_account_commitment =
        dep::std::hash::pedersen_hash([tongo_pubkey, TONGO_COMMITMENT_DOMAIN]);
    let phantom_address_nullifier =
        dep::std::hash::pedersen_hash([tongo_pubkey, r, NULLIFIER_DOMAIN]);
    main(
        tongo_pubkey,
        r,
        phantom_addr,
        amount,
        deposit_timestamp,
        siblings,
        path_bits,
        root,
        tongo_account_commitment,
        amount,
        phantom_address_nullifier,
    );
}

#[test(should_fail_with = "invalid denomination")]
fn test_invalid_denomination_fails() {
    let tongo_pubkey: Field = 0x111;
    let r: Field = 0x222;
    let phantom_addr: Field = 0x333;
    let amount: Field = 50_000_000;
    let deposit_timestamp: Field = 1740000000;
    let salt = dep::std::hash::pedersen_hash([tongo_pubkey, r]);
    let leaf = dep::std::hash::pedersen_hash([salt, phantom_addr, amount, deposit_timestamp]);
    let (root, siblings, path_bits) = build_single_leaf_tree(leaf);
    let tongo_account_commitment =
        dep::std::hash::pedersen_hash([tongo_pubkey, TONGO_COMMITMENT_DOMAIN]);
    let phantom_address_nullifier =
        dep::std::hash::pedersen_hash([tongo_pubkey, r, NULLIFIER_DOMAIN]);
    main(
        tongo_pubkey,
        r,
        phantom_addr,
        amount,
        deposit_timestamp,
        siblings,
        path_bits,
        root,
        tongo_account_commitment,
        amount,
        phantom_address_nullifier,
    );
}

#[test(should_fail_with = "merkle proof invalid")]
fn test_wrong_merkle_root_fails() {
    let tongo_pubkey: Field = 0x444;
    let r: Field = 0x555;
    let phantom_addr: Field = 0x666;
    let amount: Field = DENOM_TENTH;
    let deposit_timestamp: Field = 1740000000;
    let salt = dep::std::hash::pedersen_hash([tongo_pubkey, r]);
    let leaf = dep::std::hash::pedersen_hash([salt, phantom_addr, amount, deposit_timestamp]);
    let (_real_root, siblings, path_bits) = build_single_leaf_tree(leaf);
    let wrong_root: Field = 0xdeaddeaddead;
    let tongo_account_commitment =
        dep::std::hash::pedersen_hash([tongo_pubkey, TONGO_COMMITMENT_DOMAIN]);
    let phantom_address_nullifier =
        dep::std::hash::pedersen_hash([tongo_pubkey, r, NULLIFIER_DOMAIN]);
    main(
        tongo_pubkey,
        r,
        phantom_addr,
        amount,
        deposit_timestamp,
        siblings,
        path_bits,
        wrong_root,
        tongo_account_commitment,
        amount,
        phantom_address_nullifier,
    );
}

#[test]
fn __print_values() {
    let tongo_pubkey: Field = 0xabcdef1234;
    let r: Field = 0xdeadbeefcafe11;
    let phantom_addr: Field = 0x1234567890abcdef;
    let amount: Field = DENOM_TENTH;
    let deposit_timestamp: Field = 1740000000;
    let salt = dep::std::hash::pedersen_hash([tongo_pubkey, r]);
    let leaf = dep::std::hash::pedersen_hash([salt, phantom_addr, amount, deposit_timestamp]);
    let (root, _s, _p) = build_single_leaf_tree(leaf);
    let commitment = dep::std::hash::pedersen_hash([tongo_pubkey, TONGO_COMMITMENT_DOMAIN]);
    let nullifier = dep::std::hash::pedersen_hash([tongo_pubkey, r, NULLIFIER_DOMAIN]);
    println(f"accumulator_root={root}");
    println(f"tongo_account_commitment={commitment}");
    println(f"phantom_address_nullifier={nullifier}");
}
