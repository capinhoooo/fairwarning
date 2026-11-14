//! OZ StandardMerkleTree leaves and EIP-191 signer recovery.
use near_sdk::env;

/// keccak256(keccak256(abi.encode(address, uint256))), as in @openzeppelin/merkle-tree.
pub fn leaf_hash(addr: &[u8; 20], amount: u128) -> [u8; 32] {
    let mut enc = [0u8; 64];
    enc[12..32].copy_from_slice(addr);
    enc[48..64].copy_from_slice(&amount.to_be_bytes());
    env::keccak256_array(env::keccak256_array(enc))
}

/// Sorted-pair (commutative) keccak, same as OZ MerkleProof.sol.
pub fn verify_proof(proof: &[[u8; 32]], root: [u8; 32], leaf: [u8; 32]) -> bool {
    let computed = proof.iter().fold(leaf, |acc, p| {
        let (a, b) = if acc <= *p { (acc, *p) } else { (*p, acc) };
        let mut buf = [0u8; 64];
        buf[..32].copy_from_slice(&a);
        buf[32..].copy_from_slice(&b);
        env::keccak256_array(buf)
    });
    computed == root
}

/// Recovers the EVM address that signed `personal_sign(msg)`; `sig` is r || s || v.
pub fn eip191_signer(msg: &[u8], sig: &[u8]) -> Option<[u8; 20]> {
    if sig.len() != 65 {
        return None;
    }
    let mut prefixed = format!("\x19Ethereum Signed Message:\n{}", msg.len()).into_bytes();
    prefixed.extend_from_slice(msg);
    let hash = env::keccak256_array(&prefixed);
    let v = match sig[64] {
        27 | 28 => sig[64] - 27,
        0 | 1 => sig[64],
        _ => return None,
    };
    let pk = env::ecrecover(&hash, &sig[..64], v, true)?;
    let h = env::keccak256_array(pk);
    h[12..].try_into().ok()
}
