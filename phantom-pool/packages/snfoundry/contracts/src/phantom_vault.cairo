// PhantomVault — minimal ERC-20 receiver for phantom entry points.
//
// Deployed counterfactually (class_hash + salt) at the phantom address.
// wBTC sits here after the Atomiq bridge delivery.
// On construction, immediately approves the condenser (PhantomPool) for
// the full u256::MAX amount, so PhantomPool can pull funds in `condense()`.
// No external functions — funds are locked until PhantomPool releases them.

use starknet::ContractAddress;

#[starknet::interface]
pub trait IPhantomVault<TContractState> {
    fn wbtc_address(self: @TContractState) -> ContractAddress;
    fn condenser_address(self: @TContractState) -> ContractAddress;
}

#[starknet::contract]
pub mod PhantomVault {
    use core::num::traits::Bounded;
    use openzeppelin_token::erc20::interface::{IERC20Dispatcher, IERC20DispatcherTrait};
    use starknet::ContractAddress;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};

    #[storage]
    struct Storage {
        condenser: ContractAddress,
        wbtc: ContractAddress,
    }

    #[constructor]
    fn constructor(ref self: ContractState, condenser: ContractAddress, wbtc: ContractAddress) {
        self.condenser.write(condenser);
        self.wbtc.write(wbtc);

        // Pre-approve condenser (PhantomPool) to pull all wBTC.
        // This is the only thing PhantomVault ever does.
        IERC20Dispatcher { contract_address: wbtc }.approve(condenser, Bounded::<u256>::MAX);
    }

    #[abi(embed_v0)]
    impl PhantomVaultImpl of super::IPhantomVault<ContractState> {
        fn wbtc_address(self: @ContractState) -> ContractAddress {
            self.wbtc.read()
        }

        fn condenser_address(self: @ContractState) -> ContractAddress {
            self.condenser.read()
        }
    }
}
