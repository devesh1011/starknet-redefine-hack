// Tests for PhantomPool contract.
//
// Uses snforge mock_call to:
//   - Mock wBTC ERC20 calls (balance_of, transfer_from)
//   - Mock the three Garaga verifier contracts to return controlled public inputs
//   - Mock Tongo transfer calls in settlement

use contracts::phantom_pool::{
    IPhantomPoolDispatcher, IPhantomPoolDispatcherTrait, MatchedPair,
};
use core::poseidon::poseidon_hash_span;
use openzeppelin_utils::serde::SerializedAppend;
use snforge_std::{
    CheatSpan, ContractClassTrait, DeclareResultTrait, cheat_caller_address, declare, mock_call,
};
use starknet::{ClassHash, ContractAddress};

// ---------------------------------------------------------------------------
// Fixed test addresses (felt252 shortstrings cast to ContractAddress)
// ---------------------------------------------------------------------------
fn VERIFIER_ORDER() -> ContractAddress {
    'ver_order'.try_into().unwrap()
}
fn VERIFIER_MATCH() -> ContractAddress {
    'ver_match'.try_into().unwrap()
}
fn VERIFIER_CONDENSER() -> ContractAddress {
    'ver_cond'.try_into().unwrap()
}
fn TONGO_WBTC() -> ContractAddress {
    'tongo_wbtc'.try_into().unwrap()
}
fn TONGO_USDC() -> ContractAddress {
    'tongo_usdc'.try_into().unwrap()
}
fn WBTC() -> ContractAddress {
    'wbtc'.try_into().unwrap()
}
fn PHANTOM() -> ContractAddress {
    'phantom'.try_into().unwrap()
}
fn PHANTOM2() -> ContractAddress {
    'phantom2'.try_into().unwrap()
}
fn TRADER() -> ContractAddress {
    'trader'.try_into().unwrap()
}
fn SELLER() -> ContractAddress {
    'seller'.try_into().unwrap()
}

// ---------------------------------------------------------------------------
// Constants matching PhantomPool
// ---------------------------------------------------------------------------
const DENOM_TENTH: u256 = 10_000_000;
const DENOM_ONE: u256 = 100_000_000;
const DENOM_TEN: u256 = 1_000_000_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn deploy_pool() -> IPhantomPoolDispatcher {
    let vault_cls = declare("PhantomVault").unwrap().contract_class();
    let vault_class_hash: ClassHash = *vault_cls.class_hash;

    let mut cd: Array<felt252> = array![];
    cd.append_serde(VERIFIER_ORDER());
    cd.append_serde(VERIFIER_MATCH());
    cd.append_serde(VERIFIER_CONDENSER());
    cd.append_serde(TONGO_WBTC());
    cd.append_serde(TONGO_USDC());
    cd.append_serde(WBTC());
    cd.append(vault_class_hash.into());

    let cls = declare("PhantomPool").unwrap().contract_class();
    let (addr, _) = cls.deploy(@cd).unwrap();
    IPhantomPoolDispatcher { contract_address: addr }
}

// Mock wBTC balance_of to return `amount` for one call
fn mock_balance(amount: u256) {
    mock_call(WBTC(), selector!("balance_of"), amount, 1_u32);
}

// Mock order verifier to return Ok([pub0, pub1])
fn mock_order_verifier_ok(pub0: u256, pub1: u256) {
    let r: Result<Array<u256>, felt252> = Result::Ok(array![pub0, pub1]);
    mock_call(
        VERIFIER_ORDER(), selector!("verify_groth16_proof_bn254"), r, 1_u32,
    );
}

// Mock match verifier to return Ok([buy_c, sell_c, settlement_c])
fn mock_match_verifier_ok(buy_c: u256, sell_c: u256, settlement_c: u256) {
    let r: Result<Array<u256>, felt252> = Result::Ok(array![buy_c, sell_c, settlement_c]);
    mock_call(
        VERIFIER_MATCH(), selector!("verify_groth16_proof_bn254"), r, 1_u32,
    );
}

// Mock order verifier to return Err
fn mock_order_verifier_fail() {
    let r: Result<Array<u256>, felt252> = Result::Err('proof_invalid');
    mock_call(
        VERIFIER_ORDER(), selector!("verify_groth16_proof_bn254"), r, 1_u32,
    );
}

// Mock match verifier to return Err
fn mock_match_verifier_fail() {
    let r: Result<Array<u256>, felt252> = Result::Err('proof_invalid');
    mock_call(
        VERIFIER_MATCH(), selector!("verify_groth16_proof_bn254"), r, 1_u32,
    );
}

// Submit one 1-BTC deposit to build pool state
fn record_one_deposit(pool: IPhantomPoolDispatcher, phantom: ContractAddress, salt: felt252) {
    mock_balance(DENOM_ONE);
    pool.record_deposit(phantom, DENOM_ONE, 1000_u64, salt);
}

// Submit two orders (buy + sell) without needing a real verifier
fn submit_two_orders(
    pool: IPhantomPoolDispatcher,
    buy_commitment: u256,
    sell_commitment: u256,
    pubkey: u256,
) {
    mock_order_verifier_ok(buy_commitment, pubkey);
    cheat_caller_address(pool.contract_address, TRADER(), CheatSpan::TargetCalls(1));
    pool.submit_order(array![].span());

    mock_order_verifier_ok(sell_commitment, pubkey);
    cheat_caller_address(pool.contract_address, SELLER(), CheatSpan::TargetCalls(1));
    pool.submit_order(array![].span());
}

// Expected leaf hash for a deposit (mirrors PhantomPool internal logic)
fn expected_leaf(salt: felt252, phantom: ContractAddress, amount: u256, timestamp: u64) -> felt252 {
    poseidon_hash_span(
        array![salt, phantom.into(), amount.low.into(), timestamp.into()].span(),
    )
}

// Compute the zero-tree root for depth 20 (mirrors _zero_tree_root in PhantomPool)
fn zero_tree_root() -> felt252 {
    let mut z: felt252 = 0;
    let mut i = 0_u32;
    loop {
        if i == 20 {
            break;
        }
        z = poseidon_hash_span(array![z, z].span());
        i += 1;
    };
    z
}

// ---------------------------------------------------------------------------
// Accumulator tree tests
// ---------------------------------------------------------------------------

#[test]
fn test_initial_root_is_zero_tree_root() {
    let pool = deploy_pool();
    assert(pool.accumulator_root() == zero_tree_root(), 'wrong initial root');
}

#[test]
fn test_initial_leaf_index_is_zero() {
    let pool = deploy_pool();
    assert(pool.next_leaf_index() == 0, 'index should start at 0');
}

#[test]
fn test_record_deposit_tenth_btc() {
    let pool = deploy_pool();
    mock_balance(DENOM_TENTH);
    pool.record_deposit(PHANTOM(), DENOM_TENTH, 500_u64, 'salt1');
    assert(pool.next_leaf_index() == 1, 'index should be 1');
}

#[test]
fn test_record_deposit_one_btc() {
    let pool = deploy_pool();
    mock_balance(DENOM_ONE);
    pool.record_deposit(PHANTOM(), DENOM_ONE, 500_u64, 'salt2');
    assert(pool.next_leaf_index() == 1, 'index should be 1');
}

#[test]
fn test_record_deposit_ten_btc() {
    let pool = deploy_pool();
    mock_balance(DENOM_TEN);
    pool.record_deposit(PHANTOM(), DENOM_TEN, 500_u64, 'salt3');
    assert(pool.next_leaf_index() == 1, 'index should be 1');
}

#[test]
fn test_record_deposit_stores_correct_leaf() {
    let pool = deploy_pool();
    let salt: felt252 = 'mysalt';
    let ts: u64 = 9999_u64;
    mock_balance(DENOM_ONE);
    pool.record_deposit(PHANTOM(), DENOM_ONE, ts, salt);

    let stored = pool.leaf_at(0);
    let expected = expected_leaf(salt, PHANTOM(), DENOM_ONE, ts);
    assert(stored == expected, 'leaf hash mismatch');
}

#[test]
fn test_record_deposit_changes_root() {
    let pool = deploy_pool();
    let initial_root = pool.accumulator_root();
    mock_balance(DENOM_ONE);
    pool.record_deposit(PHANTOM(), DENOM_ONE, 1_u64, 'salt');
    assert(pool.accumulator_root() != initial_root, 'root must change after deposit');
}

#[test]
fn test_record_two_deposits_increments_index() {
    let pool = deploy_pool();
    mock_balance(DENOM_ONE);
    pool.record_deposit(PHANTOM(), DENOM_ONE, 1_u64, 'salt_a');
    mock_balance(DENOM_ONE);
    pool.record_deposit(PHANTOM2(), DENOM_ONE, 2_u64, 'salt_b');
    assert(pool.next_leaf_index() == 2, 'index should be 2');
}

#[test]
#[should_panic(expected: ('invalid denomination',))]
fn test_record_deposit_invalid_denomination_panics() {
    let pool = deploy_pool();
    mock_balance(50_000_000_u256); // 0.5 BTC — not a valid denomination
    pool.record_deposit(PHANTOM(), 50_000_000_u256, 1_u64, 'salt');
}

#[test]
#[should_panic(expected: ('phantom addr already recorded',))]
fn test_record_deposit_duplicate_panics() {
    let pool = deploy_pool();
    // First deposit — succeeds
    mock_balance(DENOM_ONE);
    pool.record_deposit(PHANTOM(), DENOM_ONE, 1_u64, 'salt_x');
    // Second deposit with same phantom_addr — must fail
    mock_balance(DENOM_ONE);
    pool.record_deposit(PHANTOM(), DENOM_ONE, 2_u64, 'salt_x');
}

#[test]
#[should_panic(expected: ('insufficient deposit balance',))]
fn test_record_deposit_insufficient_balance_panics() {
    let pool = deploy_pool();
    // balance_of returns less than required amount
    mock_call(WBTC(), selector!("balance_of"), 0_u256, 1_u32);
    pool.record_deposit(PHANTOM(), DENOM_ONE, 1_u64, 'salt');
}

// ---------------------------------------------------------------------------
// Order submission tests
// ---------------------------------------------------------------------------

#[test]
fn test_submit_order_stores_active_status() {
    let pool = deploy_pool();
    let commitment: u256 = 0xABC_u256;
    let pubkey: u256 = 0xDEF_u256;
    mock_order_verifier_ok(commitment, pubkey);
    cheat_caller_address(pool.contract_address, TRADER(), CheatSpan::TargetCalls(1));

    pool.submit_order(array![].span());

    let commitment_felt: felt252 = commitment.try_into().unwrap();
    assert(pool.order_status(commitment_felt) == 1_u8, 'order should be active (1)');
}

#[test]
fn test_submit_order_initial_status_zero_for_unknown() {
    let pool = deploy_pool();
    assert(pool.order_status('nonexistent') == 0_u8, 'unknown order should be 0');
}

#[test]
#[should_panic(expected: ('order proof invalid',))]
fn test_submit_order_invalid_proof_panics() {
    let pool = deploy_pool();
    mock_order_verifier_fail();
    pool.submit_order(array![].span());
}

#[test]
#[should_panic(expected: ('commitment already exists',))]
fn test_submit_order_duplicate_commitment_panics() {
    let pool = deploy_pool();
    let commitment: u256 = 0xAAA_u256;
    let pubkey: u256 = 0xBBB_u256;

    // First submission
    mock_order_verifier_ok(commitment, pubkey);
    cheat_caller_address(pool.contract_address, TRADER(), CheatSpan::TargetCalls(1));
    pool.submit_order(array![].span());

    // Second submission with same commitment — must fail
    mock_order_verifier_ok(commitment, pubkey);
    cheat_caller_address(pool.contract_address, TRADER(), CheatSpan::TargetCalls(1));
    pool.submit_order(array![].span());
}

// ---------------------------------------------------------------------------
// Match submission tests
// ---------------------------------------------------------------------------

#[test]
fn test_submit_match_stores_pair_and_marks_orders_matched() {
    let pool = deploy_pool();
    let buy_c: u256 = 0x111_u256;
    let sell_c: u256 = 0x222_u256;
    let settlement_c: u256 = 0x333_u256;
    let pubkey: u256 = 0x444_u256;

    submit_two_orders(pool, buy_c, sell_c, pubkey);

    mock_match_verifier_ok(buy_c, sell_c, settlement_c);
    pool.submit_match(array![].span());

    let buy_felt: felt252 = buy_c.try_into().unwrap();
    let sell_felt: felt252 = sell_c.try_into().unwrap();
    let settlement_felt: felt252 = settlement_c.try_into().unwrap();

    // Both orders should now be Matched (status = 2)
    assert(pool.order_status(buy_felt) == 2_u8, 'buy order should be matched');
    assert(pool.order_status(sell_felt) == 2_u8, 'sell order should be matched');

    // Match pair recorded
    let pair: MatchedPair = pool.match_pair(0);
    assert(pair.buy_commitment == buy_felt, 'wrong buy commitment');
    assert(pair.sell_commitment == sell_felt, 'wrong sell commitment');
    assert(pair.settlement_commitment == settlement_felt, 'wrong settlement commitment');
    assert(!pair.settled, 'should not be settled yet');
}

#[test]
#[should_panic(expected: ('match proof invalid',))]
fn test_submit_match_invalid_proof_panics() {
    let pool = deploy_pool();
    let buy_c: u256 = 0x111_u256;
    let sell_c: u256 = 0x222_u256;
    let pubkey: u256 = 0x444_u256;

    submit_two_orders(pool, buy_c, sell_c, pubkey);

    mock_match_verifier_fail();
    pool.submit_match(array![].span());
}

#[test]
#[should_panic(expected: ('buy order not found',))]
fn test_submit_match_buy_order_not_found_panics() {
    let pool = deploy_pool();
    // Only submit sell order, no buy order
    let nonexistent_buy: u256 = 0x999_u256;
    let sell_c: u256 = 0x222_u256;
    let pubkey: u256 = 0x444_u256;
    mock_order_verifier_ok(sell_c, pubkey);
    cheat_caller_address(pool.contract_address, SELLER(), CheatSpan::TargetCalls(1));
    pool.submit_order(array![].span());

    mock_match_verifier_ok(nonexistent_buy, sell_c, 0x555_u256);
    pool.submit_match(array![].span());
}

#[test]
#[should_panic(expected: ('buy order not active',))]
fn test_submit_match_buy_order_not_active_panics() {
    let pool = deploy_pool();
    let buy_c: u256 = 0x111_u256;
    let sell_c: u256 = 0x222_u256;
    let sell_c2: u256 = 0x333_u256;
    let pubkey: u256 = 0x444_u256;

    // Match buy_c once — marks buy_c as Matched (status=2)
    submit_two_orders(pool, buy_c, sell_c, pubkey);
    mock_match_verifier_ok(buy_c, sell_c, 0x555_u256);
    pool.submit_match(array![].span());

    // Submit a fresh sell order
    mock_order_verifier_ok(sell_c2, pubkey);
    cheat_caller_address(pool.contract_address, SELLER(), CheatSpan::TargetCalls(1));
    pool.submit_order(array![].span());

    // Try to match buy_c again — buy_c is already Matched, must fail
    mock_match_verifier_ok(buy_c, sell_c2, 0x666_u256);
    pool.submit_match(array![].span());
}

// ---------------------------------------------------------------------------
// Settlement tests
// ---------------------------------------------------------------------------

#[test]
fn test_submit_settlement_marks_settled_and_updates_order_statuses() {
    let pool = deploy_pool();
    let buy_c: u256 = 0x111_u256;
    let sell_c: u256 = 0x222_u256;
    let settlement_c: u256 = 0x333_u256;
    let pubkey: u256 = 0x444_u256;

    // Setup: two orders + match
    submit_two_orders(pool, buy_c, sell_c, pubkey);
    mock_match_verifier_ok(buy_c, sell_c, settlement_c);
    pool.submit_match(array![].span());

    // Mock Tongo transfer calls to succeed
    mock_call(TONGO_WBTC(), selector!("transfer"), true, 1_u32);
    mock_call(TONGO_USDC(), selector!("transfer"), true, 1_u32);

    pool.submit_settlement(0_u64, array![].span(), array![].span());

    let buy_felt: felt252 = buy_c.try_into().unwrap();
    let sell_felt: felt252 = sell_c.try_into().unwrap();

    assert(pool.order_status(buy_felt) == 3_u8, 'buy should be settled (3)');
    assert(pool.order_status(sell_felt) == 3_u8, 'sell should be settled (3)');
    assert(pool.match_pair(0).settled, 'pair should be settled');
}

#[test]
#[should_panic(expected: ('match not found',))]
fn test_submit_settlement_nonexistent_match_panics() {
    let pool = deploy_pool();
    pool.submit_settlement(99_u64, array![].span(), array![].span());
}

#[test]
#[should_panic(expected: ('already settled',))]
fn test_submit_settlement_twice_panics() {
    let pool = deploy_pool();
    let buy_c: u256 = 0x111_u256;
    let sell_c: u256 = 0x222_u256;
    let pubkey: u256 = 0x444_u256;

    submit_two_orders(pool, buy_c, sell_c, pubkey);
    mock_match_verifier_ok(buy_c, sell_c, 0x333_u256);
    pool.submit_match(array![].span());

    mock_call(TONGO_WBTC(), selector!("transfer"), true, 1_u32);
    mock_call(TONGO_USDC(), selector!("transfer"), true, 1_u32);
    pool.submit_settlement(0_u64, array![].span(), array![].span());

    // Second settlement — must fail
    pool.submit_settlement(0_u64, array![].span(), array![].span());
}

// ---------------------------------------------------------------------------
// Cancel order tests
// ---------------------------------------------------------------------------

#[test]
fn test_cancel_order_by_owner_sets_cancelled_status() {
    let pool = deploy_pool();
    let commitment: u256 = 0xCAFE_u256;
    let pubkey: u256 = 0xBEEF_u256;

    mock_order_verifier_ok(commitment, pubkey);
    cheat_caller_address(pool.contract_address, TRADER(), CheatSpan::TargetCalls(1));
    pool.submit_order(array![].span());

    let commitment_felt: felt252 = commitment.try_into().unwrap();
    cheat_caller_address(pool.contract_address, TRADER(), CheatSpan::TargetCalls(1));
    pool.cancel_order(commitment_felt);

    assert(pool.order_status(commitment_felt) == 4_u8, 'order should be cancelled (4)');
}

#[test]
#[should_panic(expected: ('not order owner',))]
fn test_cancel_order_by_non_owner_panics() {
    let pool = deploy_pool();
    let commitment: u256 = 0xCAFE_u256;
    let pubkey: u256 = 0xBEEF_u256;

    mock_order_verifier_ok(commitment, pubkey);
    cheat_caller_address(pool.contract_address, TRADER(), CheatSpan::TargetCalls(1));
    pool.submit_order(array![].span());

    let commitment_felt: felt252 = commitment.try_into().unwrap();
    let other: ContractAddress = 'other'.try_into().unwrap();
    cheat_caller_address(pool.contract_address, other, CheatSpan::TargetCalls(1));
    pool.cancel_order(commitment_felt);
}

#[test]
#[should_panic(expected: ('order not found',))]
fn test_cancel_nonexistent_order_panics() {
    let pool = deploy_pool();
    pool.cancel_order('does_not_exist');
}

#[test]
#[should_panic(expected: ('order not active',))]
fn test_cancel_matched_order_panics() {
    let pool = deploy_pool();
    let buy_c: u256 = 0x111_u256;
    let sell_c: u256 = 0x222_u256;
    let pubkey: u256 = 0x444_u256;

    submit_two_orders(pool, buy_c, sell_c, pubkey);
    mock_match_verifier_ok(buy_c, sell_c, 0x333_u256);
    pool.submit_match(array![].span());

    // buy_c is now Matched (status=2), cannot cancel
    let buy_felt: felt252 = buy_c.try_into().unwrap();
    cheat_caller_address(pool.contract_address, TRADER(), CheatSpan::TargetCalls(1));
    pool.cancel_order(buy_felt);
}

// ---------------------------------------------------------------------------
// Nullifier tests
// ---------------------------------------------------------------------------

#[test]
fn test_nullifier_not_spent_initially() {
    let pool = deploy_pool();
    assert(!pool.is_nullifier_spent('some_nullifier'), 'nullifier must start unspent');
}
