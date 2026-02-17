// Tests for PhantomExtension contract.
//
// PhantomExtension is an Ekubo hook that gates swap/LP access to PhantomPool
// unless open_access mode is enabled by the owner.
//
// NOTE: Ekubo callbacks (before_swap, before_initialize, before_update_position)
// are declared as #[external(v0)] and receive the caller as an explicit parameter,
// NOT via get_caller_address(). They are exercised through a locally-defined
// IEkuboCallbacks interface.

use contracts::phantom_extension::{
    Bounds, IPhantomExtensionDispatcher, IPhantomExtensionDispatcherTrait, PoolKey,
    SwapParameters, UpdatePositionParameters, i129,
};
use openzeppelin_utils::serde::SerializedAppend;
use snforge_std::{CheatSpan, ContractClassTrait, DeclareResultTrait, cheat_caller_address, declare};
use starknet::{ClassHash, ContractAddress};

// ---------------------------------------------------------------------------
// Local interface bridging the #[external(v0)] Ekubo callbacks
// ---------------------------------------------------------------------------

#[starknet::interface]
trait IEkuboCallbacks<T> {
    fn before_initialize(
        ref self: T,
        caller: ContractAddress,
        pool_key: PoolKey,
        initial_tick: i129,
    ) -> ClassHash;
    fn before_swap(
        ref self: T,
        caller: ContractAddress,
        pool_key: PoolKey,
        params: SwapParameters,
    ) -> ClassHash;
    fn before_update_position(
        ref self: T,
        caller: ContractAddress,
        pool_key: PoolKey,
        params: UpdatePositionParameters,
    ) -> ClassHash;
}

// ---------------------------------------------------------------------------
// Dummy Ekubo type constructors
// ---------------------------------------------------------------------------

fn zero_i129() -> i129 {
    i129 { mag: 0, sign: false }
}

fn dummy_pool_key() -> PoolKey {
    PoolKey {
        token0: 0.try_into().unwrap(),
        token1: 0.try_into().unwrap(),
        fee: 0,
        tick_spacing: 0,
        extension: 0.try_into().unwrap(),
    }
}

fn dummy_swap_params() -> SwapParameters {
    SwapParameters {
        amount: zero_i129(),
        is_token1: false,
        sqrt_ratio_limit: 0_u256,
        skip_ahead: 0_u128,
    }
}

fn dummy_update_params() -> UpdatePositionParameters {
    let z = zero_i129();
    UpdatePositionParameters { salt: 0_u64, bounds: Bounds { lower: z, upper: z }, liquidity_delta: z }
}

// ---------------------------------------------------------------------------
// Fixed test addresses
// ---------------------------------------------------------------------------

fn OWNER() -> ContractAddress {
    'owner'.try_into().unwrap()
}
fn PHANTOM_POOL() -> ContractAddress {
    'phantom_pool'.try_into().unwrap()
}
fn STRANGER() -> ContractAddress {
    'stranger'.try_into().unwrap()
}

// ---------------------------------------------------------------------------
// Deploy helper — returns both owner-facing and Ekubo-callback dispatchers
// ---------------------------------------------------------------------------

fn deploy_extension(
    open_access: bool,
) -> (IPhantomExtensionDispatcher, IEkuboCallbacksDispatcher) {
    let mut cd: Array<felt252> = array![];
    cd.append_serde(OWNER());
    cd.append_serde(PHANTOM_POOL());
    cd.append_serde(open_access);

    let cls = declare("PhantomExtension").unwrap().contract_class();
    let (addr, _) = cls.deploy(@cd).unwrap();
    (
        IPhantomExtensionDispatcher { contract_address: addr },
        IEkuboCallbacksDispatcher { contract_address: addr },
    )
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

#[test]
fn test_initial_open_access_false() {
    let (ext, _) = deploy_extension(false);
    assert(!ext.is_open_access(), 'should default to closed');
}

#[test]
fn test_initial_open_access_true() {
    let (ext, _) = deploy_extension(true);
    assert(ext.is_open_access(), 'should default to open');
}

// ---------------------------------------------------------------------------
// Access-control tests
// ---------------------------------------------------------------------------

#[test]
fn test_owner_can_set_open_access_true() {
    let (ext, _) = deploy_extension(false);
    cheat_caller_address(ext.contract_address, OWNER(), CheatSpan::TargetCalls(1));
    ext.set_open_access(true);
    assert(ext.is_open_access(), 'should be open after set');
}

#[test]
fn test_owner_can_set_open_access_false() {
    let (ext, _) = deploy_extension(true);
    cheat_caller_address(ext.contract_address, OWNER(), CheatSpan::TargetCalls(1));
    ext.set_open_access(false);
    assert(!ext.is_open_access(), 'should be closed after set');
}

#[test]
#[should_panic(expected: ('not owner',))]
fn test_non_owner_cannot_set_open_access() {
    let (ext, _) = deploy_extension(false);
    cheat_caller_address(ext.contract_address, STRANGER(), CheatSpan::TargetCalls(1));
    ext.set_open_access(true);
}

// ---------------------------------------------------------------------------
// Ownership-transfer tests
// ---------------------------------------------------------------------------

#[test]
fn test_owner_can_transfer_ownership_and_new_owner_operates() {
    let (ext, _) = deploy_extension(false);
    cheat_caller_address(ext.contract_address, OWNER(), CheatSpan::TargetCalls(1));
    ext.transfer_ownership(STRANGER());
    cheat_caller_address(ext.contract_address, STRANGER(), CheatSpan::TargetCalls(1));
    ext.set_open_access(true);
    assert(ext.is_open_access(), 'new owner should work');
}

#[test]
fn test_owner_storage_updated_after_transfer() {
    let (ext, _) = deploy_extension(false);
    cheat_caller_address(ext.contract_address, OWNER(), CheatSpan::TargetCalls(1));
    ext.transfer_ownership(STRANGER());
    assert(ext.owner() == STRANGER(), 'owner should be stranger');
}

#[test]
#[should_panic(expected: ('not owner',))]
fn test_non_owner_cannot_transfer_ownership() {
    let (ext, _) = deploy_extension(false);
    cheat_caller_address(ext.contract_address, STRANGER(), CheatSpan::TargetCalls(1));
    ext.transfer_ownership(STRANGER());
}

// ---------------------------------------------------------------------------
// Pool initialise restriction tests
// ---------------------------------------------------------------------------

#[test]
fn test_before_initialize_allows_phantom_pool() {
    let (_, cbs) = deploy_extension(false);
    cbs.before_initialize(PHANTOM_POOL(), dummy_pool_key(), zero_i129());
}

#[test]
fn test_before_initialize_allows_owner() {
    let (_, cbs) = deploy_extension(false);
    cbs.before_initialize(OWNER(), dummy_pool_key(), zero_i129());
}

#[test]
#[should_panic(expected: ('only phantom pool can init',))]
fn test_before_initialize_blocks_stranger() {
    let (_, cbs) = deploy_extension(false);
    cbs.before_initialize(STRANGER(), dummy_pool_key(), zero_i129());
}

// ---------------------------------------------------------------------------
// Swap restriction tests
// ---------------------------------------------------------------------------

#[test]
fn test_before_swap_restricted_allows_phantom_pool() {
    let (_, cbs) = deploy_extension(false);
    cbs.before_swap(PHANTOM_POOL(), dummy_pool_key(), dummy_swap_params());
}

#[test]
#[should_panic(expected: ('only phantom pool can swap',))]
fn test_before_swap_restricted_blocks_stranger() {
    let (_, cbs) = deploy_extension(false);
    cbs.before_swap(STRANGER(), dummy_pool_key(), dummy_swap_params());
}

#[test]
#[should_panic(expected: ('only phantom pool can swap',))]
fn test_before_swap_restricted_blocks_owner() {
    // Owner cannot bypass the swap gate — only PhantomPool is permitted
    let (_, cbs) = deploy_extension(false);
    cbs.before_swap(OWNER(), dummy_pool_key(), dummy_swap_params());
}

#[test]
fn test_before_swap_open_allows_anyone() {
    let (_, cbs) = deploy_extension(true);
    cbs.before_swap(STRANGER(), dummy_pool_key(), dummy_swap_params());
}

// ---------------------------------------------------------------------------
// LP restriction tests
// ---------------------------------------------------------------------------

#[test]
fn test_before_update_position_allows_phantom_pool() {
    let (_, cbs) = deploy_extension(false);
    cbs.before_update_position(PHANTOM_POOL(), dummy_pool_key(), dummy_update_params());
}

#[test]
fn test_before_update_position_allows_owner() {
    let (_, cbs) = deploy_extension(false);
    cbs.before_update_position(OWNER(), dummy_pool_key(), dummy_update_params());
}

#[test]
#[should_panic(expected: ('lp restricted',))]
fn test_before_update_position_blocks_stranger() {
    let (_, cbs) = deploy_extension(false);
    cbs.before_update_position(STRANGER(), dummy_pool_key(), dummy_update_params());
}

#[test]
fn test_before_update_position_open_allows_anyone() {
    let (_, cbs) = deploy_extension(true);
    cbs.before_update_position(STRANGER(), dummy_pool_key(), dummy_update_params());
}
