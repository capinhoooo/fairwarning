# Fair Warning: Base contracts

- `src/Announcer.sol`: the protocol's public notice board. `announce(target, expectedLog)` emits `Announce(actionHash, target, expectedLog)` with `actionHash = keccak256(expectedLog)`, where `expectedLog` is the emitter address, topics and data of the log the admin action will emit. Helpers build it for `Upgraded`, `OwnershipTransferred` and `RoleGranted`.
- `src/DemoVault.sol`: a minimal USDC vault behind a UUPS proxy. Its owner key is the admin power Fair Warning polices. `DemoVaultV2` is the "new code" for the demo upgrade.
- `script/Deploy.s.sol`, `script/Actions.s.sol`: deploy, announce an upgrade, upgrade.

## Setup and test

Dependencies are installed from pinned tags (see `foundry.lock`), not committed:

```bash
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts@v5.7.0 OpenZeppelin/openzeppelin-contracts-upgradeable@v5.7.0 --no-git
forge test
```

Expected: 9 tests pass, including a 256-run fuzz test that an announced action hash equals the hash of the real upgrade log.

Toolchain: Foundry 1.8.3, solc 0.8.30, EVM `cancun`. RPC endpoints and the explorer key come from `BASE_RPC_URL`, `BASE_SEPOLIA_RPC_URL` and `ETHERSCAN_API_KEY` (see `foundry.toml`).
