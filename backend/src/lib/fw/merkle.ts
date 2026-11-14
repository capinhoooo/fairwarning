import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { getAddress } from 'viem';

type Leaf = [string, string];
export type TreeDump = ReturnType<StandardMerkleTree<Leaf>['dump']>;

/** Leaves are ['address','uint256'], double-hashed by OZ; the fw contract's `leaf_hash` matches. */
export const buildRoot = (entries: { address: string; amount: bigint }[]) => {
  const merged = new Map<string, bigint>();
  for (const e of entries) {
    if (e.amount <= 0n) continue;
    const a = getAddress(e.address);
    // one leaf per address, or a depositor could claim twice
    merged.set(a, (merged.get(a) ?? 0n) + e.amount);
  }
  if (merged.size === 0) throw new Error('No positive balances');
  const values: Leaf[] = [...merged].map(([a, amt]) => [a, amt.toString()]);
  const tree = StandardMerkleTree.of(values, ['address', 'uint256']);
  const total = [...merged.values()].reduce((s, v) => s + v, 0n);
  return { root: tree.root, total, leafCount: values.length, dump: tree.dump() };
};

export const proofFor = (dump: TreeDump, address: string): { amount: string; proof: string[] } | null => {
  const tree = StandardMerkleTree.load(dump);
  const want = address.toLowerCase();
  for (const [i, [a, amount]] of tree.entries()) {
    if (a.toLowerCase() === want) return { amount, proof: tree.getProof(i) };
  }
  return null;
};
