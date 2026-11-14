use near_mpc_sdk::foreign_chain::evm::{EvmExtractedValue, EvmExtractor, EvmFinality, EvmLog, EvmRpcRequest};
use near_mpc_sdk::foreign_chain::{ExtractedValue, ForeignChainRpcRequest, ForeignTxSignPayload, ForeignTxSignPayloadV1};
use near_mpc_sdk::near_mpc_contract_interface::types::{Hash160, Hash256};

fn h32(s: &str) -> [u8; 32] { hex::decode(s.trim_start_matches("0x")).unwrap().try_into().unwrap() }

fn main() {
    let tx = h32("0x702705ea9058b4a16a8907d06075de2ce65087da8061f93655e9a056e60a9301");
    let bh = h32("0x39da995c033b9920f074f5f8a17a160382274787e454bf1b8ed8d8b707576549");
    let request = ForeignChainRpcRequest::Base(EvmRpcRequest {
        tx_id: tx.into(),
        extractors: vec![EvmExtractor::BlockHash, EvmExtractor::Log { log_index: 5 }].try_into().unwrap(),
        finality: EvmFinality::Finalized,
    });
    let log = EvmLog {
        removed: false, log_index: 5, transaction_index: 3,
        transaction_hash: Hash256(tx), block_hash: Hash256(bh), block_number: 0x329929b,
        address: Hash160(hex::decode("e844701934d9c6085b292e428f41b911cc0b3872").unwrap().try_into().unwrap()),
        data: "0x".to_string(),
        topics: vec![Hash256(h32("0x29e088dffd7bf6815d088137a59f364d6747163baa7ff4bc47f316a1ad1b9586")), Hash256(h32("0x8dfdc825dd0453e7c80b1c1d32ae910e35d6efe9000000000000000021050200"))],
    };
    let payload = ForeignTxSignPayload::V1(ForeignTxSignPayloadV1 {
        request: request.clone(),
        values: vec![
            ExtractedValue::EvmExtractedValue(EvmExtractedValue::BlockHash(Hash256(bh))),
            ExtractedValue::EvmExtractedValue(EvmExtractedValue::Log(log.clone())),
        ],
    });
    let bytes = borsh::to_vec(&payload).unwrap();
    println!("borsh_len={} prefix={}", bytes.len(), hex::encode(&bytes[..8]));
    println!("computed={}", hex::encode(payload.compute_msg_hash().unwrap().0));
    println!("mpc_said=fb8f25f6b7bad4ff91af67a7e43f06aaa6653923c8fa6e39d741f220418bbfc5");
    let ExtractedValue::EvmExtractedValue(EvmExtractedValue::Log(l)) = (match &payload { ForeignTxSignPayload::V1(v) => v.values[1].clone() }) else { panic!() };
    let (_, args) = near_mpc_sdk::foreign_chain::ForeignChainRequestBuilder::new_base()
        .with_tx_id(near_mpc_sdk::foreign_chain::evm::EvmTxId(tx)).with_finality(EvmFinality::Safe)
        .with_expected_log(5, l).with_domain_id(3u64).build().unwrap();
    println!("builder single-log Safe={}", hex::encode(args.expected_payload_hash.clone().unwrap().0));
    println!("request json={}", serde_json::to_string(&args).unwrap());
    // same log, single-log Safe request, per chain: backend/test/mpcPayload.test.ts pins these
    use near_mpc_sdk::foreign_chain::ForeignChainRequestBuilder as B;
    macro_rules! per_chain {
        ($name:literal, $new:ident) => {{
            let (_, a) = B::$new().with_tx_id(near_mpc_sdk::foreign_chain::evm::EvmTxId(tx)).with_finality(EvmFinality::Safe)
                .with_expected_log(5, log.clone()).with_domain_id(3u64).build().unwrap();
            println!("chain {}={}", $name, hex::encode(a.expected_payload_hash.unwrap().0));
        }};
    }
    per_chain!("Base", new_base);
    per_chain!("Arbitrum", new_arbitrum);
    per_chain!("Bnb", new_bnb);
    per_chain!("Polygon", new_polygon);
    per_chain!("Avalanche", new_avalanche);
    per_chain!("HyperEvm", new_hyper_evm);
    per_chain!("Abstract", new_abstract);
}
