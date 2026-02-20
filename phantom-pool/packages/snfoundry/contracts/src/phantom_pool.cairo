// PhantomPool — Core dark pool contract.
//
// Responsibilities:
//   - Deposit Accumulator Tree: records wBTC arrivals at phantom entry addresses
//   - Condense: ZK-proven claim of phantom deposit into Tongo, deploying PhantomVault on-chain
//   - Order submission: stores Pedersen order commitments after ZK proof verification
//   - Match submission: relayer-submitted MatchCorrectnessProof binds two orders
//   - Settlement: forwards Tongo transfer proofs from both parties atomically
//   - Cancel: owner-only order cancellation

use starknet::ContractAddress;

// ---------------------------------------------------------------------------
// External interface: Garaga-generated UltraKeccakZK verifier (per circuit)
// ---------------------------------------------------------------------------
#[starknet::interface]
pub trait IGroth16VerifierBN254<TContractState> {
    fn verify_groth16_proof_bn254(
        self: @TContractState, full_proof_with_hints: Span<felt252>,
    ) -> Result<Span<u256>, felt252>;
}

// ---------------------------------------------------------------------------
// PhantomPool public interface
// ---------------------------------------------------------------------------
#[starknet::interface]
pub trait IPhantomPool<TContractState> {
    // --- Deposit accumulator ---
    fn record_deposit(
        ref self: TContractState,
        phantom_addr: ContractAddress,
        amount: u256,
        timestamp: u64,
        salt: felt252,
    );

    // --- Condense (Vapor Tokens: claim phantom deposit → Tongo) ---
    fn condense(
        ref self: TContractState,
        full_proof_with_hints: Span<felt252>,
        recipient: ContractAddress,
        denomination: u256,
        phantom_addr: ContractAddress,
        salt: felt252,
    );

    // --- Order lifecycle ---
    fn submit_order(ref self: TContractState, full_proof_with_hints: Span<felt252>);
    fn submit_match(ref self: TContractState, full_proof_with_hints: Span<felt252>);
    fn submit_settlement(
        ref self: TContractState,
        match_id: u64,
        seller_transfer_calldata: Span<felt252>,
        buyer_transfer_calldata: Span<felt252>,
    );
    fn cancel_order(ref self: TContractState, commitment: felt252);

    // --- View ---
    fn accumulator_root(self: @TContractState) -> felt252;
    fn next_leaf_index(self: @TContractState) -> u64;
    fn leaf_at(self: @TContractState, index: u64) -> felt252;
    fn is_nullifier_spent(self: @TContractState, nullifier: felt252) -> bool;
    fn order_status(self: @TContractState, commitment: felt252) -> u8;
    fn match_pair(self: @TContractState, match_id: u64) -> MatchedPair;
}

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

// Order status:
//   0 = Inactive (default / not submitted)
//   1 = Active
//   2 = Matched
//   3 = Settled
//   4 = Cancelled
#[derive(Drop, Serde, Copy, starknet::Store)]
pub struct OrderCommitment {
    pub trader: ContractAddress,
    pub timestamp: u64,
    pub status: u8,
    pub order_id: u64,
}

#[derive(Drop, Serde, Copy, starknet::Store)]
pub struct MatchedPair {
    pub buy_commitment: felt252,
    pub sell_commitment: felt252,
    pub settlement_commitment: felt252,
    pub settled: bool,
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MERKLE_DEPTH: u32 = 20; // 2^20 = 1 048 576 leaves

// Fixed denominations (satoshis). Must match Noir circuit constants.
const DENOM_TENTH: u256 = 10_000_000;    // 0.1 BTC
const DENOM_ONE: u256 = 100_000_000;     // 1 BTC
const DENOM_TEN: u256 = 1_000_000_000;  // 10 BTC

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------
#[starknet::contract]
pub mod PhantomPool {
    use core::num::traits::Zero;
    use core::poseidon::poseidon_hash_span;
    use openzeppelin_token::erc20::interface::{IERC20Dispatcher, IERC20DispatcherTrait};
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::SyscallResultTrait;
    use starknet::syscalls::deploy_syscall;
    use starknet::{
        ClassHash, ContractAddress, get_block_timestamp, get_caller_address,
        get_contract_address,
    };
    use super::{
        IGroth16VerifierBN254Dispatcher, IGroth16VerifierBN254DispatcherTrait,
        MatchedPair, OrderCommitment, DENOM_ONE, DENOM_TEN, DENOM_TENTH, MERKLE_DEPTH,
    };

    // -----------------------------------------------------------------------
    // Storage
    // -----------------------------------------------------------------------
    #[storage]
    struct Storage {
        // Verifier contracts (Garaga-generated, one per circuit)
        order_validity_verifier: ContractAddress,
        match_correctness_verifier: ContractAddress,
        condenser_verifier: ContractAddress,
        // Tongo token contracts
        tongo_wbtc: ContractAddress,
        tongo_usdc: ContractAddress,
        // Underlying wBTC ERC-20
        wbtc: ContractAddress,
        // PhantomVault class hash (for counterfactual deployment in condense)
        phantom_vault_class_hash: ClassHash,
        // --- Deposit accumulator tree (incremental Poseidon Merkle, depth 20) ---
        accumulator_root: felt252,
        next_leaf_index: u64,
        // One stored hash per tree level for incremental insertion
        filled_subtrees: Map<u32, felt252>,
        // Index → leaf hash (for off-chain proof generation)
        leaves: Map<u64, felt252>,
        // Prevents recording the same phantom address twice
        used_phantom_addrs: Map<ContractAddress, bool>,
        // --- Nullifier set (prevents double-claim on condense) ---
        spent_nullifiers: Map<felt252, bool>,
        // --- Order book ---
        order_commitments: Map<felt252, OrderCommitment>,
        order_counter: u64,
        // --- Match book ---
        matched_pairs: Map<u64, MatchedPair>,
        match_nonce: u64,
    }

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------
    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        DepositRecorded: DepositRecorded,
        Condensed: Condensed,
        OrderSubmitted: OrderSubmitted,
        MatchSubmitted: MatchSubmitted,
        SettlementExecuted: SettlementExecuted,
        OrderCancelled: OrderCancelled,
    }

    #[derive(Drop, starknet::Event)]
    pub struct DepositRecorded {
        #[key]
        pub phantom_addr: ContractAddress,
        pub amount: u256,
        pub timestamp: u64,
        pub leaf_index: u64,
        pub new_root: felt252,
    }

    #[derive(Drop, starknet::Event)]
    pub struct Condensed {
        #[key]
        pub phantom_addr: ContractAddress,
        pub recipient: ContractAddress,
        pub denomination: u256,
        pub nullifier: felt252,
    }

    #[derive(Drop, starknet::Event)]
    pub struct OrderSubmitted {
        #[key]
        pub commitment: felt252,
        pub trader: ContractAddress,
        pub trader_pubkey: felt252,
        pub order_id: u64,
    }

    #[derive(Drop, starknet::Event)]
    pub struct MatchSubmitted {
        #[key]
        pub match_id: u64,
        pub buy_commitment: felt252,
        pub sell_commitment: felt252,
        pub settlement_commitment: felt252,
    }

    #[derive(Drop, starknet::Event)]
    pub struct SettlementExecuted {
        #[key]
        pub match_id: u64,
    }

    #[derive(Drop, starknet::Event)]
    pub struct OrderCancelled {
        #[key]
        pub commitment: felt252,
        pub trader: ContractAddress,
    }

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------
    #[constructor]
    fn constructor(
        ref self: ContractState,
        order_validity_verifier: ContractAddress,
        match_correctness_verifier: ContractAddress,
        condenser_verifier: ContractAddress,
        tongo_wbtc: ContractAddress,
        tongo_usdc: ContractAddress,
        wbtc: ContractAddress,
        phantom_vault_class_hash: ClassHash,
    ) {
        self.order_validity_verifier.write(order_validity_verifier);
        self.match_correctness_verifier.write(match_correctness_verifier);
        self.condenser_verifier.write(condenser_verifier);
        self.tongo_wbtc.write(tongo_wbtc);
        self.tongo_usdc.write(tongo_usdc);
        self.wbtc.write(wbtc);
        self.phantom_vault_class_hash.write(phantom_vault_class_hash);

        // Initialise Merkle tree root to the zero-tree root (depth 20, zero leaf = 0)
        self.accumulator_root.write(_zero_tree_root());
        self.next_leaf_index.write(0);
    }

    // -----------------------------------------------------------------------
    // Public entrypoints
    // -----------------------------------------------------------------------
    #[abi(embed_v0)]
    impl PhantomPoolImpl of super::IPhantomPool<ContractState> {
        // -------------------------------------------------------------------
        // record_deposit
        //
        // Called from ANY fresh address after wBTC arrives at phantom_addr.
        // Security note: the salt↔address binding is enforced in condense()
        // via deploy_syscall (the address derived from salt+class_hash must
        // equal phantom_addr). Recording does not require deployment.
        // -------------------------------------------------------------------
        fn record_deposit(
            ref self: ContractState,
            phantom_addr: ContractAddress,
            amount: u256,
            timestamp: u64,
            salt: felt252,
        ) {
            // 1. Denomination gate
            _assert_valid_denomination(amount);

            // 2. Not already recorded
            assert(!self.used_phantom_addrs.read(phantom_addr), 'phantom addr already recorded');

            // 3. wBTC balance at phantom_addr lte amount
            let balance = IERC20Dispatcher { contract_address: self.wbtc.read() }
                .balance_of(phantom_addr);
            assert(balance >= amount, 'insufficient deposit balance');

            // 4. Mark address as used
            self.used_phantom_addrs.write(phantom_addr, true);

            // 5. Build leaf: Poseidon(salt, phantom_addr, amount.low, timestamp)
            //    Using amount.low (felt252-safe satoshi value, max ~21M BTC << 2^128)
            let leaf = poseidon_hash_span(
                array![salt, phantom_addr.into(), amount.low.into(), timestamp.into()].span(),
            );

            // 6. Insert leaf into the incremental Merkle tree
            let leaf_index = self.next_leaf_index.read();
            self.leaves.write(leaf_index, leaf);
            let new_root = _insert_leaf(ref self, leaf, leaf_index);

            self
                .emit(
                    DepositRecorded {
                        phantom_addr, amount, timestamp, leaf_index, new_root,
                    },
                );
        }

        // -------------------------------------------------------------------
        // condense
        //
        // ZK-proven claim: proves ownership of a phantom deposit in the
        // accumulator tree. Deploys the PhantomVault at phantom_addr,
        // pulls wBTC to recipient, then caller funds Tongo in a second tx.
        //
        // Public inputs from CondenseProof (in Noir declaration order):
        //   [0] accumulator_root
        //   [1] tongo_account_commitment
        //   [2] denomination (felt252 encoded as u256)
        //   [3] phantom_address_nullifier
        // -------------------------------------------------------------------
        fn condense(
            ref self: ContractState,
            full_proof_with_hints: Span<felt252>,
            recipient: ContractAddress,
            denomination: u256,
            phantom_addr: ContractAddress,
            salt: felt252,
        ) {
            // 1. Denomination gate (fail-fast before expensive proof verify)
            _assert_valid_denomination(denomination);

            // 2. Verify CondenseProof via Garaga verifier
            let verifier = IGroth16VerifierBN254Dispatcher {
                contract_address: self.condenser_verifier.read(),
            };
            let result = verifier.verify_groth16_proof_bn254(full_proof_with_hints);
            assert(result.is_ok(), 'condenser proof invalid');
            let public_inputs = result.unwrap();

            // 3. Check accumulator root matches current on-chain root
            let current_root: felt252 = self.accumulator_root.read();
            assert(*public_inputs.at(0) == current_root.into(), 'wrong accumulator root');

            // 4. Check denomination matches proof's public denomination
            assert(*public_inputs.at(2) == denomination.low.into(), 'denomination mismatch');

            // 5. Check nullifier not already spent
            let nullifier: felt252 = (*public_inputs.at(3)).try_into().unwrap();
            assert(!self.spent_nullifiers.read(nullifier), 'nullifier already spent');

            // 6. Record nullifier
            self.spent_nullifiers.write(nullifier, true);

            // 7. Deploy PhantomVault at the phantom address using the salt.
            //    Constructor args: [condenser (this contract), wbtc_addr]
            //    deploy_from_zero=true → deployer address = 0 (matches client computation)
            let mut vault_calldata: Array<felt252> = array![
                get_contract_address().into(), self.wbtc.read().into(),
            ];
            let (deployed_addr, _) = deploy_syscall(
                self.phantom_vault_class_hash.read(),
                salt,
                vault_calldata.span(),
                true, // deploy_from_zero
            )
                .unwrap_syscall();
            assert(deployed_addr == phantom_addr, 'phantom addr mismatch');

            // 8. PhantomVault constructor pre-approved this contract for max wBTC.
            //    Pull denomination from phantom vault to recipient.
            IERC20Dispatcher { contract_address: self.wbtc.read() }
                .transfer_from(phantom_addr, recipient, denomination);

            self.emit(Condensed { phantom_addr, recipient, denomination, nullifier });
        }

        // -------------------------------------------------------------------
        // submit_order
        //
        // Caller submits an OrderValidityProof. On-chain: stores the
        // commitment from public inputs bound to the caller's address.
        //
        // Public inputs from OrderValidityProof (Noir declaration order):
        //   [0] commitment
        //   [1] trader_tongo_pubkey
        // -------------------------------------------------------------------
        fn submit_order(ref self: ContractState, full_proof_with_hints: Span<felt252>) {
            // Verify proof
            let verifier = IGroth16VerifierBN254Dispatcher {
                contract_address: self.order_validity_verifier.read(),
            };
            let result = verifier.verify_groth16_proof_bn254(full_proof_with_hints);
            assert(result.is_ok(), 'order proof invalid');
            let public_inputs = result.unwrap();

            // Extract public inputs
            let commitment: felt252 = (*public_inputs.at(0)).try_into().unwrap();
            let trader_pubkey: felt252 = (*public_inputs.at(1)).try_into().unwrap();

            // Commitment must not already exist
            let existing = self.order_commitments.read(commitment);
            assert(existing.trader.is_zero(), 'commitment already exists');

            // Store order
            let order_id = self.order_counter.read();
            self
                .order_commitments
                .write(
                    commitment,
                    OrderCommitment {
                        trader: get_caller_address(),
                        timestamp: get_block_timestamp(),
                        status: 1, // Active
                        order_id,
                    },
                );
            self.order_counter.write(order_id + 1);

            self
                .emit(
                    OrderSubmitted {
                        commitment,
                        trader: get_caller_address(),
                        trader_pubkey,
                        order_id,
                    },
                );
        }

        // -------------------------------------------------------------------
        // submit_match
        //
        // Relayer submits a MatchCorrectnessProof. Binds two ACTIVE orders,
        // creates a MatchedPair record, marks both orders as Matched.
        //
        // Public inputs from MatchCorrectnessProof (Noir declaration order):
        //   [0] buy_commitment
        //   [1] sell_commitment
        //   [2] settlement_commitment
        // -------------------------------------------------------------------
        fn submit_match(ref self: ContractState, full_proof_with_hints: Span<felt252>) {
            // Verify proof
            let verifier = IGroth16VerifierBN254Dispatcher {
                contract_address: self.match_correctness_verifier.read(),
            };
            let result = verifier.verify_groth16_proof_bn254(full_proof_with_hints);
            assert(result.is_ok(), 'match proof invalid');
            let public_inputs = result.unwrap();

            // Extract public inputs
            let buy_c: felt252 = (*public_inputs.at(0)).try_into().unwrap();
            let sell_c: felt252 = (*public_inputs.at(1)).try_into().unwrap();
            let settlement_c: felt252 = (*public_inputs.at(2)).try_into().unwrap();

            // Both commitments must be ACTIVE
            let buy_order = self.order_commitments.read(buy_c);
            assert(!buy_order.trader.is_zero(), 'buy order not found');
            assert(buy_order.status == 1, 'buy order not active');

            let sell_order = self.order_commitments.read(sell_c);
            assert(!sell_order.trader.is_zero(), 'sell order not found');
            assert(sell_order.status == 1, 'sell order not active');

            // Record match
            let match_id = self.match_nonce.read();
            self
                .matched_pairs
                .write(
                    match_id,
                    MatchedPair {
                        buy_commitment: buy_c,
                        sell_commitment: sell_c,
                        settlement_commitment: settlement_c,
                        settled: false,
                    },
                );
            self.match_nonce.write(match_id + 1);

            // Mark both orders as Matched
            self
                .order_commitments
                .write(buy_c, OrderCommitment { status: 2, ..buy_order });
            self
                .order_commitments
                .write(sell_c, OrderCommitment { status: 2, ..sell_order });

            self
                .emit(
                    MatchSubmitted {
                        match_id,
                        buy_commitment: buy_c,
                        sell_commitment: sell_c,
                        settlement_commitment: settlement_c,
                    },
                );
        }

        // -------------------------------------------------------------------
        // submit_settlement
        //
        // Both parties provide pre-built Tongo transfer proofs. PhantomPool
        // forwards each to the respective Tongo contract atomically.
        // Tongo validates the ZK proof internally (no msg.sender restriction).
        //
        // seller_transfer_calldata: Tongo wBTC Transfer serialized as felt252 Span
        // buyer_transfer_calldata:  Tongo USDC Transfer serialized as felt252 Span
        // -------------------------------------------------------------------
        fn submit_settlement(
            ref self: ContractState,
            match_id: u64,
            seller_transfer_calldata: Span<felt252>,
            buyer_transfer_calldata: Span<felt252>,
        ) {
            let pair = self.matched_pairs.read(match_id);
            assert(pair.buy_commitment != 0, 'match not found');
            assert(!pair.settled, 'already settled');

            // Forward seller wBTC Tongo transfer
            starknet::syscalls::call_contract_syscall(
                self.tongo_wbtc.read(),
                selector!("transfer"),
                seller_transfer_calldata,
            )
                .unwrap_syscall();

            // Forward buyer USDC Tongo transfer
            starknet::syscalls::call_contract_syscall(
                self.tongo_usdc.read(),
                selector!("transfer"),
                buyer_transfer_calldata,
            )
                .unwrap_syscall();

            // Mark pair settled
            self.matched_pairs.write(match_id, MatchedPair { settled: true, ..pair });

            // Mark both orders settled
            let buy_order = self.order_commitments.read(pair.buy_commitment);
            let sell_order = self.order_commitments.read(pair.sell_commitment);
            self
                .order_commitments
                .write(pair.buy_commitment, OrderCommitment { status: 3, ..buy_order });
            self
                .order_commitments
                .write(pair.sell_commitment, OrderCommitment { status: 3, ..sell_order });

            self.emit(SettlementExecuted { match_id });
        }

        // -------------------------------------------------------------------
        // cancel_order  — only the original submitter can cancel
        // -------------------------------------------------------------------
        fn cancel_order(ref self: ContractState, commitment: felt252) {
            let order = self.order_commitments.read(commitment);
            assert(!order.trader.is_zero(), 'order not found');
            assert(order.trader == get_caller_address(), 'not order owner');
            assert(order.status == 1, 'order not active');

            self
                .order_commitments
                .write(commitment, OrderCommitment { status: 4, ..order });

            self.emit(OrderCancelled { commitment, trader: get_caller_address() });
        }

        // --- View ---
        fn accumulator_root(self: @ContractState) -> felt252 {
            self.accumulator_root.read()
        }

        fn next_leaf_index(self: @ContractState) -> u64 {
            self.next_leaf_index.read()
        }

        fn leaf_at(self: @ContractState, index: u64) -> felt252 {
            self.leaves.read(index)
        }

        fn is_nullifier_spent(self: @ContractState, nullifier: felt252) -> bool {
            self.spent_nullifiers.read(nullifier)
        }

        fn order_status(self: @ContractState, commitment: felt252) -> u8 {
            self.order_commitments.read(commitment).status
        }

        fn match_pair(self: @ContractState, match_id: u64) -> MatchedPair {
            self.matched_pairs.read(match_id)
        }
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    // Denomination gate — reverts if amount is not one of the three fixed values
    fn _assert_valid_denomination(amount: u256) {
        assert(
            amount == DENOM_TENTH || amount == DENOM_ONE || amount == DENOM_TEN,
            'invalid denomination',
        );
    }

    // Incremental Poseidon Merkle tree insertion.
    //
    // Algorithm: O(DEPTH) Poseidon hashes per insert.
    // Stores one "filled subtree" hash per level (left child when right is pending).
    // Returns the new root.
    fn _insert_leaf(ref self: ContractState, leaf: felt252, index: u64) -> felt252 {
        assert(index < 1_048_576, 'merkle tree full'); // 2^20

        let mut current = leaf;
        let mut current_index = index;
        let mut level: u32 = 0;

        loop {
            if level == MERKLE_DEPTH {
                break;
            }
            if current_index % 2 == 0 {
                // current is a left child: store it, use zero as right sibling
                self.filled_subtrees.write(level, current);
                let zero = _merkle_zero(level);
                current = poseidon_hash_span(array![current, zero].span());
            } else {
                // current is a right child: left sibling is already stored
                let left = self.filled_subtrees.read(level);
                current = poseidon_hash_span(array![left, current].span());
            }
            current_index /= 2;
            level += 1;
        };

        self.accumulator_root.write(current);
        self.next_leaf_index.write(index + 1);
        current
    }

    // Compute the zero value at a given Merkle level.
    // zero(0) = 0 (empty leaf)
    // zero(i) = Poseidon(zero(i-1), zero(i-1))
    // Called at most DEPTH times per insert — O(depth^2) total hashes, acceptable.
    fn _merkle_zero(level: u32) -> felt252 {
        let mut z: felt252 = 0;
        let mut i: u32 = 0;
        loop {
            if i == level {
                break;
            }
            z = poseidon_hash_span(array![z, z].span());
            i += 1;
        };
        z
    }

    // Zero-tree root for depth 20 (computed at constructor time).
    // Avoids re-computing it in every _merkle_zero call at insert time.
    fn _zero_tree_root() -> felt252 {
        let mut z: felt252 = 0;
        let mut i: u32 = 0;
        loop {
            if i == MERKLE_DEPTH {
                break;
            }
            z = poseidon_hash_span(array![z, z].span());
            i += 1;
        };
        z
    }
}
