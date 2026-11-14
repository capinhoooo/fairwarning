//! Fair Warning: a notice-or-pay bond on NEAR for admin actions on an EVM chain.
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_mpc_sdk::foreign_chain::evm::{EvmFinality, EvmLog, EvmTxId};
use near_mpc_sdk::foreign_chain::{
    ForeignChainRequestBuilder, ForeignChainSignatureVerifier, VerifyForeignTransactionRequestArgs,
    VerifyForeignTransactionResponse,
};
use near_mpc_sdk::near_mpc_contract_interface::types::{
    Hash160, Hash256, PublicKey as MpcPublicKey,
};
use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, Promise, PromiseError, PromiseOrValue,
};
use std::str::FromStr;

mod merkle;
pub use merkle::{eip191_signer, leaf_hash, verify_proof};

const FOREIGN_TX_DOMAIN: u64 = 3;
const MPC_GAS: Gas = Gas::from_tgas(15);
const CALLBACK_GAS: Gas = Gas::from_tgas(25);
const FT_GAS: Gas = Gas::from_tgas(10);
const STORAGE_GAS: Gas = Gas::from_tgas(5);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
// USDC on NEAR: storage_balance_bounds min = max = 0.00125 NEAR (mainnet view, 2026-10-26)
const FT_STORAGE: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
const COMMITMENT_STORAGE: NearToken = NearToken::from_millinear(50);
// Non-refundable part of every report: pays for the Case, its verified-log entry and the root copied at
// finalize (~570 bytes at 1e19 yocto/byte). Without it a rejected report is free and its storage is not.
const REPORT_STORAGE_FEE: NearToken = NearToken::from_millinear(10);
// Bounds on caller input (NEAR security checklist: bound inputs). Announce logs carry ~450 hex chars.
const MAX_LOG_DATA_HEX: usize = 8_194;
const MAX_PROOF_LEN: usize = 64;
// MPC yield timeout is 200 blocks; after this a stuck Reported case or defence can be cleared
const STUCK_AFTER: u64 = 250;
// Bond stays after the withdrawal notice until a breach from just before the notice ended can be proven:
// Base safe lags the tip by up to ~1 min, finalized by ~17 min (measured 2026-11-10); NEAR blocks ~0.57 s.
const WITHDRAW_GRACE_SAFE: u64 = 600;
const WITHDRAW_GRACE_FINALIZED: u64 = 3_000;
// keccak256("Announce(bytes32,address,bytes)")
const ANNOUNCE_TOPIC: [u8; 32] =
    hex_literal(b"ca1cdcd38b74c0372e7cd907ed543eb3e47f868a4f1f89ad553627c2b104601e");

#[ext_contract(ext_mpc)]
pub trait Mpc {
    fn verify_foreign_transaction(&mut self, request: VerifyForeignTransactionRequestArgs);
    fn public_key(&self, domain_id: Option<u64>) -> String;
}

#[ext_contract(ext_ft)]
pub trait Ft {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>);
}

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum Key {
    Commitments,
    Cases,
    Verified,
    Claimed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Finality {
    Safe,
    Finalized,
}

/// EVM chains `v1.signer` reads on mainnet and testnet (`get_available_foreign_chains`, 3.18.0).
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub enum EvmChain {
    #[default]
    Base,
    Arbitrum,
    Bnb,
    Polygon,
    Avalanche,
    HyperEvm,
    Abstract,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum CommitmentStatus {
    Committed,
    Breached,
    Closed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum CaseStatus {
    Reported,
    DefenceOpen,
    Defended,
    Breached,
    Paid,
    Rejected,
    Moot,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Root {
    pub root: String,
    pub total: U128,
    pub leaf_count: u32,
    pub snapshot_block: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct CommitmentParams {
    /// Chain the watched contracts live on; defaults to Base.
    #[serde(default)]
    pub chain: EvmChain,
    /// Lowercase 0x addresses whose admin logs are policed (the proxy).
    pub watched: Vec<String>,
    pub watched_topics: Vec<String>,
    pub announcer: String,
    pub notice_blocks: u64,
    pub max_announce_age_blocks: u64,
    pub effective_from_block: u64,
    pub finality: Finality,
    pub defence_window: u64,
    pub withdrawal_notice: u64,
    pub root_notice: u64,
    pub report_bond: NearToken,
    pub reward_bps: u16,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Commitment {
    pub owner: AccountId,
    pub params: CommitmentParams,
    pub bond: U128,
    pub root: Option<Root>,
    pub pending_root: Option<(Root, u64)>,
    pub withdrawal: Option<(U128, u64)>,
    pub open_cases: u32,
    pub status: CommitmentStatus,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Case {
    pub commitment_id: u32,
    pub reporter: AccountId,
    pub report_bond: NearToken,
    pub tx_hash: String,
    pub log_index: u64,
    pub breach_block: u64,
    pub action_hash: String,
    pub status: CaseStatus,
    pub deadline: u64,
    pub pending_defences: u32,
    pub reported_at: u64,
    pub last_defence_at: u64,
    pub root: Option<Root>,
    pub reward: U128,
    pub pool: U128,
    pub paid: U128,
    /// Depositor shares promised so far, including in-flight transfers; never exceeds `pool`.
    pub reserved: U128,
    pub claims: u32,
    pub reward_paid: bool,
}

/// One EVM log exactly as `eth_getTransactionReceipt` returns it.
#[near(serializers = [json])]
#[derive(Clone)]
pub struct LogInput {
    pub tx_hash: String,
    pub log_index: u64,
    pub transaction_index: u64,
    pub block_hash: String,
    pub block_number: u64,
    pub address: String,
    pub data: String,
    pub topics: Vec<String>,
}

#[near(event_json(standard = "fair_warning"))]
pub enum Event {
    #[event_version("1.0.0")]
    CommitmentCreated {
        commitment_id: u32,
        owner: AccountId,
    },
    #[event_version("1.0.0")]
    BondDeposited {
        commitment_id: u32,
        amount: U128,
        bond: U128,
    },
    #[event_version("1.0.0")]
    RootSet {
        commitment_id: u32,
        root: String,
        total: U128,
        active_at: u64,
    },
    #[event_version("1.0.0")]
    WithdrawalRequested {
        commitment_id: u32,
        amount: U128,
        available_at: u64,
    },
    #[event_version("1.0.0")]
    WithdrawalCancelled { commitment_id: u32 },
    #[event_version("1.0.0")]
    Withdrawn { commitment_id: u32, amount: U128 },
    #[event_version("1.0.0")]
    Reported {
        case_id: u64,
        commitment_id: u32,
        tx_hash: String,
        log_index: u64,
        reporter: AccountId,
    },
    #[event_version("1.0.0")]
    ReportRejected { case_id: u64, reason: String },
    #[event_version("1.0.0")]
    DefenceOpened {
        case_id: u64,
        breach_block: u64,
        action_hash: String,
        deadline: u64,
    },
    #[event_version("1.0.0")]
    DefenceSubmitted {
        case_id: u64,
        defender: AccountId,
        announce_block: u64,
    },
    #[event_version("1.0.0")]
    DefenceRejected { case_id: u64, defender: AccountId },
    #[event_version("1.0.0")]
    Defended {
        case_id: u64,
        defender: AccountId,
        announce_block: u64,
    },
    #[event_version("1.0.0")]
    Breached {
        case_id: u64,
        commitment_id: u32,
        reward: U128,
        pool: U128,
    },
    #[event_version("1.0.0")]
    Paid {
        case_id: u64,
        recipient: AccountId,
        amount: U128,
        kind: String,
    },
    #[event_version("1.0.0")]
    PayoutFailed {
        case_id: u64,
        recipient: AccountId,
        amount: U128,
        kind: String,
    },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct FairWarning {
    mpc: AccountId,
    usdc: AccountId,
    mpc_key: String,
    commitments: LookupMap<u32, Commitment>,
    cases: LookupMap<u64, Case>,
    verified: LookupMap<String, u64>,
    claimed: LookupMap<String, bool>,
    next_commitment: u32,
    next_case: u64,
}

#[near]
impl FairWarning {
    #[init]
    pub fn new(mpc: AccountId, usdc: AccountId, mpc_key: String) -> Self {
        parse_mpc_key(&mpc_key);
        Self {
            mpc,
            usdc,
            mpc_key,
            commitments: LookupMap::new(Key::Commitments),
            cases: LookupMap::new(Key::Cases),
            verified: LookupMap::new(Key::Verified),
            claimed: LookupMap::new(Key::Claimed),
            next_commitment: 0,
            next_case: 0,
        }
    }

    // ---- commitments ----

    #[payable]
    pub fn create_commitment(&mut self, params: CommitmentParams) -> u32 {
        require!(
            env::attached_deposit() >= COMMITMENT_STORAGE,
            "attach 0.05 NEAR for storage"
        );
        require!(
            !params.watched.is_empty() && params.watched.len() <= 4,
            "1 to 4 watched addresses"
        );
        require!(
            !params.watched_topics.is_empty() && params.watched_topics.len() <= 8,
            "1 to 8 topics"
        );
        params.watched.iter().for_each(|a| {
            addr20(a);
        });
        params.watched_topics.iter().for_each(|t| {
            h32(t);
        });
        addr20(&params.announcer);
        require!(
            params.notice_blocks > 0 && params.max_announce_age_blocks >= params.notice_blocks,
            "bad notice"
        );
        // must outlive one MPC yield (200 blocks) plus margin
        require!(params.defence_window >= 300, "defence_window >= 300 blocks");
        require!(
            params.withdrawal_notice >= params.defence_window,
            "withdrawal_notice >= defence_window"
        );
        // a root swap followed by a self-report moves the bond, so it needs the same notice as a withdrawal
        require!(
            params.root_notice >= withdrawal_delay(&params),
            "root_notice >= withdrawal_notice + finality grace"
        );
        require!(params.reward_bps <= 5_000, "reward_bps <= 5000");
        let id = self.next_commitment;
        self.next_commitment += 1;
        let owner = env::predecessor_account_id();
        self.commitments.insert(
            id,
            Commitment {
                owner: owner.clone(),
                params,
                bond: U128(0),
                root: None,
                pending_root: None,
                withdrawal: None,
                open_cases: 0,
                status: CommitmentStatus::Committed,
            },
        );
        Event::CommitmentCreated {
            commitment_id: id,
            owner,
        }
        .emit();
        id
    }

    // Owner methods take exactly 1 yocto so only a full-access key can call them, never a dapp's function-call key.
    #[payable]
    pub fn set_root(&mut self, commitment_id: u32, root: Root) {
        assert_one_yocto();
        let now = env::block_height();
        let c = self.commitment_mut(commitment_id);
        require!(env::predecessor_account_id() == c.owner, "owner only");
        require!(c.status == CommitmentStatus::Committed, "not active");
        h32(&root.root);
        require!(root.total.0 > 0 && root.leaf_count > 0, "empty root");
        let active_at = if c.root.is_none() {
            c.root = Some(root.clone());
            now
        } else {
            // max() also holds commitments created before root_notice was bounded to the withdrawal delay
            let at = now + c.params.root_notice.max(withdrawal_delay(&c.params));
            c.pending_root = Some((root.clone(), at));
            at
        };
        Event::RootSet {
            commitment_id,
            root: root.root,
            total: root.total,
            active_at,
        }
        .emit();
    }

    pub fn apply_root(&mut self, commitment_id: u32) {
        let now = env::block_height();
        let c = self.commitment_mut(commitment_id);
        let (root, at) = c.pending_root.clone().expect("no pending root");
        require!(
            now >= at && c.open_cases == 0,
            "root notice not over or case open"
        );
        c.root = Some(root);
        c.pending_root = None;
    }

    #[payable]
    pub fn request_withdrawal(&mut self, commitment_id: u32, amount: U128) {
        assert_one_yocto();
        let now = env::block_height();
        let c = self.commitment_mut(commitment_id);
        require!(env::predecessor_account_id() == c.owner, "owner only");
        require!(amount.0 > 0 && amount.0 <= c.bond.0, "bad amount");
        let at = now + withdrawal_delay(&c.params);
        c.withdrawal = Some((amount, at));
        Event::WithdrawalRequested {
            commitment_id,
            amount,
            available_at: at,
        }
        .emit();
    }

    #[payable]
    pub fn cancel_withdrawal(&mut self, commitment_id: u32) {
        assert_one_yocto();
        let c = self.commitment_mut(commitment_id);
        require!(env::predecessor_account_id() == c.owner, "owner only");
        require!(c.withdrawal.take().is_some(), "no withdrawal requested");
        Event::WithdrawalCancelled { commitment_id }.emit();
    }

    #[payable]
    pub fn execute_withdrawal(&mut self, commitment_id: u32) -> Promise {
        assert_one_yocto();
        let now = env::block_height();
        let usdc = self.usdc.clone();
        let c = self.commitment_mut(commitment_id);
        require!(env::predecessor_account_id() == c.owner, "owner only");
        require!(
            c.status == CommitmentStatus::Committed && c.open_cases == 0,
            "case open or not active"
        );
        let (amount, at) = c.withdrawal.take().expect("no withdrawal requested");
        require!(now >= at && amount.0 <= c.bond.0, "notice not over");
        c.bond = U128(c.bond.0 - amount.0);
        let owner = c.owner.clone();
        ext_ft::ext(usdc)
            .with_static_gas(FT_GAS)
            .with_attached_deposit(ONE_YOCTO)
            .ft_transfer(
                owner.clone(),
                amount,
                Some(format!("fw withdraw {commitment_id}")),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(FT_GAS)
                    .on_withdrawn(commitment_id, amount),
            )
    }

    #[private]
    pub fn on_withdrawn(
        &mut self,
        commitment_id: u32,
        amount: U128,
        #[callback_result] r: Result<(), PromiseError>,
    ) {
        let c = self.commitment_mut(commitment_id);
        if r.is_ok() {
            Event::Withdrawn {
                commitment_id,
                amount,
            }
            .emit();
        } else {
            c.bond = U128(c.bond.0 + amount.0);
        }
    }

    // ---- breach report ----

    /// Main path: our contract calls v1.signer and handles the response in a callback.
    #[payable]
    pub fn report(&mut self, commitment_id: u32, log: LogInput) -> Promise {
        let c = self
            .commitments
            .get(&commitment_id)
            .expect("no commitment")
            .clone();
        let (evm, action_hash) = self.check_breach(commitment_id, &c, &log);
        let (_, args) = build_request(&evm, c.params.chain, c.params.finality);
        let case_id = self.open_case(commitment_id, &c, &evm, action_hash);
        ext_mpc::ext(self.mpc.clone())
            .with_static_gas(MPC_GAS)
            .with_attached_deposit(ONE_YOCTO)
            .verify_foreign_transaction(args.clone())
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_breach_verified(
                        case_id,
                        hex::encode(args.expected_payload_hash.unwrap().0),
                    ),
            )
    }

    #[private]
    pub fn on_breach_verified(&mut self, case_id: u64, expected: String) -> bool {
        // a late answer for a case already expired, activated or rejected must not refund or reopen it
        if self
            .cases
            .get(&case_id)
            .is_none_or(|c| c.status != CaseStatus::Reported)
        {
            return false;
        }
        if mpc_confirmed(&expected) {
            return self.activate_case(case_id);
        }
        self.reject_case(case_id, "mpc did not confirm");
        false
    }

    /// Escape hatch if the callback itself failed (out of gas, redeploy): anyone can clear it.
    pub fn expire_report(&mut self, case_id: u64) {
        let case = self.cases.get(&case_id).expect("no case");
        require!(case.status == CaseStatus::Reported, "not pending");
        require!(
            env::block_height() > case.reported_at + STUCK_AFTER,
            "still within MPC timeout"
        );
        self.reject_case(case_id, "expired");
    }

    /// Fallback A: the reporter called v1.signer directly; we check the MPC signature ourselves.
    #[payable]
    pub fn report_verified(
        &mut self,
        commitment_id: u32,
        log: LogInput,
        response: VerifyForeignTransactionResponse,
    ) -> bool {
        let c = self
            .commitments
            .get(&commitment_id)
            .expect("no commitment")
            .clone();
        let (evm, action_hash) = self.check_breach(commitment_id, &c, &log);
        let (verifier, _) = build_request(&evm, c.params.chain, c.params.finality);
        self.require_mpc_signature(verifier, &response);
        let case_id = self.open_case(commitment_id, &c, &evm, action_hash);
        let ok = self.activate_case(case_id);
        require!(ok, "log already verified in another case");
        ok
    }

    // ---- defence ----

    pub fn defend(&mut self, case_id: u64, log: LogInput) -> Promise {
        let evm = self.check_defence(case_id, &log);
        let c = self
            .commitments
            .get(&self.cases.get(&case_id).unwrap().commitment_id)
            .unwrap()
            .clone();
        let (_, args) = build_request(&evm, c.params.chain, c.params.finality);
        let case = self.cases.get_mut(&case_id).unwrap();
        case.pending_defences += 1;
        case.last_defence_at = env::block_height();
        let defender = env::predecessor_account_id();
        Event::DefenceSubmitted {
            case_id,
            defender: defender.clone(),
            announce_block: evm.block_number,
        }
        .emit();
        ext_mpc::ext(self.mpc.clone())
            .with_static_gas(MPC_GAS)
            .with_attached_deposit(ONE_YOCTO)
            .verify_foreign_transaction(args.clone())
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_defence_verified(
                        case_id,
                        defender,
                        evm.block_number,
                        hex::encode(args.expected_payload_hash.unwrap().0),
                    ),
            )
    }

    #[private]
    pub fn on_defence_verified(
        &mut self,
        case_id: u64,
        defender: AccountId,
        announce_block: u64,
        expected: String,
    ) -> bool {
        let ok = mpc_confirmed(&expected);
        let case = self.cases.get_mut(&case_id).expect("no case");
        case.pending_defences = case.pending_defences.saturating_sub(1);
        // close_defended also requires DefenceOpen, so a late answer after finalize changes nothing
        if ok && case.status == CaseStatus::DefenceOpen {
            self.close_defended(case_id, defender, announce_block);
            return true;
        }
        Event::DefenceRejected { case_id, defender }.emit();
        false
    }

    /// Fallback A for the defence.
    pub fn defend_verified(
        &mut self,
        case_id: u64,
        log: LogInput,
        response: VerifyForeignTransactionResponse,
    ) {
        let evm = self.check_defence(case_id, &log);
        let c = self
            .commitments
            .get(&self.cases.get(&case_id).unwrap().commitment_id)
            .unwrap()
            .clone();
        let (verifier, _) = build_request(&evm, c.params.chain, c.params.finality);
        self.require_mpc_signature(verifier, &response);
        self.close_defended(case_id, env::predecessor_account_id(), evm.block_number);
    }

    /// Anyone, after the window, with no defence in flight.
    pub fn finalize(&mut self, case_id: u64) {
        let now = env::block_height();
        let case = self.cases.get(&case_id).expect("no case").clone();
        require!(case.status == CaseStatus::DefenceOpen, "not in defence");
        require!(now > case.deadline, "window open");
        // a defence started in time gets its MPC answer; a lost callback cannot block forever
        require!(
            case.pending_defences == 0 || now > case.last_defence_at + STUCK_AFTER,
            "defence pending"
        );
        self.release_case_slot(case.commitment_id);
        let c = self.commitments.get_mut(&case.commitment_id).unwrap();
        let case = self.cases.get_mut(&case_id).unwrap();
        // only the first breach takes the bond; later ones are moot
        if c.status != CommitmentStatus::Committed {
            case.status = CaseStatus::Moot;
            Promise::new(case.reporter.clone())
                .transfer(case.report_bond)
                .detach();
            return;
        }
        let bond = c.bond.0;
        let reward = bond * c.params.reward_bps as u128 / 10_000;
        c.bond = U128(0);
        c.withdrawal = None;
        c.status = CommitmentStatus::Breached;
        case.status = CaseStatus::Breached;
        case.reward = U128(reward);
        case.pool = U128(bond - reward);
        case.root = c.root.clone();
        Promise::new(case.reporter.clone())
            .transfer(case.report_bond)
            .detach();
        Event::Breached {
            case_id,
            commitment_id: case.commitment_id,
            reward: case.reward,
            pool: case.pool,
        }
        .emit();
    }

    // ---- payouts (pull, relayer-friendly) ----

    /// Pays the reporter's 10%. Anyone may trigger it; the caller funds USDC storage.
    #[payable]
    pub fn claim_reward(&mut self, case_id: u64) -> Promise {
        require!(
            env::attached_deposit() >= FT_STORAGE,
            "attach 0.00125 NEAR for USDC storage"
        );
        let case = self.cases.get_mut(&case_id).expect("no case");
        require!(
            case.status == CaseStatus::Breached && !case.reward_paid,
            "nothing to claim"
        );
        case.reward_paid = true;
        let (to, amount) = (case.reporter.clone(), case.reward);
        self.pay(case_id, to, amount, "reward".into(), None)
    }

    /// Depositor claim. `signature` is EIP-191 by `base_address` over `claim_message(...)`.
    #[payable]
    pub fn claim(
        &mut self,
        case_id: u64,
        base_address: String,
        amount: U128,
        proof: Vec<String>,
        pay_to: AccountId,
        signature: String,
    ) -> Promise {
        require!(
            env::attached_deposit() >= FT_STORAGE,
            "attach 0.00125 NEAR for USDC storage"
        );
        let case = self.cases.get(&case_id).expect("no case").clone();
        require!(case.status == CaseStatus::Breached, "case not breached");
        let root = case.root.clone().unwrap();
        require!(proof.len() <= MAX_PROOF_LEN, "proof too long");
        let addr = addr20(&base_address);
        let leaf = leaf_hash(&addr, amount.0);
        let proof: Vec<[u8; 32]> = proof.iter().map(|p| h32(p)).collect();
        require!(
            verify_proof(&proof, h32(&root.root), leaf),
            "bad merkle proof"
        );
        let msg = claim_message(&env::current_account_id(), case_id, &pay_to);
        require!(
            eip191_signer(msg.as_bytes(), &hex_bytes(&signature)) == Some(addr),
            "bad signature"
        );
        let key = format!("{case_id}:{}", hex::encode(leaf));
        require!(self.claimed.get(&key).is_none(), "already claimed");
        self.claimed.insert(key.clone(), true);
        let share = amount.0.checked_mul(case.pool.0).expect("overflow") / root.total.0;
        // The owner commits root.total; a total below the sum of leaves would pay out other commitments' bonds,
        // which share this contract's USDC balance.
        let reserved = case.reserved.0.checked_add(share).expect("overflow");
        require!(reserved <= case.pool.0, "claims exceed pool");
        let case = self.cases.get_mut(&case_id).unwrap();
        case.reserved = U128(reserved);
        case.claims += 1;
        self.pay(case_id, pay_to, U128(share), "depositor".into(), Some(key))
    }

    #[private]
    pub fn on_paid(
        &mut self,
        case_id: u64,
        to: AccountId,
        amount: U128,
        kind: String,
        claim_key: Option<String>,
        #[callback_result] r: Result<(), PromiseError>,
    ) {
        let case = self.cases.get_mut(&case_id).expect("no case");
        if r.is_ok() {
            case.paid = U128(case.paid.0.checked_add(amount.0).expect("overflow"));
            // Paid is terminal for claims, so set it only once nothing is left in flight that could fail
            if all_settled(case) {
                case.status = CaseStatus::Paid;
            }
            Event::Paid {
                case_id,
                recipient: to,
                amount,
                kind,
            }
            .emit();
            return;
        }
        // undo so the claim can be retried
        match &claim_key {
            Some(k) => {
                case.claims = case.claims.checked_sub(1).expect("claims underflow");
                case.reserved = U128(
                    case.reserved
                        .0
                        .checked_sub(amount.0)
                        .expect("reserved underflow"),
                );
                self.claimed.remove(k);
            }
            None => case.reward_paid = false,
        }
        Event::PayoutFailed {
            case_id,
            recipient: to,
            amount,
            kind,
        }
        .emit();
    }

    // ---- views ----

    /// True only when a breach today would pay out: active, bonded, depositor root set,
    /// no withdrawal and no root change pending.
    pub fn is_covered(&self, commitment_id: u32) -> bool {
        self.commitments.get(&commitment_id).is_some_and(|c| {
            c.status == CommitmentStatus::Committed
                && c.bond.0 > 0
                && c.root.is_some()
                && c.withdrawal.is_none()
                && c.pending_root.is_none()
        })
    }

    /// Exact deposit `report` and `report_verified` need: the commitment's report bond plus the storage fee.
    pub fn report_deposit(&self, commitment_id: u32) -> NearToken {
        required_report_deposit(self.commitments.get(&commitment_id).expect("no commitment"))
    }

    pub fn get_commitment(&self, commitment_id: u32) -> Option<Commitment> {
        self.commitments.get(&commitment_id).cloned()
    }

    pub fn get_case(&self, case_id: u64) -> Option<Case> {
        self.cases.get(&case_id).cloned()
    }

    /// Case that verified this log against this commitment, if any.
    pub fn case_for_log(&self, commitment_id: u32, tx_hash: String, log_index: u64) -> Option<u64> {
        self.verified_case(commitment_id, &h32(&tx_hash), log_index)
    }

    /// The exact args this contract sends to v1.signer; clients use it for fallback A.
    pub fn mpc_request_for(
        &self,
        log: LogInput,
        chain: Option<EvmChain>,
        finality: Finality,
    ) -> VerifyForeignTransactionRequestArgs {
        build_request(&to_evm_log(&log), chain.unwrap_or_default(), finality).1
    }

    pub fn claim_message_for(&self, case_id: u64, pay_to: AccountId) -> String {
        claim_message(&env::current_account_id(), case_id, &pay_to)
    }

    pub fn config(&self) -> (AccountId, AccountId, String, u32, u64) {
        (
            self.mpc.clone(),
            self.usdc.clone(),
            self.mpc_key.clone(),
            self.next_commitment,
            self.next_case,
        )
    }

    // ---- internals ----

    fn commitment_mut(&mut self, id: u32) -> &mut Commitment {
        self.commitments.get_mut(&id).expect("no commitment")
    }

    /// One case left the open set; an underflow means a case was closed twice.
    fn release_case_slot(&mut self, commitment_id: u32) {
        let c = self.commitment_mut(commitment_id);
        c.open_cases = c
            .open_cases
            .checked_sub(1)
            .unwrap_or_else(|| env::panic_str("open_cases underflow: case closed twice"));
    }

    /// Case that verified this log for this commitment. Entries written before the per-commitment key
    /// sit under the legacy global key and count only for the commitment of the case they point to.
    fn verified_case(&self, commitment_id: u32, tx: &[u8; 32], log_index: u64) -> Option<u64> {
        if let Some(id) = self.verified.get(&log_key(commitment_id, tx, log_index)) {
            return Some(*id);
        }
        self.verified
            .get(&legacy_log_key(tx, log_index))
            .copied()
            .filter(|id| {
                self.cases
                    .get(id)
                    .is_some_and(|c| c.commitment_id == commitment_id)
            })
    }

    fn check_breach(
        &self,
        commitment_id: u32,
        c: &Commitment,
        log: &LogInput,
    ) -> (EvmLog, [u8; 32]) {
        require!(
            c.status == CommitmentStatus::Committed,
            "commitment not active"
        );
        require!(c.bond.0 > 0 && c.root.is_some(), "no bond or root");
        require!(
            env::attached_deposit() >= required_report_deposit(c),
            "report bond too low: attach report_bond + 0.01 NEAR storage fee"
        );
        let evm = to_evm_log(log);
        require!(
            c.params.watched.iter().any(|a| addr20(a) == evm.address.0),
            "log not from a watched address"
        );
        let t0 = evm.topics.first().expect("no topics").0;
        require!(
            c.params.watched_topics.iter().any(|t| h32(t) == t0),
            "not a watched admin event"
        );
        require!(
            evm.block_number >= c.params.effective_from_block,
            "before coverage start"
        );
        require!(
            self.verified_case(commitment_id, &evm.transaction_hash.0, evm.log_index)
                .is_none(),
            "already verified"
        );
        let action = fingerprint(&evm);
        (evm, action)
    }

    fn check_defence(&self, case_id: u64, log: &LogInput) -> EvmLog {
        let case = self.cases.get(&case_id).expect("no case");
        require!(case.status == CaseStatus::DefenceOpen, "no open defence");
        require!(
            env::block_height() <= case.deadline,
            "defence window closed"
        );
        let c = self.commitments.get(&case.commitment_id).unwrap();
        let evm = to_evm_log(log);
        require!(
            evm.address.0 == addr20(&c.params.announcer),
            "not from the announcer"
        );
        require!(
            evm.topics.len() == 3 && evm.topics[0].0 == ANNOUNCE_TOPIC,
            "not an Announce log"
        );
        require!(
            hex::encode(evm.topics[1].0) == case.action_hash,
            "announced a different action"
        );
        // data is abi.encode(bytes expectedLog); topics[1] alone is whatever the announcer chose to emit
        let expected_log = abi_decode_bytes(&hex_bytes(&evm.data));
        require!(
            hex::encode(env::keccak256_array(&expected_log)) == case.action_hash,
            "announced log does not match the action"
        );
        // expectedLog hashes to the breach fingerprint, so its first 20 bytes are the breach emitter
        require!(expected_log.len() >= 20, "announced log too short");
        let mut target = [0u8; 32];
        target[12..].copy_from_slice(&expected_log[..20]);
        require!(
            evm.topics[2].0 == target,
            "announced for a different target"
        );
        let earliest = evm
            .block_number
            .checked_add(c.params.notice_blocks)
            .expect("overflow");
        require!(earliest <= case.breach_block, "notice too short");
        require!(
            case.breach_block - evm.block_number <= c.params.max_announce_age_blocks,
            "announcement too old"
        );
        evm
    }

    fn open_case(
        &mut self,
        commitment_id: u32,
        c: &Commitment,
        evm: &EvmLog,
        action: [u8; 32],
    ) -> u64 {
        let id = self.next_case;
        self.next_case += 1;
        let reporter = env::predecessor_account_id();
        let tx_hash = hex::encode(evm.transaction_hash.0);
        self.cases.insert(
            id,
            Case {
                commitment_id,
                reporter: reporter.clone(),
                // refundable part only; the storage fee stays with the contract
                report_bond: env::attached_deposit().saturating_sub(REPORT_STORAGE_FEE),
                tx_hash: tx_hash.clone(),
                log_index: evm.log_index,
                breach_block: evm.block_number,
                action_hash: hex::encode(action),
                status: CaseStatus::Reported,
                deadline: 0,
                pending_defences: 0,
                reported_at: env::block_height(),
                last_defence_at: 0,
                root: None,
                reward: U128(0),
                pool: U128(0),
                paid: U128(0),
                reserved: U128(0),
                claims: 0,
                reward_paid: false,
            },
        );
        self.commitment_mut(commitment_id).open_cases += 1;
        let _ = c;
        Event::Reported {
            case_id: id,
            commitment_id,
            tx_hash,
            log_index: evm.log_index,
            reporter,
        }
        .emit();
        id
    }

    /// Returns false (and refunds) if another case already verified the same log.
    fn activate_case(&mut self, case_id: u64) -> bool {
        let case = self.cases.get(&case_id).unwrap().clone();
        let tx = h32(&case.tx_hash);
        if self
            .verified_case(case.commitment_id, &tx, case.log_index)
            .is_some()
        {
            self.reject_case(case_id, "duplicate");
            return false;
        }
        self.verified
            .insert(log_key(case.commitment_id, &tx, case.log_index), case_id);
        let window = self
            .commitments
            .get(&case.commitment_id)
            .unwrap()
            .params
            .defence_window;
        let case = self.cases.get_mut(&case_id).unwrap();
        case.status = CaseStatus::DefenceOpen;
        case.deadline = env::block_height() + window;
        Event::DefenceOpened {
            case_id,
            breach_block: case.breach_block,
            action_hash: case.action_hash.clone(),
            deadline: case.deadline,
        }
        .emit();
        true
    }

    fn reject_case(&mut self, case_id: u64, reason: &str) {
        let case = self.cases.get_mut(&case_id).unwrap();
        case.status = CaseStatus::Rejected;
        let (reporter, bond, cid) = (case.reporter.clone(), case.report_bond, case.commitment_id);
        self.release_case_slot(cid);
        Promise::new(reporter).transfer(bond).detach();
        Event::ReportRejected {
            case_id,
            reason: reason.into(),
        }
        .emit();
    }

    fn close_defended(&mut self, case_id: u64, defender: AccountId, announce_block: u64) {
        let case = self.cases.get_mut(&case_id).unwrap();
        require!(case.status == CaseStatus::DefenceOpen, "not in defence");
        case.status = CaseStatus::Defended;
        let (bond, cid) = (case.report_bond, case.commitment_id);
        self.release_case_slot(cid);
        // the reporter's bond pays whoever proved the notice
        Promise::new(defender.clone()).transfer(bond).detach();
        Event::Defended {
            case_id,
            defender,
            announce_block,
        }
        .emit();
    }

    fn require_mpc_signature(
        &self,
        verifier: ForeignChainSignatureVerifier,
        resp: &VerifyForeignTransactionResponse,
    ) {
        let key = parse_mpc_key(&self.mpc_key);
        require!(
            verifier.verify_signature(resp, &key).is_ok(),
            "bad MPC signature or payload"
        );
    }

    fn pay(
        &mut self,
        case_id: u64,
        to: AccountId,
        amount: U128,
        kind: String,
        claim_key: Option<String>,
    ) -> Promise {
        let usdc = self.usdc.clone();
        ext_ft::ext(usdc.clone())
            .with_static_gas(STORAGE_GAS)
            .with_attached_deposit(FT_STORAGE)
            .storage_deposit(Some(to.clone()), Some(true))
            .then(
                ext_ft::ext(usdc)
                    .with_static_gas(FT_GAS)
                    .with_attached_deposit(ONE_YOCTO)
                    .ft_transfer(
                        to.clone(),
                        amount,
                        Some(format!("fw case {case_id} {kind}")),
                    ),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(FT_GAS)
                    .on_paid(case_id, to, amount, kind, claim_key),
            )
    }
}

#[near]
impl FungibleTokenReceiver for FairWarning {
    /// Bond top-up: USDC `ft_transfer_call` with msg `{"commitment_id": N}`.
    fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.usdc, "only USDC");
        #[near(serializers = [json])]
        struct Msg {
            commitment_id: u32,
        }
        let m: Msg =
            near_sdk::serde_json::from_str(&msg).expect("msg must be {\"commitment_id\":N}");
        let c = self.commitment_mut(m.commitment_id);
        require!(c.status == CommitmentStatus::Committed, "not active");
        c.bond = U128(c.bond.0 + amount.0);
        let bond = c.bond;
        let _ = sender_id;
        Event::BondDeposited {
            commitment_id: m.commitment_id,
            amount,
            bond,
        }
        .emit();
        PromiseOrValue::Value(U128(0))
    }
}

// ---- free functions ----

/// Reads v1.signer's answer without `#[callback_result]`, so a changed response shape cannot panic the callback.
fn mpc_confirmed(expected: &str) -> bool {
    // only a promise callback carries a result; reading index 0 otherwise aborts
    if env::promise_results_count() != 1 {
        return false;
    }
    let Ok(bytes) = env::promise_result_checked(0, 4096) else {
        return false;
    };
    let Ok(v) = near_sdk::serde_json::from_slice::<near_sdk::serde_json::Value>(&bytes) else {
        return false;
    };
    v.get("payload_hash").and_then(|h| h.as_str()) == Some(expected)
}

pub fn build_request(
    log: &EvmLog,
    chain: EvmChain,
    finality: Finality,
) -> (
    ForeignChainSignatureVerifier,
    VerifyForeignTransactionRequestArgs,
) {
    let f = match finality {
        Finality::Safe => EvmFinality::Safe,
        Finality::Finalized => EvmFinality::Finalized,
    };
    // each chain has its own builder type, so the shared tail is a macro
    macro_rules! evm {
        ($new:ident) => {
            ForeignChainRequestBuilder::$new()
                .with_tx_id(EvmTxId(log.transaction_hash.0))
                .with_finality(f)
                .with_expected_log(log.log_index, log.clone())
                .with_domain_id(FOREIGN_TX_DOMAIN)
                .build()
                .expect("build request")
        };
    }
    match chain {
        EvmChain::Base => evm!(new_base),
        EvmChain::Arbitrum => evm!(new_arbitrum),
        EvmChain::Bnb => evm!(new_bnb),
        EvmChain::Polygon => evm!(new_polygon),
        EvmChain::Avalanche => evm!(new_avalanche),
        EvmChain::HyperEvm => evm!(new_hyper_evm),
        EvmChain::Abstract => evm!(new_abstract),
    }
}

/// keccak256(emitter || topics || data): what `Announcer` commits to as `actionHash`.
pub fn fingerprint(log: &EvmLog) -> [u8; 32] {
    let mut buf = log.address.0.to_vec();
    log.topics.iter().for_each(|t| buf.extend_from_slice(&t.0));
    buf.extend(hex_bytes(&log.data));
    env::keccak256_array(&buf)
}

pub fn to_evm_log(l: &LogInput) -> EvmLog {
    require!(l.data.len() <= MAX_LOG_DATA_HEX, "log data too long");
    // the MPC signs the RPC's raw `data` string, so it must match byte for byte
    require!(
        l.data.starts_with("0x")
            && l.data.len().is_multiple_of(2)
            && l.data[2..]
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "data must be lowercase 0x hex"
    );
    require!(!l.topics.is_empty() && l.topics.len() <= 4, "1 to 4 topics");
    EvmLog {
        removed: false,
        log_index: l.log_index,
        transaction_index: l.transaction_index,
        transaction_hash: Hash256(h32(&l.tx_hash)),
        block_hash: Hash256(h32(&l.block_hash)),
        block_number: l.block_number,
        address: Hash160(addr20(&l.address)),
        data: l.data.clone(),
        topics: l.topics.iter().map(|t| Hash256(h32(t))).collect(),
    }
}

/// Every promised payout landed: the reward, and depositor shares for every leaf covering the pool
/// up to rounding dust (each share rounds down by under one unit).
fn all_settled(case: &Case) -> bool {
    let reward = if case.reward_paid { case.reward.0 } else { 0 };
    let leaves = case.root.as_ref().map_or(0, |r| r.leaf_count);
    let dust = case.pool.0.saturating_sub(case.reserved.0);
    (case.reward_paid || case.reward.0 == 0)
        && case.paid.0 == reward.saturating_add(case.reserved.0)
        && case.claims >= leaves
        && dust < u128::from(case.claims)
}

/// Decodes event data holding a single ABI `bytes` value, exactly as Solidity encodes it.
pub fn abi_decode_bytes(data: &[u8]) -> Vec<u8> {
    const BAD: &str = "announce data is not abi-encoded bytes";
    require!(data.len() >= 64, BAD);
    let word = |w: &[u8]| -> u64 {
        require!(w[..24].iter().all(|b| *b == 0), BAD);
        u64::from_be_bytes(w[24..32].try_into().expect("8 bytes"))
    };
    require!(word(&data[..32]) == 32, BAD);
    let body = &data[64..];
    let len = word(&data[32..64]);
    require!(len <= body.len() as u64, BAD);
    let len = len as usize;
    require!(
        body.len() == len.div_ceil(32) * 32 && body[len..].iter().all(|b| *b == 0),
        BAD
    );
    body[..len].to_vec()
}

/// Blocks from a withdrawal request until the bond can leave: notice plus the finality grace.
fn withdrawal_delay(p: &CommitmentParams) -> u64 {
    let grace = match p.finality {
        Finality::Safe => WITHDRAW_GRACE_SAFE,
        Finality::Finalized => WITHDRAW_GRACE_FINALIZED,
    };
    p.withdrawal_notice.saturating_add(grace)
}

fn required_report_deposit(c: &Commitment) -> NearToken {
    c.params
        .report_bond
        .checked_add(REPORT_STORAGE_FEE)
        .expect("overflow")
}

pub fn claim_message(contract: &AccountId, case_id: u64, pay_to: &AccountId) -> String {
    format!("Fair Warning claim\ncontract: {contract}\ncase: {case_id}\npay_to: {pay_to}")
}

/// `verified` key: a log can open one case per commitment, so one bond cannot shield another.
fn log_key(commitment_id: u32, tx: &[u8; 32], log_index: u64) -> String {
    format!("{commitment_id}:{}:{log_index}", hex::encode(tx))
}

/// Pre-upgrade key format. Cannot collide with `log_key`: its first `:` comes after 64 hex chars.
fn legacy_log_key(tx: &[u8; 32], log_index: u64) -> String {
    format!("{}:{log_index}", hex::encode(tx))
}

fn parse_mpc_key(s: &str) -> MpcPublicKey {
    let key = MpcPublicKey::from_str(s).unwrap_or_else(|_| env::panic_str("bad MPC key"));
    require!(
        matches!(key, MpcPublicKey::Secp256k1(_)),
        "MPC key must be secp256k1"
    );
    key
}

pub fn hex_bytes(s: &str) -> Vec<u8> {
    hex::decode(s.trim_start_matches("0x")).unwrap_or_else(|_| env::panic_str("bad hex"))
}

pub fn h32(s: &str) -> [u8; 32] {
    hex_bytes(s)
        .try_into()
        .unwrap_or_else(|_| env::panic_str("expected 32 bytes"))
}

pub fn addr20(s: &str) -> [u8; 20] {
    hex_bytes(s)
        .try_into()
        .unwrap_or_else(|_| env::panic_str("expected 20-byte address"))
}

const fn hex_literal(s: &[u8; 64]) -> [u8; 32] {
    const fn nib(c: u8) -> u8 {
        match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' => c - b'a' + 10,
            _ => panic!("hex"),
        }
    }
    let mut out = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        out[i] = (nib(s[2 * i]) << 4) | nib(s[2 * i + 1]);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn breached(reward: u128, pool: u128, leaves: u32) -> Case {
        Case {
            commitment_id: 0,
            reporter: "r.near".parse().expect("account"),
            report_bond: NearToken::from_yoctonear(0),
            tx_hash: String::new(),
            log_index: 0,
            breach_block: 0,
            action_hash: String::new(),
            status: CaseStatus::Breached,
            deadline: 0,
            pending_defences: 0,
            reported_at: 0,
            last_defence_at: 0,
            root: Some(Root {
                root: String::new(),
                total: U128(100),
                leaf_count: leaves,
                snapshot_block: 0,
            }),
            reward: U128(reward),
            pool: U128(pool),
            paid: U128(0),
            reserved: U128(0),
            claims: 0,
            reward_paid: false,
        }
    }

    #[test]
    fn paid_waits_for_in_flight_payouts() {
        let mut c = breached(50, 450, 2);
        // both depositors settled, reward requested but still in flight
        c.reserved = U128(450);
        c.claims = 2;
        c.paid = U128(450);
        c.reward_paid = true;
        assert!(!all_settled(&c));
        c.paid = U128(500);
        assert!(all_settled(&c));
        // reward settled, second depositor still in flight
        c.paid = U128(320);
        assert!(!all_settled(&c));
    }

    #[test]
    fn paid_needs_every_leaf_and_allows_only_dust() {
        let mut c = breached(0, 1000, 3);
        // shares 500 and 499 settled, a 1-unit leaf unclaimed
        c.reserved = U128(999);
        c.paid = U128(999);
        c.claims = 2;
        assert!(!all_settled(&c));
        // three floors lose at most 2 units together
        c.claims = 3;
        c.reserved = U128(998);
        c.paid = U128(998);
        assert!(all_settled(&c));
    }

    #[test]
    fn abi_bytes_round_trip_and_strictness() {
        let payload = [7u8; 84];
        let mut data = vec![0u8; 31];
        data.push(32);
        data.extend([0u8; 31]);
        data.push(84);
        data.extend(payload);
        data.extend([0u8; 12]);
        assert_eq!(abi_decode_bytes(&data), payload.to_vec());
        let mut dirty = data.clone();
        *dirty.last_mut().expect("non-empty") = 1;
        assert!(std::panic::catch_unwind(|| abi_decode_bytes(&dirty)).is_err());
        assert!(std::panic::catch_unwind(|| abi_decode_bytes(&data[..data.len() - 32])).is_err());
    }
}
