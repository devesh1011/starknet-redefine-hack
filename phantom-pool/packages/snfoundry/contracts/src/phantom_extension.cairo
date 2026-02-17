// PhantomExtension — Ekubo pool extension for Phantom Pool.
//
// Hooks into the Ekubo wBTC/USDC pool lifecycle to:
//   - Allow swaps originating from PhantomPool (already ZK-verified)
//   - Route unmatched orders to Ekubo at market price as fallback liquidity
//   - Block direct swaps that have not gone through PhantomPool's ZK proof system
//     (optional: configurable by owner — public mode allows normal Ekubo usage)
//
// DEPENDENCY NOTE: Add to Scarb.toml once Ekubo publishes their Cairo package:
//   ekubo = { git = "https://github.com/EkuboProtocol/core", ... }
// Until then, Ekubo types are defined locally matching their exact ABI shapes.
//
// Ekubo extension callback interface (from EkuboProtocol/starknet-contracts):
//   before_initialize  → returns ClassHash of next extension to call (0 = none)
//   after_initialize
//   before_swap        → returns ClassHash of next extension to call (0 = none)
//   after_swap
//   before_update_position → returns ClassHash
//   after_update_position

use starknet::ContractAddress;

// ---------------------------------------------------------------------------
// Ekubo type stubs (until ekubo package is available in Scarb)
// ---------------------------------------------------------------------------

// Identifies an Ekubo pool
#[derive(Drop, Serde, Copy)]
pub struct PoolKey {
    pub token0: ContractAddress,
    pub token1: ContractAddress,
    pub fee: u128,
    pub tick_spacing: u128,
    pub extension: ContractAddress,
}

// Swap direction and amount
#[derive(Drop, Serde, Copy)]
pub struct SwapParameters {
    pub amount: i129,
    pub is_token1: bool,
    pub sqrt_ratio_limit: u256,
    pub skip_ahead: u128,
}

// Signed 129-bit integer (Ekubo convention)
#[derive(Drop, Serde, Copy)]
pub struct i129 {
    pub mag: u128,
    pub sign: bool, // true = negative
}

// Token balance delta from a swap or position update
#[derive(Drop, Serde, Copy)]
pub struct Delta {
    pub amount0: i129,
    pub amount1: i129,
}

// Position update parameters
#[derive(Drop, Serde, Copy)]
pub struct UpdatePositionParameters {
    pub salt: u64,
    pub bounds: Bounds,
    pub liquidity_delta: i129,
}

#[derive(Drop, Serde, Copy)]
pub struct Bounds {
    pub lower: i129,
    pub upper: i129,
}

// ---------------------------------------------------------------------------
// IPhantomExtension — owner-facing interface
// ---------------------------------------------------------------------------
#[starknet::interface]
pub trait IPhantomExtension<TContractState> {
    fn set_open_access(ref self: TContractState, open: bool);
    fn is_open_access(self: @TContractState) -> bool;
    fn phantom_pool(self: @TContractState) -> ContractAddress;
    fn owner(self: @TContractState) -> ContractAddress;
    fn transfer_ownership(ref self: TContractState, new_owner: ContractAddress);
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------
#[starknet::contract]
pub mod PhantomExtension {
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ClassHash, ContractAddress, get_caller_address};
    use super::{Delta, PoolKey, SwapParameters, UpdatePositionParameters, i129};

    #[storage]
    struct Storage {
        owner: ContractAddress,
        phantom_pool: ContractAddress,
        // When true: any caller can swap (public fallback liquidity mode).
        // When false: only PhantomPool-originating swaps are allowed.
        open_access: bool,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        OwnershipTransferred: OwnershipTransferred,
        AccessModeChanged: AccessModeChanged,
    }

    #[derive(Drop, starknet::Event)]
    pub struct OwnershipTransferred {
        pub previous: ContractAddress,
        pub new_owner: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    pub struct AccessModeChanged {
        pub open: bool,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        owner: ContractAddress,
        phantom_pool: ContractAddress,
        open_access: bool,
    ) {
        self.owner.write(owner);
        self.phantom_pool.write(phantom_pool);
        self.open_access.write(open_access);
    }

    // -----------------------------------------------------------------------
    // Owner-facing interface
    // -----------------------------------------------------------------------
    #[abi(embed_v0)]
    impl PhantomExtensionImpl of super::IPhantomExtension<ContractState> {
        fn set_open_access(ref self: ContractState, open: bool) {
            assert(get_caller_address() == self.owner.read(), 'not owner');
            self.open_access.write(open);
            self.emit(AccessModeChanged { open });
        }

        fn is_open_access(self: @ContractState) -> bool {
            self.open_access.read()
        }

        fn phantom_pool(self: @ContractState) -> ContractAddress {
            self.phantom_pool.read()
        }

        fn owner(self: @ContractState) -> ContractAddress {
            self.owner.read()
        }

        fn transfer_ownership(ref self: ContractState, new_owner: ContractAddress) {
            let prev = self.owner.read();
            assert(get_caller_address() == prev, 'not owner');
            self.owner.write(new_owner);
            self.emit(OwnershipTransferred { previous: prev, new_owner });
        }
    }

    // -----------------------------------------------------------------------
    // Ekubo Extension callbacks
    //
    // Ekubo calls these during pool lifecycle. Each `before_*` returns a
    // ClassHash — returning 0 means "no chaining, stop here".
    // -----------------------------------------------------------------------
    #[external(v0)]
    fn before_initialize(
        ref self: ContractState,
        caller: ContractAddress,
        pool_key: PoolKey,
        initial_tick: i129,
    ) -> ClassHash {
        // Allow initialization from PhantomPool or owner only
        let allowed = caller == self.phantom_pool.read() || caller == self.owner.read();
        assert(allowed, 'only phantom pool can init');
        0.try_into().unwrap() // no chaining
    }

    #[external(v0)]
    fn after_initialize(
        ref self: ContractState,
        caller: ContractAddress,
        pool_key: PoolKey,
        initial_tick: i129,
    ) {}

    #[external(v0)]
    fn before_swap(
        ref self: ContractState,
        caller: ContractAddress,
        pool_key: PoolKey,
        params: SwapParameters,
    ) -> ClassHash {
        // In restricted mode, only PhantomPool may trigger swaps.
        // In open_access mode, any caller is allowed (public fallback liquidity).
        if !self.open_access.read() {
            assert(caller == self.phantom_pool.read(), 'only phantom pool can swap');
        }
        0.try_into().unwrap() // no chaining
    }

    #[external(v0)]
    fn after_swap(
        ref self: ContractState,
        caller: ContractAddress,
        pool_key: PoolKey,
        params: SwapParameters,
        delta: Delta,
    ) {
        // Price oracle update hook — can be used off-chain via event indexing.
        // Emitting a swap event here lets the relayer track reference price.
        // No on-chain state needed for MVP.
    }

    #[external(v0)]
    fn before_update_position(
        ref self: ContractState,
        caller: ContractAddress,
        pool_key: PoolKey,
        params: UpdatePositionParameters,
    ) -> ClassHash {
        // Allow liquidity provision from PhantomPool and owner (bootstrapping).
        // In open_access mode, anyone can provide liquidity.
        if !self.open_access.read() {
            assert(
                caller == self.phantom_pool.read() || caller == self.owner.read(),
                'lp restricted',
            );
        }
        0.try_into().unwrap()
    }

    #[external(v0)]
    fn after_update_position(
        ref self: ContractState,
        caller: ContractAddress,
        pool_key: PoolKey,
        params: UpdatePositionParameters,
        delta: Delta,
    ) {}
}
