# Phantom Pool — Private BTC Dark Pool DEX on Starknet

A fully private dark pool DEX architected as a ZK-based order matching system for BTC with ElGamal-encrypted balances and trustless Bitcoin bridging.

**Key Features:**

- 🔐 **Order Privacy**: Price and amount never visible on-chain — enforced via ZK-proven order commitments
- 👻 **Phantom Entry Points**: Deposit BTC with no on-chain link between sender and trading account
- 🤝 **Encrypted Settlement**: All matched trades settled through Tongo's homomorphic ElGamal encryption — amounts remain hidden on-chain
- ✅ **Soundness Proven**: Every match verified via Circom + Garaga ZK verifiers deployed on-chain
- 🔗 **Trustless BTC Bridge**: Starknet Light Client — security derives entirely from Bitcoin PoW

**Stack:**

- Smart Contracts: Cairo 2.x (Scarb)
- Testing: Starknet Foundry (snforge) — 50/50 tests passing
- Privacy Layer: Tongo SDK (ElGamal encrypted balances)
- ZK Circuits: Noir + Barretenberg UltraHonk (in progress)
- Frontends: Next.js + Starknet.js

**Monorepo Structure:** `packages/snfoundry` (contracts + tests) | `packages/nextjs` (UI)

## Prerequisites

- [Node ≥ v22](https://nodejs.org/)
- [Yarn](https://yarnpkg.com/)
- [asdf](https://asdf-vm.com/) for version management
- [Starkup](https://github.com/software-mansion/starkup) (all Starknet tools)

## Quick Start

```bash
# Install dependencies
yarn install

# Run devnet in one terminal
yarn chain

# Deploy contracts in another terminal
yarn deploy

# Start frontend in a third terminal
yarn start
```

Visit `http://localhost:3000` to interact with the pool.

## Project Structure

```
packages/
├── snfoundry/          # Cairo contracts + snforge tests (50/50 passing)
│   ├── contracts/src/
│   │   ├── phantom_pool.cairo      # Core pool + accumulator tree
│   │   ├── phantom_vault.cairo     # Phantom entry point receiver
│   │   ├── phantom_extension.cairo # Ekubo extension
│   │   └── mock_wbtc.cairo        # Test token
│   └── scripts-ts/                # Deployment scripts
└── nextjs/              # Frontend UI
```

## Key Contracts

- **PhantomPool**: Order submission, matching, settlement
- **PhantomVault**: Minimal receiver at phantom entry addresses (counterfactual deployment)
- **PhantomExtension**: Ekubo pool hook for ZK-verified swaps

## Commands

| Command        | Purpose                         |
| -------------- | ------------------------------- |
| `yarn test`    | Run 50 snforge tests            |
| `yarn compile` | Compile Cairo contracts         |
| `yarn chain`   | Start local devnet              |
| `yarn deploy`  | Deploy to network               |
| `yarn start`   | Start frontend (localhost:3000) |

## Core Flow

1. **Deposit**: wBTC → Phantom Entry Point (counterfactual address, no link to trader)
2. **Condense**: ZK proof claims deposit into Tongo-wBTC (encrypted balance)
3. **Order**: Submit order commitment (price & amount hidden)
4. **Match**: Relayer proves buy.price ≥ sell.price via ZK verifier
5. **Settle**: Matched trades exchanged via Tongo transfers (amounts encrypted)

## Technical Details

See [technical-details.md](./technical-details.md) for full architecture, ZK circuit specs, and protocol design.

## Status

- ✅ 50/50 snforge tests passing
- ✅ All Cairo contracts written & tested
- 🚧 Noir circuit integration (in progress)
- 🚧 Frontend UI (in progress)
