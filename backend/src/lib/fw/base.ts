import { concatHex, createPublicClient, formatLog, http, keccak256, numberToHex, toEventSelector, type Chain, type Hex, type Log, type PublicClient } from 'viem';
import * as chains from 'viem/chains';
import { BASE_NETWORK, BASE_RPC_URL, EVM_RPC_URLS } from '../../config/main-config.ts';
import { toLogInput, type LogInput, type MpcChain } from './mpcPayload.ts';

const TESTNET = BASE_NETWORK === 'baseSepolia';

// The networks each v1.signer reads (allowed_foreign_chain_providers, checked 2026-11-10).
const NETWORKS: Record<MpcChain, [Chain, Chain]> = {
  Base: [chains.base, chains.baseSepolia],
  Arbitrum: [chains.arbitrum, chains.arbitrumSepolia],
  Bnb: [chains.bsc, chains.bscTestnet],
  Polygon: [chains.polygon, chains.polygonAmoy],
  Avalanche: [chains.avalanche, chains.avalancheFuji],
  HyperEvm: [chains.hyperEvm, chains.hyperliquidEvmTestnet],
  Abstract: [chains.abstract, chains.abstractTestnet]
};

export const EVM_CHAINS = Object.keys(NETWORKS) as MpcChain[];
export const isEvmChain = (c: string): c is MpcChain => Object.hasOwn(NETWORKS, c);
export const evmNetwork = (c: MpcChain): Chain => NETWORKS[c][TESTNET ? 1 : 0];
/** Chains this server has an RPC for; others cannot be watched or reported here. */
export const servedChains = (): MpcChain[] => EVM_CHAINS.filter((c) => c === 'Base' || EVM_RPC_URLS[c]);

const clients = new Map<MpcChain, PublicClient>();
export const evmClient = (c: MpcChain): PublicClient => {
  const url = c === 'Base' ? BASE_RPC_URL : EVM_RPC_URLS[c];
  if (!url) throw new Error(`No RPC configured for ${c}`);
  if (!clients.has(c)) clients.set(c, createPublicClient({ chain: evmNetwork(c), transport: http(url, { retryCount: 3 }) }) as PublicClient);
  return clients.get(c)!;
};

export const baseClient: PublicClient = evmClient('Base');

/** The watcher's per-chain cursor; Base keeps its original id. */
export const cursorId = (c: MpcChain): string => (c === 'Base' ? `base:${BASE_NETWORK}` : `${c.toLowerCase()}:${BASE_NETWORK}`);

export const TOPICS = {
  Upgraded: toEventSelector('Upgraded(address)'),
  OwnershipTransferred: toEventSelector('OwnershipTransferred(address,address)'),
  RoleGranted: toEventSelector('RoleGranted(bytes32,address,address)'),
  // must equal ANNOUNCE_TOPIC in the fw contract
  Announce: toEventSelector('Announce(bytes32,address,bytes)')
} as const;

// topics assumed for rows registered before Protocol.watchedTopics; newer rows use their commitment's own
export const ADMIN_TOPICS: Hex[] = [TOPICS.Upgraded, TOPICS.OwnershipTransferred, TOPICS.RoleGranted];

/** keccak256(emitter ++ topics ++ data): the contract's `fingerprint` and Announcer's `actionHash`. */
export const fingerprint = (log: LogInput): Hex =>
  keccak256(concatHex([log.address, ...log.topics, log.data]));

/** Latest block at the given tag. The MPC refuses logs above the requested finality. */
export const finalityHead = async (finality: 'Safe' | 'Finalized', chain: MpcChain = 'Base'): Promise<bigint> => {
  const block = await evmClient(chain).getBlock({ blockTag: finality === 'Safe' ? 'safe' : 'finalized' });
  return block.number;
};

/** Logs from `addresses`; with `topic0s`, only those whose first topic is one of them (eth_getLogs ORs one position). */
export const getWatchedLogs = async (addresses: Hex[], fromBlock: bigint, toBlock: bigint, chain: MpcChain = 'Base', topic0s: Hex[] = []): Promise<Log[]> => {
  // viem's getLogs builds topics only from event ABIs; a commitment's topics are bare hashes
  const logs = await evmClient(chain).request({
    method: 'eth_getLogs',
    params: [{ address: addresses, topics: topic0s.length > 0 ? [topic0s] : [], fromBlock: numberToHex(fromBlock), toBlock: numberToHex(toBlock) }],
  });
  return logs.map((l) => formatLog(l));
};

// Providers cap eth_getLogs ranges: sepolia.base.org 200 blocks, Alchemy free 10 (checked 2026-11-10).
// A range error shrinks the chunk; a rate limit ("request limit reached") must not.
const RANGE_ERROR = /range|query returned more than|too many (results|logs)/i;
export const isRangeError = (e: unknown): boolean => {
  const err = e as { details?: string; shortMessage?: string; message?: string };
  return RANGE_ERROR.test(`${err.details ?? ''} ${err.shortMessage ?? ''} ${err.message ?? ''}`);
};

const MIN_CHUNK = 10n;

/**
 * Reads [from, head] in chunks of at most `state.chunk` blocks, up to `maxCalls` requests.
 * Halves `state.chunk` on a range error. Returns the logs and the last block fully read (from - 1 if none).
 */
export const readLogsAdaptive = async <L>(
  fetchLogs: (from: bigint, to: bigint) => Promise<L[]>,
  from: bigint,
  head: bigint,
  state: { chunk: bigint },
  maxCalls: number
): Promise<{ logs: L[]; lastRead: bigint }> => {
  const logs: L[] = [];
  let start = from;
  for (let calls = 0; calls < maxCalls && start <= head; calls++) {
    const end = start + state.chunk - 1n < head ? start + state.chunk - 1n : head;
    try {
      logs.push(...(await fetchLogs(start, end)));
      start = end + 1n;
    } catch (error) {
      if (!isRangeError(error) || state.chunk <= MIN_CHUNK) throw error;
      state.chunk = state.chunk / 2n < MIN_CHUNK ? MIN_CHUNK : state.chunk / 2n;
    }
  }
  return { logs, lastRead: start - 1n };
};

/** Logs in one tx emitted by any of `addresses`, ready for `fw.report`; the caller applies each bond's topics. */
export const logsInTx = async (txHash: Hex, addresses: string[], chain: MpcChain = 'Base'): Promise<LogInput[]> => {
  const receipt = await evmClient(chain).getTransactionReceipt({ hash: txHash });
  const watched = new Set(addresses.map((a) => a.toLowerCase()));
  return receipt.logs.map(toLogInput).filter((l) => watched.has(l.address) && l.topics.length > 0);
};
