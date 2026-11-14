# AGENTS.md

Notes for AI reviewers and coding agents. Human overview: [README.md](README.md).

## Do X, see Y

| Do | See |
|:-|:-|
| `cd contracts/near` then build the three crates and `cd sandbox-tests && cargo test -- --test-threads=4` (exact lines in the README) | `16 passed` (plus `4 passed` in `audit_poc.rs`) |
| `cd contracts/base && forge install … --no-git && forge test` | `9 tests passed` |
| `cd backend && bun install && bun test` with the env in README step 3 | `76 pass` |
| `cd tools && bun install && bun run check` | the MPC-signed hash `fb8f25f6…bfc5` twice, exit 0 |
| `cd web && bun install && bunx tsc --noEmit` | exit 0 |
| Read the live testnet case: `get_case` on `fw-fw-7ab26a.testnet` (curl in the README, "Try it in two minutes") | `"status":"Paid"`, `"claims":2` |

## Map

| Path | What it is |
|:-|:-|
| `contracts/near/contract/src/lib.rs` | The `fw` contract: commitments, bonds, cases, MPC calls, payouts |
| `contracts/near/contract/src/merkle.rs` | OZ-compatible Merkle leaves and proofs, EIP-191 signer recovery |
| `contracts/near/mock-signer/` | Test double for `v1.signer`: same method, args, deposit and yield/resume, signs with a known secp256k1 key |
| `contracts/near/sandbox-tests/tests/fair_warning.rs` | One test per security claim |
| `contracts/base/src/Announcer.sol` | Public notice board; `actionHash = keccak256(expected log)` |
| `contracts/base/src/DemoVault.sol` | UUPS vault whose owner key is the power being policed |
| `backend/src/lib/fw/mpcPayload.ts` | Independent borsh encoder of what the MPC network signs |
| `backend/src/workers/caseDriver.ts` | Mirrors live case state from `get_case`, then reports, defends, finalizes |
| `backend/src/workers/baseLogWatcher.ts` | Reads each watched chain's logs at its `safe` head, classifies admin logs as announced or breach |
| `backend/src/lib/fw/base.ts` | EVM clients per chain (the seven `v1.signer` reads), served chains, cursor ids |
| `backend/src/lib/fw/announcements.ts` | Announcements match on (Announcer, vault), not on one bond |
| `web/src/lib/api/fw.ts` | Typed client for every backend route the pages use |
| `web/src/components/fw/NoticeDial.tsx` | The live notice clock shared by the landing page, vault pages and the bond form |

## Invariants (each has a test)

1. A case pays out only if the MPC network signed the exact expected payload hash for the reported log.
2. A valid `Announce` log at least `notice_blocks` before the breach, and at most `max_announce_age_blocks`, defends the case.
3. The bond cannot leave before `withdrawal_notice` plus the finality grace, and never while a case is open. A pending withdrawal makes `is_covered` false.
4. A depositor claim needs the depositor's EIP-191 signature over `pay_to`; a relayer cannot redirect it, and a leaf pays once.
5. Payouts of a case never exceed that case's pool, whatever `root.total` the owner committed.
6. Every report leaves 0.01 NEAR with the contract for the storage it creates (559 bytes measured per full case).
7. Owner methods (`set_root`, `request_withdrawal`, `cancel_withdrawal`, `execute_withdrawal`) need exactly 1 yoctoNEAR, so only a full-access key can call them.
8. A commitment's chain is part of the MPC request; a signature for the same log on another chain cannot open a case.

## Conventions

- Contract: near-sdk 5.29.1, Rust 1.97.1 (pinned in `rust-toolchain.toml`), cargo-near 0.22.0. Events use the NEP-297 standard `fair_warning`, version `1.0.0`.
- Backend: config only in `src/config/main-config.ts`, errors through `src/utils/errorHandler.ts`, responses as `{ success, error, data }`, workers use an `isRunning` guard. See `backend/CLAUDE.md`.
- Web: TanStack Start file routes in `src/routes/`, shared pieces in `src/components/fw/`, integrations in `src/lib/` (API client, NEAR Connect, viem, Lenis, GSAP). Design tokens live in `src/styles.css`; `--light` is the only accent. See `web/CLAUDE.md`.
- Never commit `.env` files or keys. Never run destructive Prisma commands.
