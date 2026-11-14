//! Security audit findings (2026-11-11). F1 to F3 are regression tests for the fixes; F4 is a deferred
//! finding and its test passing means the weakness is still present.
use k256::ecdsa::SigningKey;
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};
use sha3::{Digest, Keccak256};

const UPGRADED: &str = "bc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b";
const PROXY: &str = "1111111111111111111111111111111111111111";
const ANNOUNCER: &str = "2222222222222222222222222222222222222222";
const NEW_IMPL: &str = "3333333333333333333333333333333333333333";
const BOND: u128 = 500_000_000;
const SUPPLY: u128 = 1_000_000_000_000;
const STORAGE: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const REPORT_DEPOSIT: NearToken = NearToken::from_millinear(510);

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
        "block_hash": hex::encode([0xbb; 32]), "block_number": 1_000, "address": PROXY,
        "data": "0x", "topics": [UPGRADED, pad(NEW_IMPL)]})
}
fn params(root_notice: u64) -> Value {
    json!({"watched": [PROXY], "watched_topics": [UPGRADED], "announcer": ANNOUNCER,
        "notice_blocks": 30, "max_announce_age_blocks": 500, "effective_from_block": 100,
        "finality": "Safe", "defence_window": 300, "withdrawal_notice": 400, "root_notice": root_notice,
        "report_bond": NearToken::from_millinear(500), "reward_bps": 1000})
}
fn wasm(name: &str) -> Vec<u8> {
    std::fs::read(format!("../target/near/{name}/{name}.wasm")).expect("run cargo near build first")
}

struct Env {
    worker: Worker<Sandbox>,
    fw: Contract,
    usdc: Contract,
    signer: Contract,
    mpc_key: SigningKey,
    protocol: Account,
    reporter: Account,
    alice: Account,
}

async fn setup() -> anyhow::Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    let mpc_key = SigningKey::from_bytes(&[7u8; 32].into())?;
    let pk = mpc_key.verifying_key().to_encoded_point(false);
    let mpc_key_str = format!("secp256k1:{}", bs58::encode(&pk.as_bytes()[1..]).into_string());
    let signer = worker.dev_deploy(&wasm("mock_signer")).await?;
    signer.call("new").args_json(json!({"key": mpc_key_str})).transact().await?.into_result()?;
    let usdc = worker.dev_deploy(&wasm("mock_ft")).await?;
    let root = worker.root_account()?;
    let mut accts = vec![];
    for n in ["protocol", "reporter", "alice"] {
        accts.push(
            root.create_subaccount(n)
                .initial_balance(NearToken::from_near(20))
                .transact()
                .await?
                .into_result()?,
        );
    }
    let (protocol, reporter, alice) = (accts[0].clone(), accts[1].clone(), accts[2].clone());
    usdc.call("new_default_meta")
        .args_json(json!({"owner_id": protocol.id(), "total_supply": SUPPLY.to_string()}))
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
    Ok(Env { worker, fw, usdc, signer, mpc_key, protocol, reporter, alice })
}

/// Owner creates a commitment, commits `root_leaf` (hex root, total, leaves) and bonds `bond`.
async fn bonded(e: &Env, id: u32, root_notice: u64, root: (String, u128, u32), bond: u128) -> anyhow::Result<()> {
    e.protocol.call(e.fw.id(), "create_commitment").args_json(json!({"params": params(root_notice)}))
        .deposit(NearToken::from_millinear(50)).transact().await?.into_result()?;
    e.protocol.call(e.fw.id(), "set_root").args_json(json!({"commitment_id": id, "root": {
        "root": root.0, "total": root.1.to_string(), "leaf_count": root.2, "snapshot_block": 900}}))
        .deposit(ONE_YOCTO).transact().await?.into_result()?;
    e.protocol.call(e.usdc.id(), "ft_transfer_call")
        .args_json(json!({"receiver_id": e.fw.id(), "amount": bond.to_string(),
            "msg": format!("{{\"commitment_id\":{id}}}")}))
        .deposit(ONE_YOCTO).max_gas().transact().await?.into_result()?;
    Ok(())
}

async fn expected_hash(e: &Env, log: &Value) -> anyhow::Result<String> {
    let args: Value = e.fw.view("mpc_request_for")
        .args_json(json!({"log": log, "finality": "Safe"})).await?.json()?;
    Ok(args["expected_payload_hash"].as_str().unwrap().to_string())
}

async fn respond(e: &Env, h: &str) -> anyhow::Result<()> {
    for _ in 0..40 {
        let r = e.signer.call("respond")
            .args_json(json!({"response": mpc_response(&e.mpc_key, h)})).transact().await?;
        if r.is_success() {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }
    anyhow::bail!("no pending MPC request")
}

async fn view(e: &Env, method: &str, args: Value) -> anyhow::Result<Value> {
    Ok(e.fw.view(method).args_json(args).await?.json()?)
}

async fn owner_call(e: &Env, method: &str, args: Value) -> anyhow::Result<ExecutionFinalResult> {
    Ok(e.protocol.call(e.fw.id(), method).args_json(args).deposit(ONE_YOCTO).max_gas().transact().await?)
}

/// F1 fixed: `verified` is keyed per commitment, so a decoy commitment on the same proxy cannot consume the
/// breach log; both cases open and the real bond is slashed.
#[tokio::test]
async fn two_commitments_on_one_log_both_open_cases() -> anyhow::Result<()> {
    let e = setup().await?;
    let honest = node(leaf(&[0xa1; 20], 60), leaf(&[0xb2; 20], 40));
    bonded(&e, 0, 1_000, (hex::encode(honest), 100, 2), BOND).await?;
    // decoy: same proxy and topic, 1 micro-USDC bond, owner is the only leaf
    bonded(&e, 1, 1_000, (hex::encode(leaf(&[0xee; 20], 1)), 1, 1), 1).await?;

    let log = breach_log(1);
    let h = expected_hash(&e, &log).await?;
    let honest_report = e.reporter.call(e.fw.id(), "report")
        .args_json(json!({"commitment_id": 0, "log": log.clone()}))
        .deposit(REPORT_DEPOSIT).gas(Gas::from_tgas(200)).transact_async().await?;
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    // owner activates the decoy first with the same MPC signature
    e.protocol.call(e.fw.id(), "report_verified")
        .args_json(json!({"commitment_id": 1, "log": log.clone(), "response": mpc_response(&e.mpc_key, &h)}))
        .deposit(REPORT_DEPOSIT).max_gas().transact().await?.into_result()?;
    respond(&e, &h).await?;
    assert!(honest_report.await?.json::<bool>()?, "honest case opens despite the decoy");
    let c0 = view(&e, "get_case", json!({"case_id": 0})).await?;
    assert_eq!((c0["status"].as_str(), c0["commitment_id"].as_u64()), (Some("DefenceOpen"), Some(0)));
    assert_eq!(view(&e, "get_case", json!({"case_id": 1})).await?["status"], "DefenceOpen");
    let tx = log["tx_hash"].clone();
    for cid in [0u64, 1] {
        let found = view(&e, "case_for_log", json!({"commitment_id": cid, "tx_hash": tx, "log_index": 7})).await?;
        assert_eq!(found.as_u64(), Some(cid));
    }

    // still one case per (commitment, log)
    let again = e.reporter.call(e.fw.id(), "report")
        .args_json(json!({"commitment_id": 0, "log": log}))
        .deposit(REPORT_DEPOSIT).max_gas().transact().await?;
    assert!(format!("{:?}", again.failures()).contains("already verified"));

    // the real bond cannot walk out while its case is open, and the case takes it
    owner_call(&e, "request_withdrawal", json!({"commitment_id": 0, "amount": BOND.to_string()})).await?.into_result()?;
    e.worker.fast_forward(1_010).await?;
    let blocked = owner_call(&e, "execute_withdrawal", json!({"commitment_id": 0})).await?;
    assert!(format!("{:?}", blocked.failures()).contains("case open"));
    e.alice.call(e.fw.id(), "finalize").args_json(json!({"case_id": 0})).transact().await?.into_result()?;
    let c0 = view(&e, "get_case", json!({"case_id": 0})).await?;
    assert_eq!(c0["status"], "Breached");
    assert_eq!(c0["pool"], "450000000");
    Ok(())
}

/// F2 fixed: root_notice must cover withdrawal_notice + grace, and a pending root shows as not covered.
#[tokio::test]
async fn root_swap_needs_the_withdrawal_notice() -> anyhow::Result<()> {
    let e = setup().await?;
    let short = e.protocol.call(e.fw.id(), "create_commitment").args_json(json!({"params": params(999)}))
        .deposit(NearToken::from_millinear(50)).transact().await?;
    assert!(format!("{:?}", short.failures()).contains("root_notice >= withdrawal_notice + finality grace"));

    let honest = node(leaf(&[0xa1; 20], 60), leaf(&[0xb2; 20], 40));
    bonded(&e, 0, 1_000, (hex::encode(honest), 100, 2), BOND).await?;
    let own = evm_address(&SigningKey::from_bytes(&[3u8; 32].into())?);
    let covered = || async { view(&e, "is_covered", json!({"commitment_id": 0})).await.unwrap().as_bool().unwrap() };
    assert!(covered().await);
    owner_call(&e, "set_root", json!({"commitment_id": 0, "root": {
        "root": hex::encode(leaf(&own, 1)), "total": "1", "leaf_count": 1, "snapshot_block": 901}})).await?.into_result()?;
    assert!(!covered().await, "a pending root swap must show as not covered");
    let early = e.alice.call(e.fw.id(), "apply_root").args_json(json!({"commitment_id": 0})).transact().await?;
    assert!(format!("{:?}", early.failures()).contains("root notice not over"));
    // a withdrawal requested at the same time would unlock no earlier than the new root
    e.worker.fast_forward(1_000).await?;
    e.alice.call(e.fw.id(), "apply_root").args_json(json!({"commitment_id": 0})).transact().await?.into_result()?;
    assert!(covered().await);
    Ok(())
}

/// F3 fixed: a breach callback for a case that is no longer Reported changes nothing. The mock signer always
/// answers within the 200-block yield timeout, before expire_report opens at 250, so the late callback is
/// simulated by the contract account calling its own #[private] callback (no promise result).
#[tokio::test]
async fn late_breach_callback_changes_nothing() -> anyhow::Result<()> {
    let e = setup().await?;
    let honest = node(leaf(&[0xa1; 20], 60), leaf(&[0xb2; 20], 40));
    bonded(&e, 0, 1_000, (hex::encode(honest), 100, 2), BOND).await?;
    let log = breach_log(3);
    let h = expected_hash(&e, &log).await?;
    // case 0 waits on the MPC; case 1 activates first, so case 0 is rejected as a duplicate
    let pending = e.reporter.call(e.fw.id(), "report")
        .args_json(json!({"commitment_id": 0, "log": log.clone()}))
        .deposit(REPORT_DEPOSIT).gas(Gas::from_tgas(200)).transact_async().await?;
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    e.protocol.call(e.fw.id(), "report_verified")
        .args_json(json!({"commitment_id": 0, "log": log, "response": mpc_response(&e.mpc_key, &h)}))
        .deposit(REPORT_DEPOSIT).max_gas().transact().await?.into_result()?;
    respond(&e, &h).await?;
    assert!(!pending.await?.json::<bool>()?);
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    let before = e.reporter.view_account().await?.balance;

    for id in [0u64, 1] {
        let r = e.fw.call("on_breach_verified")
            .args_json(json!({"case_id": id, "expected": h})).max_gas().transact().await?;
        assert!(r.is_success(), "{:?}", r.failures());
        assert!(!r.json::<bool>()?);
    }
    assert_eq!(view(&e, "get_case", json!({"case_id": 0})).await?["status"], "Rejected");
    assert_eq!(view(&e, "get_case", json!({"case_id": 1})).await?["status"], "DefenceOpen");
    assert_eq!(view(&e, "get_commitment", json!({"commitment_id": 0})).await?["open_cases"], 1);
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    assert_eq!(e.reporter.view_account().await?.balance, before, "no second refund");
    Ok(())
}

/// F4 (deferred, still present): one unanswerable report (fake tx) costs 0.01 NEAR and freezes execute_withdrawal and apply_root.
#[tokio::test]
async fn poc_fake_report_freezes_withdrawal() -> anyhow::Result<()> {
    let e = setup().await?;
    let honest = node(leaf(&[0xa1; 20], 60), leaf(&[0xb2; 20], 40));
    bonded(&e, 0, 1_000, (hex::encode(honest), 100, 2), BOND).await?;
    owner_call(&e, "request_withdrawal", json!({"commitment_id": 0, "amount": BOND.to_string()})).await?.into_result()?;
    e.worker.fast_forward(1_010).await?;
    let before = e.reporter.view_account().await?.balance;
    // fabricated log: watched address and topic, tx hash that does not exist
    let _pending = e.reporter.call(e.fw.id(), "report")
        .args_json(json!({"commitment_id": 0, "log": breach_log(0xde)}))
        .deposit(REPORT_DEPOSIT).gas(Gas::from_tgas(200)).transact_async().await?;
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    let blocked = owner_call(&e, "execute_withdrawal", json!({"commitment_id": 0})).await?;
    assert!(format!("{:?}", blocked.failures()).contains("case open"));
    // after the MPC timeout the bond is refunded; only the storage fee and gas are lost
    e.worker.fast_forward(210).await?;
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    let after = e.reporter.view_account().await?.balance;
    let cost = before.as_yoctonear() - after.as_yoctonear();
    println!("GRIEF cost per report: {} yocto", cost);
    assert!(cost < NearToken::from_millinear(15).as_yoctonear());
    Ok(())
}
