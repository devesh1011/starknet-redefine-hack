// Tests for PhantomVault contract.
//
// PhantomVault stores condenser + wbtc addresses and pre-approves condenser
// for u256::MAX wBTC in its constructor. Tests use a local MockERC20 instead
// of the OZ ERC20 (which is not compiled into this package's artifacts).

use contracts::mock_erc20::{IMockERC20Dispatcher, IMockERC20DispatcherTrait};
use contracts::phantom_vault::{IPhantomVaultDispatcher, IPhantomVaultDispatcherTrait};
use core::num::traits::Bounded;
use openzeppelin_utils::serde::SerializedAppend;
use snforge_std::{ContractClassTrait, DeclareResultTrait, declare};
use starknet::ContractAddress;

// ---------------------------------------------------------------------------
// Test addresses
// ---------------------------------------------------------------------------
fn CONDENSER() -> ContractAddress {
    'condenser'.try_into().unwrap()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Deploy MockERC20 (no constructor args needed).
fn deploy_mock_erc20() -> ContractAddress {
    let cls = declare("MockERC20").unwrap().contract_class();
    let (addr, _) = cls.deploy(@array![]).unwrap();
    addr
}

fn deploy_vault(condenser: ContractAddress, wbtc: ContractAddress) -> IPhantomVaultDispatcher {
    let mut calldata: Array<felt252> = array![];
    calldata.append_serde(condenser);
    calldata.append_serde(wbtc);
    let cls = declare("PhantomVault").unwrap().contract_class();
    let (addr, _) = cls.deploy(@calldata).unwrap();
    IPhantomVaultDispatcher { contract_address: addr }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[test]
fn test_vault_stores_condenser_address() {
    let wbtc_addr = deploy_mock_erc20();
    let vault = deploy_vault(CONDENSER(), wbtc_addr);
    assert(vault.condenser_address() == CONDENSER(), 'wrong condenser');
}

#[test]
fn test_vault_stores_wbtc_address() {
    let wbtc_addr = deploy_mock_erc20();
    let vault = deploy_vault(CONDENSER(), wbtc_addr);
    assert(vault.wbtc_address() == wbtc_addr, 'wrong wbtc');
}

#[test]
fn test_vault_approves_condenser_for_max_wbtc() {
    // PhantomVault constructor calls wBTC.approve(condenser, u256::MAX).
    // Query MockERC20 allowance to confirm the approval was stored.
    let wbtc_addr = deploy_mock_erc20();
    let vault = deploy_vault(CONDENSER(), wbtc_addr);

    let erc20 = IMockERC20Dispatcher { contract_address: wbtc_addr };
    let allowance = erc20.allowance(vault.contract_address, CONDENSER());
    assert(allowance == Bounded::<u256>::MAX, 'condenser max approval needed');
}

#[test]
fn test_vault_does_not_approve_other_addresses() {
    let wbtc_addr = deploy_mock_erc20();
    let vault = deploy_vault(CONDENSER(), wbtc_addr);
    let other: ContractAddress = 'other'.try_into().unwrap();

    let erc20 = IMockERC20Dispatcher { contract_address: wbtc_addr };
    let allowance = erc20.allowance(vault.contract_address, other);
    assert(allowance == 0_u256, 'other has zero allowance');
}
