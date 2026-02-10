// Verifies a Pedersen Merkle inclusion proof of depth 20 (~1M leaves).
// path_bits[i] = 0 means current node is the LEFT child at level i
// path_bits[i] = 1 means current node is the RIGHT child at level i
pub fn verify_merkle_proof(leaf: Field, siblings: [Field; 20], path_bits: [u1; 20], root: Field) {
    let mut current = leaf;
    for i in 0..20 {
        let (left, right) = if path_bits[i] == 0 {
            (current, siblings[i])
        } else {
            (siblings[i], current)
        };
        current = dep::std::hash::pedersen_hash([left, right]);
    }
    assert(current == root, "merkle proof invalid");
}
