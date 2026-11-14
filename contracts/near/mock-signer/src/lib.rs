//! Sandbox stand-in for v1.signer: same method name, args, deposit and yield/resume shape.
use near_mpc_sdk::foreign_chain::{
    VerifyForeignTransactionRequestArgs, VerifyForeignTransactionResponse,
};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, CryptoHash, Gas, GasWeight, NearToken, PanicOnDefault, PromiseError,
};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockSigner {
    key: String,
    pending: LookupMap<String, Vec<CryptoHash>>,
}

#[near]
impl MockSigner {
    #[init]
    pub fn new(key: String) -> Self {
        Self {
            key,
            pending: LookupMap::new(b"p"),
        }
    }

    #[payable]
    pub fn verify_foreign_transaction(&mut self, request: VerifyForeignTransactionRequestArgs) {
        require!(
            env::attached_deposit() >= NearToken::from_yoctonear(1),
            "1 yocto"
        );
        require!(env::prepaid_gas() >= Gas::from_tgas(15), "needs 15 Tgas");
        require!(u64::from(request.domain_id) == 3, "domain 3");
        let key = hex::encode(request.expected_payload_hash.expect("fw always sets it").0);
        let idx =
            env::promise_yield_create("on_response", b"{}", Gas::from_tgas(7), GasWeight(0), 0);
        let data_id: CryptoHash = env::read_register(0).unwrap().try_into().unwrap();
        self.pending.entry(key).or_default().push(data_id);
        env::promise_return(idx);
    }

    /// Test harness plays the MPC network. Mismatched hash = no pending entry, like UnexpectedPayloadHash.
    pub fn respond(&mut self, response: VerifyForeignTransactionResponse) {
        let key = hex::encode(response.payload_hash.0);
        let ids = self
            .pending
            .remove(&key)
            .expect("no pending request for this payload hash");
        let body = near_sdk::serde_json::to_vec(&response).unwrap();
        ids.iter().for_each(|id| {
            env::promise_yield_resume(id, &body);
        });
    }

    #[private]
    pub fn on_response(
        &mut self,
        #[callback_result] r: Result<VerifyForeignTransactionResponse, PromiseError>,
    ) -> VerifyForeignTransactionResponse {
        r.unwrap_or_else(|_| env::panic_str("timeout"))
    }

    pub fn public_key(&self, domain_id: Option<u64>) -> String {
        let _ = domain_id;
        self.key.clone()
    }
}
