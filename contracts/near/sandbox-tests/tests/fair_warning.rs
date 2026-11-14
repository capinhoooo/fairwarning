//! near-workspaces sandbox tests: every state transition and security claim in the README table.
use k256::ecdsa::SigningKey;
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};
use sha3::{Digest, Keccak256};

const UPGRADED: &str = "bc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b";
const ANNOUNCE: &str = "ca1cdcd38b74c0372e7cd907ed543eb3e47f868a4f1f89ad553627c2b104601e";
const PROXY: &str = "1111111111111111111111111111111111111111";
const ANNOUNCER: &str = "2222222222222222222222222222222222222222";
const NEW_IMPL: &str = "3333333333333333333333333333333333333333";
const BREACH_BLOCK: u64 = 1_000;
const NOTICE: u64 = 30;
const BOND: u128 = 500_000_000; // 500 USDC
const STORAGE: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
// report_bond 0.5 NEAR + the contract's 0.01 NEAR non-refundable storage fee
const REPORT_DEPOSIT: NearToken = NearToken::from_millinear(510);
const STORAGE_BYTE_COST: u128 = 10_000_000_000_000_000_000;

fn keccak(b: &[u8]) -> [u8; 32] {
    Keccak256::digest(b).into()
}
fn pad(addr: &str) -> String {
    format!("{:0>64}", addr)
}
fn evm_address(k: &SigningKey) -> [u8; 20] {
    let p = k.verifying_key().to_encoded_point(false);
    keccak(&p.as_bytes()[1..])[12..].try_into().unwrap()
}
fn eip191(k: &SigningKey, msg: &str) -> String {
    let mut m = format!("\x19Ethereum Signed Message:\n{}", msg.len()).into_bytes();
    m.extend_from_slice(msg.as_bytes());
    let (sig, rec) = k.sign_prehash_recoverable(&keccak(&m)).unwrap();
    let mut out = sig.to_bytes().to_vec();
    out.push(27 + rec.to_byte());
    hex::encode(out)
}
fn leaf(addr: &[u8; 20], amount: u128) -> [u8; 32] {
    let mut enc = [0u8; 64];
    enc[12..32].copy_from_slice(addr);
    enc[48..].copy_from_slice(&amount.to_be_bytes());
    keccak(&keccak(&enc))
}
fn node(a: [u8; 32], b: [u8; 32]) -> [u8; 32] {
    let (x, y) = if a <= b { (a, b) } else { (b, a) };
    keccak(&[x, y].concat())
}

/// Plays the MPC network: signs sha256(borsh(payload)) the contract asked for.
fn mpc_response(mpc: &SigningKey, payload_hash: &str) -> Value {
    let h = hex::decode(payload_hash).unwrap();
    let (sig, rec) = mpc.sign_prehash_recoverable(&h).unwrap();
    let b = sig.to_bytes();
    let mut big_r = vec![0x02 | (rec.to_byte() & 1)];
    big_r.extend_from_slice(&b[..32]);
    json!({"payload_hash": payload_hash, "signature": {"scheme": "Secp256k1",
        "big_r": {"affine_point": hex::encode(big_r)}, "s": {"scalar": hex::encode(&b[32..])},
        "recovery_id": rec.to_byte()}})
}

fn breach_log(tx_seed: u8) -> Value {
    json!({"tx_hash": hex::encode([tx_seed; 32]), "log_index": 7, "transaction_index": 2,
        "block_hash": hex::encode([0xbb; 32]), "block_number": BREACH_BLOCK, "address": PROXY,
        "data": "0x", "topics": [UPGRADED, pad(NEW_IMPL)]})
}
/// Announcer's expectedLog for the breach: emitter ++ topics ++ data.
fn expected_log(new_impl: &str) -> Vec<u8> {
    let mut b = hex::decode(PROXY).unwrap();
    b.extend(hex::decode(UPGRADED).unwrap());
    b.extend(hex::decode(pad(new_impl)).unwrap());
    b
}
fn action_hash() -> String {
    hex::encode(keccak(&expected_log(NEW_IMPL)))
}
/// Event data for one non-indexed `bytes` argument, as Solidity's abi.encode lays it out.
fn abi_bytes(b: &[u8]) -> String {
    let mut out = format!("0x{:064x}{:064x}{}", 32, b.len(), hex::encode(b));
    out.push_str(&"00".repeat(b.len().div_ceil(32) * 32 - b.len()));
    out
}
fn announce_log(block: u64, action: &str) -> Value {
    json!({"tx_hash": hex::encode([0xaa; 32]), "log_index": 0, "transaction_index": 0,
        "block_hash": hex::encode([0xcc; 32]), "block_number": block, "address": ANNOUNCER,
        "data": abi_bytes(&expected_log(NEW_IMPL)), "topics": [ANNOUNCE, action, pad(PROXY)]})
}

struct Env {
    worker: Worker<Sandbox>,
    fw: Contract,
    usdc: Contract,
    signer: Contract,
    mpc_key: SigningKey,
    protocol: Account,
    reporter: Account,
    defender: Account,
    alice: Account,
    bob: Account,
    alice_evm: SigningKey,
    bob_evm: SigningKey,
    proofs: (String, String),
}

fn wasm(name: &str) -> Vec<u8> {
    std::fs::read(format!("../target/near/{name}/{name}.wasm")).expect("run cargo near build first")
}

async fn setup() -> anyhow::Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    let mpc_key = SigningKey::from_bytes(&[7u8; 32].into())?;
    let pk = mpc_key.verifying_key().to_encoded_point(false);
    let mpc_key_str = format!(
        "secp256k1:{}",
        bs58::encode(&pk.as_bytes()[1..]).into_string()
    );

    let signer = worker.dev_deploy(&wasm("mock_signer")).await?;
    signer
        .call("new")
        .args_json(json!({"key": mpc_key_str}))
        .transact()
        .await?
        .into_result()?;
    let usdc = worker.dev_deploy(&wasm("mock_ft")).await?;
    let root = worker.root_account()?;
    let mk = |n: &'static str| {
        let r = root.clone();
        async move {
            r.create_subaccount(n)
                .initial_balance(NearToken::from_near(20))
                .transact()
                .await
                .unwrap()
                .into_result()
                .unwrap()
        }
    };
    let (protocol, reporter, defender, alice, bob) = (
        mk("protocol").await,
        mk("reporter").await,
        mk("defender").await,
        mk("alice").await,
        mk("bob").await,
    );
    usdc.call("new_default_meta")
        .args_json(json!({"owner_id": protocol.id(), "total_supply": "1000000000000"}))
        .transact()
        .await?
        .into_result()?;
    let fw = worker.dev_deploy(&wasm("fair_warning")).await?;
    fw.call("new")
        .args_json(json!({"mpc": signer.id(), "usdc": usdc.id(), "mpc_key": mpc_key_str}))
        .transact()
        .await?
        .into_result()?;
    usdc.call("storage_deposit")
        .args_json(json!({"account_id": fw.id()}))
        .deposit(STORAGE)
        .transact()
        .await?
        .into_result()?;

    let params = json!({"watched": [PROXY], "watched_topics": [UPGRADED], "announcer": ANNOUNCER,
        "notice_blocks": NOTICE, "max_announce_age_blocks": 500, "effective_from_block": 100,
        "finality": "Safe", "defence_window": 300, "withdrawal_notice": 400, "root_notice": 1000,
        "report_bond": NearToken::from_millinear(500), "reward_bps": 1000});
    protocol
        .call(fw.id(), "create_commitment")
        .args_json(json!({"params": params}))
        .deposit(NearToken::from_millinear(50))
        .transact()
        .await?
        .into_result()?;

    let alice_evm = SigningKey::from_bytes(&[1u8; 32].into())?;
    let bob_evm = SigningKey::from_bytes(&[2u8; 32].into())?;
    let (la, lb) = (
        leaf(&evm_address(&alice_evm), 60),
        leaf(&evm_address(&bob_evm), 40),
    );
    protocol.call(fw.id(), "set_root").args_json(json!({"commitment_id": 0, "root": {
        "root": hex::encode(node(la, lb)), "total": "100", "leaf_count": 2, "snapshot_block": 900}}))
        .deposit(ONE_YOCTO).transact().await?.into_result()?;
    protocol.call(usdc.id(), "ft_transfer_call")
        .args_json(json!({"receiver_id": fw.id(), "amount": BOND.to_string(), "msg": "{\"commitment_id\":0}"}))
        .deposit(NearToken::from_yoctonear(1)).max_gas().transact().await?.into_result()?;

    Ok(Env {
        worker,
        fw,
        usdc,
        signer,
        mpc_key,
        protocol,
        reporter,
        defender,
        alice,
        bob,
        alice_evm,
        bob_evm,
        proofs: (hex::encode(lb), hex::encode(la)),
    })
}

async fn expected_hash(e: &Env, log: &Value) -> anyhow::Result<String> {
    let args: Value =
        e.fw.view("mpc_request_for")
            .args_json(json!({"log": log, "finality": "Safe"}))
            .await?
            .json()?;
    Ok(args["expected_payload_hash"].as_str().unwrap().to_string())
}

/// Sends `method` async, waits for the MPC request to land, answers it, returns the final outcome.
async fn call_with_mpc(
    e: &Env,
    who: &Account,
    method: &str,
    args: Value,
    answer_with: Option<String>,
) -> anyhow::Result<ExecutionFinalResult> {
    let bond = if method == "report" {
        REPORT_DEPOSIT
    } else {
        NearToken::from_yoctonear(0)
    };
    let pending = who
        .call(e.fw.id(), method)
        .args_json(args)
        .deposit(bond)
        .gas(near_workspaces::types::Gas::from_tgas(200))
        .transact_async()
        .await?;
    if let Some(h) = answer_with {
        for _ in 0..40 {
            let r = e
                .signer
                .call("respond")
                .args_json(json!({"response": mpc_response(&e.mpc_key, &h)}))
                .transact()
                .await?;
            if r.is_success() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        }
    }
    Ok(pending.await?)
}

async fn case(e: &Env, id: u64) -> anyhow::Result<Value> {
    Ok(e.fw
        .view("get_case")
        .args_json(json!({"case_id": id}))
        .await?
        .json()?)
}
async fn usdc_balance(e: &Env, a: &Account) -> anyhow::Result<u128> {
    let v: String = e
        .usdc
        .view("ft_balance_of")
        .args_json(json!({"account_id": a.id()}))
        .await?
        .json()?;
    Ok(v.parse()?)
}

#[tokio::test]
async fn breach_without_notice_pays_reporter_and_depositors() -> anyhow::Result<()> {
    let e = setup().await?;
    let log = breach_log(1);
    let h = expected_hash(&e, &log).await?;
    let r = call_with_mpc(
        &e,
        &e.reporter,
        "report",
        json!({"commitment_id": 0, "log": log}),
        Some(h),
    )
    .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    println!(
        "GAS report total {} ; per receipt {:?}",
        r.total_gas_burnt,
        r.outcomes()
            .iter()
            .map(|o| (o.executor_id.to_string(), o.gas_burnt.as_tgas()))
            .collect::<Vec<_>>()
    );
    let c = case(&e, 0).await?;
    assert_eq!(c["status"], "DefenceOpen");
    assert_eq!(c["action_hash"], action_hash());

    // finalize refuses while the window is open
    assert!(e
        .alice
        .call(e.fw.id(), "finalize")
        .args_json(json!({"case_id": 0}))
        .transact()
        .await?
        .is_failure());
    e.worker.fast_forward(310).await?;
    e.alice
        .call(e.fw.id(), "finalize")
        .args_json(json!({"case_id": 0}))
        .transact()
        .await?
        .into_result()?;
    let c = case(&e, 0).await?;
    assert_eq!(c["status"], "Breached");
    assert_eq!(c["reward"], "50000000");
    assert_eq!(c["pool"], "450000000");

    e.defender
        .call(e.fw.id(), "claim_reward")
        .args_json(json!({"case_id": 0}))
        .deposit(STORAGE)
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert_eq!(usdc_balance(&e, &e.reporter).await?, 50_000_000);

    for (acct, key, amount, proof) in [
        (&e.alice, &e.alice_evm, 60, &e.proofs.0),
        (&e.bob, &e.bob_evm, 40, &e.proofs.1),
    ] {
        let msg: String =
            e.fw.view("claim_message_for")
                .args_json(json!({"case_id": 0, "pay_to": acct.id()}))
                .await?
                .json()?;
        // a relayer submits; the EVM signature is what authorizes pay_to
        let cr = e.defender.call(e.fw.id(), "claim").args_json(json!({"case_id": 0,
            "base_address": hex::encode(evm_address(key)), "amount": amount.to_string(), "proof": [proof],
            "pay_to": acct.id(), "signature": eip191(key, &msg)}))
            .deposit(STORAGE).max_gas().transact().await?;
        println!("GAS claim total {}", cr.total_gas_burnt);
        cr.into_result()?;
    }
    assert_eq!(usdc_balance(&e, &e.alice).await?, 270_000_000);
    assert_eq!(usdc_balance(&e, &e.bob).await?, 180_000_000);
    assert_eq!(case(&e, 0).await?["status"], "Paid");
    let commitment: Value =
        e.fw.view("get_commitment")
            .args_json(json!({"commitment_id": 0}))
            .await?
            .json()?;
    assert_eq!(commitment["status"], "Breached");
    assert_eq!(commitment["bond"], "0");
    Ok(())
}

#[tokio::test]
async fn honest_upgrade_is_defended_and_reporter_bond_goes_to_defender() -> anyhow::Result<()> {
    let e = setup().await?;
    let log = breach_log(2);
    let h = expected_hash(&e, &log).await?;
    call_with_mpc(
        &e,
        &e.reporter,
        "report",
        json!({"commitment_id": 0, "log": log}),
        Some(h),
    )
    .await?
    .into_result()?;
    let ann = announce_log(BREACH_BLOCK - NOTICE, &action_hash());
    let h = expected_hash(&e, &ann).await?;
    let before = e.defender.view_account().await?.balance;
    let r = call_with_mpc(
        &e,
        &e.defender,
        "defend",
        json!({"case_id": 0, "log": ann}),
        Some(h),
    )
    .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    assert_eq!(case(&e, 0).await?["status"], "Defended");
    // the bond transfer and gas refund land a few blocks after the outcome returns
    let mut after = before;
    for _ in 0..20 {
        after = e.defender.view_account().await?.balance;
        if after > before {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    assert!(
        after.as_yoctonear() > before.as_yoctonear() + 400_000_000_000_000_000_000_000,
        "defender got the 0.5 NEAR report bond"
    );
    e.worker.fast_forward(310).await?;
    assert!(e
        .alice
        .call(e.fw.id(), "finalize")
        .args_json(json!({"case_id": 0}))
        .transact()
        .await?
        .is_failure());
    Ok(())
}

#[tokio::test]
async fn defence_rules_notice_action_window() -> anyhow::Result<()> {
    let e = setup().await?;
    let log = breach_log(3);
    let h = expected_hash(&e, &log).await?;
    call_with_mpc(
        &e,
        &e.reporter,
        "report",
        json!({"commitment_id": 0, "log": log}),
        Some(h),
    )
    .await?
    .into_result()?;
    let try_defend = |ann: Value| {
        e.defender
            .call(e.fw.id(), "defend")
            .args_json(json!({"case_id": 0, "log": ann}))
            .max_gas()
            .transact()
    };
    // announced only 29 blocks before
    let r = try_defend(announce_log(BREACH_BLOCK - NOTICE + 1, &action_hash())).await?;
    assert!(format!("{:?}", r.failures()).contains("notice too short"));
    // announced a different implementation
    let r = try_defend(announce_log(BREACH_BLOCK - NOTICE, &hex::encode([9u8; 32]))).await?;
    assert!(format!("{:?}", r.failures()).contains("announced a different action"));
    // stale announcement
    let r = try_defend(announce_log(BREACH_BLOCK - 501, &action_hash())).await?;
    assert!(format!("{:?}", r.failures()).contains("announcement too old"));
    // after the window
    e.worker.fast_forward(310).await?;
    let r = try_defend(announce_log(BREACH_BLOCK - NOTICE, &action_hash())).await?;
    assert!(format!("{:?}", r.failures()).contains("defence window closed"));
    Ok(())
}

#[tokio::test]
async fn report_input_checks_and_duplicates() -> anyhow::Result<()> {
    let e = setup().await?;
    let report = |log: Value| {
        e.reporter
            .call(e.fw.id(), "report")
            .args_json(json!({"commitment_id": 0, "log": log}))
            .deposit(REPORT_DEPOSIT)
            .max_gas()
            .transact()
    };
    let mut wrong = breach_log(4);
    wrong["address"] = json!("4444444444444444444444444444444444444444");
    assert!(format!("{:?}", report(wrong).await?.failures()).contains("not from a watched address"));
    let mut wrong = breach_log(4);
    wrong["topics"][0] = json!(ANNOUNCE);
    assert!(format!("{:?}", report(wrong).await?.failures()).contains("not a watched admin event"));
    let mut wrong = breach_log(4);
    wrong["block_number"] = json!(99);
    assert!(format!("{:?}", report(wrong).await?.failures()).contains("before coverage start"));
    let mut wrong = breach_log(4);
    wrong["data"] = json!("0xAB");
    assert!(format!("{:?}", report(wrong).await?.failures()).contains("lowercase"));
    let low = e
        .reporter
        .call(e.fw.id(), "report")
        .args_json(json!({"commitment_id": 0, "log": breach_log(4)}))
        .deposit(NearToken::from_millinear(100))
        .max_gas()
        .transact()
        .await?;
    assert!(format!("{:?}", low.failures()).contains("report bond too low"));

    let log = breach_log(5);
    let h = expected_hash(&e, &log).await?;
    call_with_mpc(
        &e,
        &e.reporter,
        "report",
        json!({"commitment_id": 0, "log": log.clone()}),
        Some(h),
    )
    .await?
    .into_result()?;
    assert!(format!("{:?}", report(log).await?.failures()).contains("already verified"));
    Ok(())
}

#[tokio::test]
async fn wrong_claim_times_out_and_refunds() -> anyhow::Result<()> {
    let e = setup().await?;
    // the reporter lies about the block hash; the "MPC" sees the real one, so nothing matches
    let mut lie = breach_log(6);
    lie["block_hash"] = json!(hex::encode([0xee; 32]));
    let pending = e
        .reporter
        .call(e.fw.id(), "report")
        .args_json(json!({"commitment_id": 0, "log": lie}))
        .deposit(REPORT_DEPOSIT)
        .gas(near_workspaces::types::Gas::from_tgas(200))
        .transact_async()
        .await?;
    let real = expected_hash(&e, &breach_log(6)).await?;
    let r = e
        .signer
        .call("respond")
        .args_json(json!({"response": mpc_response(&e.mpc_key, &real)}))
        .transact()
        .await?;
    assert!(
        r.is_failure(),
        "a mismatched payload has no pending request"
    );
    e.worker.fast_forward(210).await?; // yield timeout is 200 blocks
    let out = pending.await?;
    assert_eq!(out.json::<bool>()?, false);
    assert_eq!(case(&e, 0).await?["status"], "Rejected");
    let c: Value =
        e.fw.view("get_commitment")
            .args_json(json!({"commitment_id": 0}))
            .await?
            .json()?;
    assert_eq!(c["open_cases"], 0);
    Ok(())
}

#[tokio::test]
async fn fallback_a_direct_signature_path() -> anyhow::Result<()> {
    let e = setup().await?;
    let log = breach_log(7);
    let h = expected_hash(&e, &log).await?;
    let mut bad = mpc_response(&SigningKey::from_bytes(&[8u8; 32].into())?, &h);
    let r = e
        .reporter
        .call(e.fw.id(), "report_verified")
        .args_json(json!({"commitment_id": 0, "log": log, "response": bad.take()}))
        .deposit(REPORT_DEPOSIT)
        .max_gas()
        .transact()
        .await?;
    assert!(format!("{:?}", r.failures()).contains("bad MPC signature"));
    let good = mpc_response(&e.mpc_key, &h);
    e.reporter
        .call(e.fw.id(), "report_verified")
        .args_json(json!({"commitment_id": 0, "log": log, "response": good}))
        .deposit(REPORT_DEPOSIT)
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert_eq!(case(&e, 0).await?["status"], "DefenceOpen");
    // same path for the defence
    let ann = announce_log(BREACH_BLOCK - NOTICE, &action_hash());
    let h = expected_hash(&e, &ann).await?;
    e.defender
        .call(e.fw.id(), "defend_verified")
        .args_json(json!({"case_id": 0, "log": ann, "response": mpc_response(&e.mpc_key, &h)}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert_eq!(case(&e, 0).await?["status"], "Defended");
    Ok(())
}

#[tokio::test]
async fn bond_withdrawal_needs_notice_and_no_open_case() -> anyhow::Result<()> {
    let e = setup().await?;
    e.protocol
        .call(e.fw.id(), "request_withdrawal")
        .args_json(json!({"commitment_id": 0, "amount": BOND.to_string()}))
        .deposit(ONE_YOCTO)
        .transact()
        .await?
        .into_result()?;
    let early = e
        .protocol
        .call(e.fw.id(), "execute_withdrawal")
        .args_json(json!({"commitment_id": 0}))
        .max_gas()
        .deposit(ONE_YOCTO)
        .transact()
        .await?;
    assert!(format!("{:?}", early.failures()).contains("notice not over"));
    // a breach during the notice freezes the bond
    let log = breach_log(8);
    let h = expected_hash(&e, &log).await?;
    call_with_mpc(
        &e,
        &e.reporter,
        "report",
        json!({"commitment_id": 0, "log": log}),
        Some(h),
    )
    .await?
    .into_result()?;
    e.worker.fast_forward(410).await?;
    let blocked = e
        .protocol
        .call(e.fw.id(), "execute_withdrawal")
        .args_json(json!({"commitment_id": 0}))
        .max_gas()
        .deposit(ONE_YOCTO)
        .transact()
        .await?;
    assert!(format!("{:?}", blocked.failures()).contains("case open"));
    e.alice
        .call(e.fw.id(), "finalize")
        .args_json(json!({"case_id": 0}))
        .transact()
        .await?
        .into_result()?;
    let c: Value =
        e.fw.view("get_commitment")
            .args_json(json!({"commitment_id": 0}))
            .await?
            .json()?;
    assert_eq!(c["status"], "Breached");
    assert!(c["withdrawal"].is_null());
    Ok(())
}

#[tokio::test]
async fn reports_pay_their_storage_and_owner_calls_need_full_access() -> anyhow::Result<()> {
    let e = setup().await?;
    let need: String =
        e.fw.view("report_deposit")
            .args_json(json!({"commitment_id": 0}))
            .await?
            .json()?;
    assert_eq!(need, REPORT_DEPOSIT.as_yoctonear().to_string());

    // the bond alone, without the storage fee, is refused
    let bare = e
        .reporter
        .call(e.fw.id(), "report")
        .args_json(json!({"commitment_id": 0, "log": breach_log(30)}))
        .deposit(NearToken::from_millinear(500))
        .max_gas()
        .transact()
        .await?;
    assert!(format!("{:?}", bare.failures()).contains("report bond too low"));

    let mut huge = breach_log(31);
    huge["data"] = json!(format!("0x{}", "ab".repeat(4_100)));
    let r = e
        .reporter
        .call(e.fw.id(), "report")
        .args_json(json!({"commitment_id": 0, "log": huge}))
        .deposit(REPORT_DEPOSIT)
        .max_gas()
        .transact()
        .await?;
    assert!(format!("{:?}", r.failures()).contains("log data too long"));

    // storage the contract keeps for one full case (report, verified entry, root copied at finalize) fits the fee
    let before = e.fw.as_account().view_account().await?.storage_usage;
    let log = breach_log(32);
    let h = expected_hash(&e, &log).await?;
    call_with_mpc(
        &e,
        &e.reporter,
        "report",
        json!({"commitment_id": 0, "log": log}),
        Some(h),
    )
    .await?
    .into_result()?;
    e.worker.fast_forward(310).await?;
    e.alice
        .call(e.fw.id(), "finalize")
        .args_json(json!({"case_id": 0}))
        .transact()
        .await?
        .into_result()?;
    let grown = e.fw.as_account().view_account().await?.storage_usage - before;
    println!("STORAGE per full case: {grown} bytes");
    assert!(
        grown as u128 * STORAGE_BYTE_COST <= NearToken::from_millinear(10).as_yoctonear(),
        "{grown} bytes exceed the 0.01 NEAR report storage fee"
    );

    // a function-call key cannot attach a deposit, so owner methods without 1 yocto are refused
    let no_yocto = e
        .protocol
        .call(e.fw.id(), "request_withdrawal")
        .args_json(json!({"commitment_id": 0, "amount": "1"}))
        .transact()
        .await?;
    assert!(format!("{:?}", no_yocto.failures())
        .contains("Requires attached deposit of exactly 1 yoctoNEAR"));
    Ok(())
}

#[tokio::test]
async fn withdrawal_waits_for_notice_plus_grace_and_ends_coverage() -> anyhow::Result<()> {
    let e = setup().await?;
    let covered = || async {
        e.fw.view("is_covered")
            .args_json(json!({"commitment_id": 0}))
            .await
            .unwrap()
            .json::<bool>()
            .unwrap()
    };
    assert!(covered().await);
    let request = || {
        e.protocol
            .call(e.fw.id(), "request_withdrawal")
            .args_json(json!({"commitment_id": 0, "amount": BOND.to_string()}))
            .deposit(ONE_YOCTO)
            .transact()
    };
    let execute = || {
        e.protocol
            .call(e.fw.id(), "execute_withdrawal")
            .args_json(json!({"commitment_id": 0}))
            .max_gas()
            .deposit(ONE_YOCTO)
            .transact()
    };

    request().await?.into_result()?;
    assert!(
        !covered().await,
        "a pending withdrawal must show as not covered"
    );
    e.protocol
        .call(e.fw.id(), "cancel_withdrawal")
        .args_json(json!({"commitment_id": 0}))
        .deposit(ONE_YOCTO)
        .transact()
        .await?
        .into_result()?;
    assert!(covered().await);

    request().await?.into_result()?;
    // withdrawal_notice 400 has passed, the 600-block Safe grace has not
    e.worker.fast_forward(410).await?;
    assert!(format!("{:?}", execute().await?.failures()).contains("notice not over"));
    e.worker.fast_forward(600).await?;
    execute().await?.into_result()?;
    assert_eq!(usdc_balance(&e, &e.protocol).await?, 1_000_000_000_000);
    Ok(())
}

#[tokio::test]
async fn claims_cannot_replay_or_redirect() -> anyhow::Result<()> {
    let e = setup().await?;
    let log = breach_log(9);
    let h = expected_hash(&e, &log).await?;
    call_with_mpc(
        &e,
        &e.reporter,
        "report",
        json!({"commitment_id": 0, "log": log}),
        Some(h),
    )
    .await?
    .into_result()?;
    e.worker.fast_forward(310).await?;
    e.alice
        .call(e.fw.id(), "finalize")
        .args_json(json!({"case_id": 0}))
        .transact()
        .await?
        .into_result()?;
    let msg_for_alice: String =
        e.fw.view("claim_message_for")
            .args_json(json!({"case_id": 0, "pay_to": e.alice.id()}))
            .await?
            .json()?;
    let sig = eip191(&e.alice_evm, &msg_for_alice);
    let claim = |pay_to: &Account| {
        e.defender.call(e.fw.id(), "claim").args_json(json!({"case_id": 0,
        "base_address": hex::encode(evm_address(&e.alice_evm)), "amount": "60", "proof": [e.proofs.0.clone()],
        "pay_to": pay_to.id(), "signature": sig.clone()})).deposit(STORAGE).max_gas().transact()
    };
    // a relayer cannot redirect Alice's signature to itself
    assert!(format!("{:?}", claim(&e.defender).await?.failures()).contains("bad signature"));
    claim(&e.alice).await?.into_result()?;
    assert!(format!("{:?}", claim(&e.alice).await?.failures()).contains("already claimed"));
    let _ = &e.bob;
    Ok(())
}

#[tokio::test]
async fn a_lying_root_total_cannot_drain_other_bonds() -> anyhow::Result<()> {
    let e = setup().await?;
    // attacker commitment 1: 10 USDC bond, root total 9 but one leaf of 509, so share = 509 USDC
    let params = json!({"watched": [PROXY], "watched_topics": [UPGRADED], "announcer": ANNOUNCER,
        "notice_blocks": NOTICE, "max_announce_age_blocks": 500, "effective_from_block": 100,
        "finality": "Safe", "defence_window": 300, "withdrawal_notice": 400, "root_notice": 1000,
        "report_bond": NearToken::from_millinear(500), "reward_bps": 1000});
    e.protocol
        .call(e.fw.id(), "create_commitment")
        .args_json(json!({"params": params}))
        .deposit(NearToken::from_millinear(50))
        .transact()
        .await?
        .into_result()?;
    let attacker = evm_address(&e.bob_evm);
    e.protocol.call(e.fw.id(), "set_root").args_json(json!({"commitment_id": 1, "root": {
        "root": hex::encode(leaf(&attacker, 509)), "total": "9", "leaf_count": 1, "snapshot_block": 900}}))
        .deposit(ONE_YOCTO).transact().await?.into_result()?;
    e.protocol
        .call(e.usdc.id(), "ft_transfer_call")
        .args_json(
            json!({"receiver_id": e.fw.id(), "amount": "10000000", "msg": "{\"commitment_id\":1}"}),
        )
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let log = breach_log(20);
    let h = expected_hash(&e, &log).await?;
    call_with_mpc(
        &e,
        &e.reporter,
        "report",
        json!({"commitment_id": 1, "log": log}),
        Some(h),
    )
    .await?
    .into_result()?;
    e.worker.fast_forward(310).await?;
    e.alice
        .call(e.fw.id(), "finalize")
        .args_json(json!({"case_id": 0}))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(case(&e, 0).await?["pool"], "9000000");

    let msg: String =
        e.fw.view("claim_message_for")
            .args_json(json!({"case_id": 0, "pay_to": e.bob.id()}))
            .await?
            .json()?;
    let r = e
        .defender
        .call(e.fw.id(), "claim")
        .args_json(json!({"case_id": 0,
        "base_address": hex::encode(attacker), "amount": "509", "proof": [],
        "pay_to": e.bob.id(), "signature": eip191(&e.bob_evm, &msg)}))
        .deposit(STORAGE)
        .max_gas()
        .transact()
        .await?;
    assert!(
        format!("{:?}", r.failures()).contains("claims exceed pool"),
        "{:?}",
        r.failures()
    );
    assert_eq!(usdc_balance(&e, &e.bob).await?, 0);
    // the victim's 500 USDC bond is still fully there
    let victim: Value =
        e.fw.view("get_commitment")
            .args_json(json!({"commitment_id": 0}))
            .await?
            .json()?;
    assert_eq!(victim["bond"], BOND.to_string());
    assert_eq!(
        usdc_balance(&e, &e.fw.as_account()).await?,
        BOND + 10_000_000
    );
    Ok(())
}

#[tokio::test]
async fn only_first_breach_takes_the_bond() -> anyhow::Result<()> {
    let e = setup().await?;
    for seed in [10u8, 11] {
        let log = breach_log(seed);
        let h = expected_hash(&e, &log).await?;
        call_with_mpc(
            &e,
            &e.reporter,
            "report",
            json!({"commitment_id": 0, "log": log}),
            Some(h),
        )
        .await?
        .into_result()?;
    }
    e.worker.fast_forward(310).await?;
    e.alice
        .call(e.fw.id(), "finalize")
        .args_json(json!({"case_id": 0}))
        .transact()
        .await?
        .into_result()?;
    e.alice
        .call(e.fw.id(), "finalize")
        .args_json(json!({"case_id": 1}))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(case(&e, 0).await?["status"], "Breached");
    assert_eq!(case(&e, 1).await?["status"], "Moot");
    Ok(())
}

#[tokio::test]
async fn expire_report_only_after_mpc_timeout() -> anyhow::Result<()> {
    let e = setup().await?;
    let pending = e
        .reporter
        .call(e.fw.id(), "report")
        .args_json(json!({"commitment_id": 0, "log": breach_log(12)}))
        .deposit(REPORT_DEPOSIT)
        .gas(near_workspaces::types::Gas::from_tgas(200))
        .transact_async()
        .await?;
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    let early = e
        .alice
        .call(e.fw.id(), "expire_report")
        .args_json(json!({"case_id": 0}))
        .transact()
        .await?;
    assert!(format!("{:?}", early.failures()).contains("still within MPC timeout"));
    e.worker.fast_forward(210).await?;
    let _ = pending.await?;
    // the normal timeout path already cleaned up, so the hatch has nothing to do
    let late = e
        .alice
        .call(e.fw.id(), "expire_report")
        .args_json(json!({"case_id": 0}))
        .transact()
        .await?;
    assert!(format!("{:?}", late.failures()).contains("not pending"));
    Ok(())
}

#[tokio::test]
async fn the_commitment_chain_binds_the_mpc_answer() -> anyhow::Result<()> {
    let e = setup().await?;
    let params = json!({"chain": "Arbitrum", "watched": [PROXY], "watched_topics": [UPGRADED],
        "announcer": ANNOUNCER, "notice_blocks": NOTICE, "max_announce_age_blocks": 500,
        "effective_from_block": 100, "finality": "Safe", "defence_window": 300,
        "withdrawal_notice": 400, "root_notice": 1000,
        "report_bond": NearToken::from_millinear(500), "reward_bps": 1000});
    e.protocol
        .call(e.fw.id(), "create_commitment")
        .args_json(json!({"params": params}))
        .deposit(NearToken::from_millinear(50))
        .transact()
        .await?
        .into_result()?;
    e.protocol
        .call(e.fw.id(), "set_root")
        .args_json(json!({"commitment_id": 1, "root": {
        "root": hex::encode([9u8; 32]), "total": "100", "leaf_count": 2, "snapshot_block": 900}}))
        .deposit(ONE_YOCTO)
        .transact()
        .await?
        .into_result()?;
    e.protocol.call(e.usdc.id(), "ft_transfer_call")
        .args_json(json!({"receiver_id": e.fw.id(), "amount": BOND.to_string(), "msg": "{\"commitment_id\":1}"}))
        .deposit(ONE_YOCTO).max_gas().transact().await?.into_result()?;

    let log = breach_log(9);
    let on_base = expected_hash(&e, &log).await?;
    let req: Value =
        e.fw.view("mpc_request_for")
            .args_json(json!({"log": log, "chain": "Arbitrum", "finality": "Safe"}))
            .await?
            .json()?;
    assert!(req["request"].get("Arbitrum").is_some(), "{req}");
    let on_arb = req["expected_payload_hash"].as_str().unwrap().to_string();
    assert_ne!(on_base, on_arb);

    // a genuine MPC signature for the same log on Base does not open a case on the Arbitrum bond
    let r = e
        .reporter
        .call(e.fw.id(), "report_verified")
        .args_json(
            json!({"commitment_id": 1, "log": log, "response": mpc_response(&e.mpc_key, &on_base)}),
        )
        .deposit(REPORT_DEPOSIT)
        .max_gas()
        .transact()
        .await?;
    assert!(r.is_failure());
    // the main path asks v1.signer for the Arbitrum payload and opens on that answer
    let r = call_with_mpc(
        &e,
        &e.reporter,
        "report",
        json!({"commitment_id": 1, "log": log}),
        Some(on_arb),
    )
    .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    assert_eq!(case(&e, 0).await?["status"], "DefenceOpen");
    assert_eq!(case(&e, 0).await?["commitment_id"], 1);
    Ok(())
}

/// Defends case 0 via fallback A with a valid MPC signature; returns the failure text ("[]" on success).
async fn defend_now(e: &Env, ann: Value) -> anyhow::Result<String> {
    let h = expected_hash(e, &ann).await?;
    let r = e
        .defender
        .call(e.fw.id(), "defend_verified")
        .args_json(json!({"case_id": 0, "log": ann, "response": mpc_response(&e.mpc_key, &h)}))
        .max_gas()
        .transact()
        .await?;
    Ok(format!("{:?}", r.failures()))
}

#[tokio::test]
async fn defence_must_carry_the_announced_log_and_its_target() -> anyhow::Result<()> {
    let e = setup().await?;
    let log = breach_log(40);
    let h = expected_hash(&e, &log).await?;
    call_with_mpc(
        &e,
        &e.reporter,
        "report",
        json!({"commitment_id": 0, "log": log}),
        Some(h),
    )
    .await?
    .into_result()?;
    let good = announce_log(BREACH_BLOCK - NOTICE, &action_hash());
    // right actionHash topic, but no expectedLog behind it
    let mut empty = good.clone();
    empty["data"] = json!("0x");
    assert!(defend_now(&e, empty).await?.contains("not abi-encoded bytes"));
    // right actionHash topic, but the data announces a different implementation
    let mut other = good.clone();
    other["data"] = json!(abi_bytes(&expected_log(ANNOUNCER)));
    assert!(defend_now(&e, other)
        .await?
        .contains("announced log does not match the action"));
    // announced for another target
    let mut elsewhere = good.clone();
    elsewhere["topics"][2] = json!(pad(ANNOUNCER));
    assert!(defend_now(&e, elsewhere)
        .await?
        .contains("announced for a different target"));
    assert_eq!(case(&e, 0).await?["status"], "DefenceOpen");
    assert_eq!(defend_now(&e, good).await?, "[]");
    assert_eq!(case(&e, 0).await?["status"], "Defended");
    Ok(())
}

/// A payout that fails after the other shares settled must leave the case claimable, not Paid.
/// The contract itself reports so its reward transfer fails (FT refuses sender == receiver).
#[tokio::test]
async fn a_failed_payout_never_marks_the_case_paid() -> anyhow::Result<()> {
    let e = setup().await?;
    let log = breach_log(41);
    let h = expected_hash(&e, &log).await?;
    e.fw.as_account()
        .call(e.fw.id(), "report_verified")
        .args_json(json!({"commitment_id": 0, "log": log, "response": mpc_response(&e.mpc_key, &h)}))
        .deposit(REPORT_DEPOSIT)
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    e.worker.fast_forward(310).await?;
    e.alice
        .call(e.fw.id(), "finalize")
        .args_json(json!({"case_id": 0}))
        .transact()
        .await?
        .into_result()?;
    let claim = |relayer: &Account, acct: &Account, key: &SigningKey, amount: u128, proof: &str| {
        let (relayer, acct, key, proof) = (relayer.clone(), acct.clone(), key.clone(), proof.to_string());
        let fw = e.fw.id().clone();
        let view = e.fw.view("claim_message_for").args_json(json!({"case_id": 0, "pay_to": acct.id()}));
        async move {
            let msg: String = view.await?.json()?;
            anyhow::Ok(relayer.call(&fw, "claim").args_json(json!({"case_id": 0,
                "base_address": hex::encode(evm_address(&key)), "amount": amount.to_string(), "proof": [proof],
                "pay_to": acct.id(), "signature": eip191(&key, &msg)}))
                .deposit(STORAGE).max_gas().transact_async().await?)
        }
    };
    claim(&e.defender, &e.alice, &e.alice_evm, 60, &e.proofs.0).await?.await?.into_result()?;
    // the last depositor share and the (failing) reward are in flight together
    let last = claim(&e.alice, &e.bob, &e.bob_evm, 40, &e.proofs.1).await?;
    let reward = e
        .defender
        .call(e.fw.id(), "claim_reward")
        .args_json(json!({"case_id": 0}))
        .deposit(STORAGE)
        .max_gas()
        .transact_async()
        .await?;
    last.await?.into_result()?;
    reward.await?.into_result()?;
    assert_eq!(usdc_balance(&e, &e.bob).await?, 180_000_000);
    let c = case(&e, 0).await?;
    assert_eq!(c["status"], "Breached", "{c}");
    assert_eq!(c["reward_paid"], false);
    assert_eq!(c["paid"], "450000000");
    // the reward can be claimed again (it fails again here, but is not locked out)
    let again = e
        .defender
        .call(e.fw.id(), "claim_reward")
        .args_json(json!({"case_id": 0}))
        .deposit(STORAGE)
        .max_gas()
        .transact()
        .await?;
    assert!(!format!("{:?}", again.failures()).contains("nothing to claim"));
    assert_eq!(case(&e, 0).await?["status"], "Breached");
    Ok(())
}
