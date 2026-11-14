import { concatHex, hexToBytes, numberToHex, sha256, toHex, type Hex, type Log } from 'viem';

// Borsh layout of near-mpc ForeignTxSignPayload::V1. Unchanged from 3.17.0 through 3.18.0 (types/foreign_chain.rs).
// Enum indexes are load-bearing: a wrong index silently produces a hash the MPC never signs.
// ForeignChainRpcRequest variant order in near-mpc 3.17.0 / 3.18.0
const CHAIN_INDEX = { Abstract: 0, Bnb: 5, Base: 6, Arbitrum: 7, Polygon: 8, HyperEvm: 9, Avalanche: 13 } as const;
const FINALITY_INDEX = { Latest: 0, Safe: 1, Finalized: 2 } as const;
export type MpcChain = keyof typeof CHAIN_INDEX;
export type MpcFinality = keyof typeof FINALITY_INDEX;

const u8 = (n: number): Hex => numberToHex(n, { size: 1 });
const u32 = (n: number): Hex => toHex(hexToBytes(numberToHex(n, { size: 4 })).reverse());
const u64 = (n: bigint): Hex => toHex(hexToBytes(numberToHex(n, { size: 8 })).reverse());

/** One EVM log in the exact JSON shape `fw.report` and `fw.defend` take. */
export interface LogInput {
  tx_hash: Hex;
  log_index: number;
  transaction_index: number;
  block_hash: Hex;
  block_number: number;
  address: Hex;
  data: Hex;
  topics: Hex[];
}

/** Addresses and data lowercased like the RPC; the MPC signs the RPC's raw `data` string. */
export const toLogInput = (l: Log): LogInput => ({
  tx_hash: l.transactionHash!,
  log_index: Number(l.logIndex),
  transaction_index: Number(l.transactionIndex),
  block_hash: l.blockHash!,
  block_number: Number(l.blockNumber),
  address: l.address.toLowerCase() as Hex,
  data: l.data.toLowerCase() as Hex,
  topics: l.topics.map((t) => t.toLowerCase()) as Hex[]
});

const encodeLog = (l: LogInput): Hex => {
  const data = new TextEncoder().encode(l.data);
  return concatHex([
    u8(0), // removed = false
    u64(BigInt(l.log_index)),
    u64(BigInt(l.transaction_index)),
    l.tx_hash,
    l.block_hash,
    u64(BigInt(l.block_number)),
    l.address,
    u32(data.length),
    toHex(data),
    u32(l.topics.length),
    ...l.topics
  ]);
};

/** sha256(borsh(ForeignTxSignPayload::V1{request, values})). `withBlockHash` prepends the BlockHash extractor. */
export const expectedPayloadHash = (
  l: LogInput,
  chain: MpcChain = 'Base',
  finality: MpcFinality = 'Safe',
  withBlockHash = false
): Hex => {
  const extractors = withBlockHash
    ? [u8(0), u8(1), u64(BigInt(l.log_index))]
    : [u8(1), u64(BigInt(l.log_index))];
  const values = withBlockHash
    ? [u8(1), u8(0), l.block_hash, u8(1), u8(1), encodeLog(l)]
    : [u8(1), u8(1), encodeLog(l)];
  return sha256(
    concatHex([
      u8(0), // ForeignTxSignPayload::V1
      u8(CHAIN_INDEX[chain]),
      l.tx_hash,
      u32(withBlockHash ? 2 : 1),
      ...extractors, // EvmExtractor: BlockHash = 0, Log{log_index} = 1
      u8(FINALITY_INDEX[finality]),
      u32(withBlockHash ? 2 : 1),
      ...values // ExtractedValue::Evm = 1, then EvmExtractedValue: BlockHash = 0, Log = 1
    ])
  );
};
