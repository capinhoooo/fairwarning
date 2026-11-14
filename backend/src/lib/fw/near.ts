import { createHash } from 'node:crypto';
import { Account, JsonRpcProvider, actions, baseEncode, teraToGas, type KeyPairString, type TxExecutionStatus } from 'near-api-js';
import {
  FASTNEAR_API_KEY,
  FW_CONTRACT_ID,
  NEAR_RPC_URL,
  REPORT_GAS_TGAS,
  WATCHER_ACCOUNT_ID,
  WATCHER_PRIVATE_KEY
} from '../../config/main-config.ts';
import type { LogInput } from './mpcPayload.ts';

// USDC storage_balance_bounds on NEAR; the contract requires exactly this for claim and claim_reward
const FT_STORAGE_YOCTO = 1_250_000_000_000_000_000_000n;

// Single provider on purpose: FailoverRpcProvider turns "key not found" into "Exceeded N providers" (NEP-413 verify).
export const nearProvider = new JsonRpcProvider(
  { url: NEAR_RPC_URL, headers: FASTNEAR_API_KEY ? { Authorization: `Bearer ${FASTNEAR_API_KEY}` } : undefined },
  { retries: 3, backoff: 2, wait: 500 }
);

// One Account per process so the nonce manager is shared across workers.
const watcher = new Account(WATCHER_ACCOUNT_ID, nearProvider, WATCHER_PRIVATE_KEY as KeyPairString);

export const fwView = async <T = unknown>(method: string, args: Record<string, unknown> = {}): Promise<T> =>
  (await nearProvider.callFunction({ contractId: FW_CONTRACT_ID, method, args, blockQuery: { finality: 'final' } })) as T;

export interface ChainCase {
  commitment_id: number;
  reporter: string;
  report_bond: string;
  tx_hash: string;
  log_index: number;
  breach_block: number;
  action_hash: string;
  status: 'Reported' | 'DefenceOpen' | 'Defended' | 'Breached' | 'Paid' | 'Rejected' | 'Moot';
  deadline: number;
  pending_defences: number;
  reward: string;
  pool: string;
  paid: string;
  claims: number;
  reward_paid: boolean;
  /** Depositor root frozen at finalize; claims verify against this one, not the commitment's current root. */
  root: { root: string; total: string; leaf_count: number; snapshot_block: number } | null;
}

export const getCommitment = (commitmentId: number) => fwView('get_commitment', { commitment_id: commitmentId });
export const isCovered = (commitmentId: number) => fwView<boolean>('is_covered', { commitment_id: commitmentId });
/** report_bond plus the contract's non-refundable storage fee, in yoctoNEAR. */
export const reportDeposit = async (commitmentId: number): Promise<bigint> =>
  BigInt(await fwView<string>('report_deposit', { commitment_id: commitmentId }));
export const getCase = (caseId: number) => fwView<ChainCase | null>('get_case', { case_id: caseId });

/** next_case from `config()`: (mpc, usdc, mpc_key, next_commitment, next_case). */
export const nextCaseId = async (): Promise<number> => {
  const cfg = await fwView<[string, string, string, number, number]>('config');
  return cfg[4];
};

export const currentNearHeight = async (): Promise<bigint> => {
  const block = await nearProvider.viewBlock({ finality: 'final' });
  return BigInt(block.header.height);
};

const call = async (
  methodName: string,
  args: Record<string, unknown>,
  { tgas = 30n, deposit = 0n, waitUntil = 'EXECUTED_OPTIMISTIC' }: { tgas?: bigint; deposit?: bigint; waitUntil?: TxExecutionStatus } = {}
): Promise<{ txHash: string; events: FwEvent[] }> => {
  const outcome = await watcher.callFunctionRaw({
    contractId: FW_CONTRACT_ID,
    methodName,
    args,
    deposit,
    gas: teraToGas(Number(tgas)),
    waitUntil
  });
  return { txHash: outcome.transaction.hash, events: fwEvents(outcome.receipts_outcome ?? []) };
};

export interface FwEvent {
  event: string;
  data: Record<string, unknown>;
}

/** NEP-297 events our contract logged in these receipts (callbacks included once the tx is executed). */
const fwEvents = (receipts: { outcome: { executor_id: string; logs: string[] } }[]): FwEvent[] =>
  receipts
    .filter((r) => r.outcome.executor_id === FW_CONTRACT_ID)
    .flatMap((r) => r.outcome.logs)
    .filter((l) => l.startsWith('EVENT_JSON:'))
    .map((l) => JSON.parse(l.slice('EVENT_JSON:'.length)) as { standard: string; event: string; data: unknown })
    .filter((e) => e.standard === 'fair_warning')
    .flatMap((e) => (Array.isArray(e.data) ? e.data : [e.data]).map((data) => ({ event: e.event, data: data as Record<string, unknown> })));

// report/defend yield on v1.signer for up to 200 blocks; return at inclusion and read the outcome from get_case.
export const report = (commitmentId: number, log: LogInput, deposit: bigint) =>
  call('report', { commitment_id: commitmentId, log }, { tgas: REPORT_GAS_TGAS, deposit, waitUntil: 'INCLUDED_FINAL' });

export const defend = (caseId: number, log: LogInput) =>
  call('defend', { case_id: caseId, log }, { tgas: REPORT_GAS_TGAS, waitUntil: 'INCLUDED_FINAL' });

export const finalize = (caseId: number) => call('finalize', { case_id: caseId }, { tgas: 30n });

export const claimReward = (caseId: number) =>
  call('claim_reward', { case_id: caseId }, { tgas: 60n, deposit: FT_STORAGE_YOCTO });

/**
 * Signs `claim` before sending and hands its hash to `onSigned`, so a send that times out can still be checked on chain.
 * Throws if the transaction failed; a released USDC transfer shows up as a `payout_failed` event instead.
 */
export const claim = async (
  c: { caseId: number; baseAddress: string; amount: string; proof: string[]; payTo: string; signature: string },
  onSigned: (txHash: string) => Promise<void>
): Promise<{ txHash: string; events: FwEvent[] }> => {
  const args = { case_id: c.caseId, base_address: c.baseAddress, amount: c.amount, proof: c.proof, pay_to: c.payTo, signature: c.signature };
  const signed = await watcher.createSignedTransaction({
    receiverId: FW_CONTRACT_ID,
    actions: [actions.functionCall('claim', args, teraToGas(60), FT_STORAGE_YOCTO)]
  });
  // NEAR tx hash = sha256(borsh(Transaction)), what the signer signs
  const txHash = baseEncode(createHash('sha256').update(signed.transaction.encode()).digest());
  await onSigned(txHash);
  const outcome = await nearProvider.sendTransactionUntil(signed, 'EXECUTED_OPTIMISTIC');
  if (typeof outcome.status === 'object' && outcome.status !== null && 'Failure' in outcome.status) {
    throw new Error(`claim ${txHash} failed: ${JSON.stringify(outcome.status.Failure)}`);
  }
  return { txHash, events: fwEvents(outcome.receipts_outcome ?? []) };
};

const EXECUTED = new Set(['EXECUTED_OPTIMISTIC', 'EXECUTED', 'FINAL']);

/** Outcome of a watcher tx: null while unknown or not yet executed. */
export const txOutcome = async (txHash: string): Promise<{ failed: boolean; events: FwEvent[] } | null> => {
  try {
    const r = await nearProvider.viewTransactionStatusWithReceipts({ txHash, accountId: WATCHER_ACCOUNT_ID, waitUntil: 'NONE' });
    if (!EXECUTED.has(String(r.final_execution_status))) return null;
    const failed = typeof r.status === 'object' && r.status !== null && 'Failure' in r.status;
    return { failed, events: fwEvents(r.receipts_outcome ?? []) };
  } catch (error) {
    if (/UNKNOWN_TRANSACTION|doesn't exist|not found/i.test((error as Error).message)) return null;
    throw error;
  }
};
