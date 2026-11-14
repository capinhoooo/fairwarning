import { FASTNEAR_API_KEY, NEAR_TX_API_URL } from '../../config/main-config.ts';

// FastNEAR Transactions API (https://docs.fastnear.com/tx.md): per-account index, then full receipts.

export interface FwEvent {
  receiptId: string;
  logIndex: number;
  txHash: string;
  blockHeight: bigint;
  event: string;
  data: Record<string, unknown>;
}

interface TxApiReceipt {
  execution_outcome: {
    id: string;
    block_height: number;
    outcome: { executor_id: string; logs: string[]; status: Record<string, unknown> };
  };
}

interface TxApiTransaction {
  transaction: { hash: string };
  receipts: TxApiReceipt[];
}

const EVENT_PREFIX = 'EVENT_JSON:';
const PAGE = 200;

const post = async <T>(path: string, body: unknown): Promise<T> => {
  const res = await fetch(`${NEAR_TX_API_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(FASTNEAR_API_KEY ? { Authorization: `Bearer ${FASTNEAR_API_KEY}` } : {})
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`FastNEAR tx API ${path} ${res.status}`);
  return (await res.json()) as T;
};

/** Tx hashes where `accountId` received a receipt, tx block height in [from, to). */
export const listTxHashes = async (accountId: string, from: number, to: number): Promise<string[]> => {
  const hashes = new Set<string>();
  let resumeToken: string | undefined;
  do {
    const page = await post<{ account_txs: { transaction_hash: string }[]; resume_token?: string }>('/v0/account', {
      account_id: accountId,
      is_receiver: true,
      from_tx_block_height: from,
      to_tx_block_height: to,
      desc: false,
      limit: PAGE,
      ...(resumeToken ? { resume_token: resumeToken } : {})
    });
    page.account_txs.forEach((row) => hashes.add(row.transaction_hash));
    resumeToken = page.account_txs.length === PAGE ? page.resume_token : undefined;
  } while (resumeToken);
  return [...hashes];
};

export const fetchTransactions = async (hashes: string[]): Promise<TxApiTransaction[]> => {
  const out: TxApiTransaction[] = [];
  for (let i = 0; i < hashes.length; i += 20) {
    const { transactions } = await post<{ transactions: TxApiTransaction[] }>('/v0/transactions', {
      tx_hashes: hashes.slice(i, i + 20)
    });
    out.push(...transactions);
  }
  return out;
};

/** Events from successful receipts executed by `contractId`; a failed receipt's logs describe reverted state. */
export const parseEvents = (tx: TxApiTransaction, contractId: string, standard: string): FwEvent[] => {
  const rows: FwEvent[] = [];
  for (const { execution_outcome: eo } of tx.receipts ?? []) {
    const { outcome } = eo;
    if (outcome.executor_id !== contractId) continue;
    if (!('SuccessValue' in outcome.status) && !('SuccessReceiptId' in outcome.status)) continue;
    outcome.logs.forEach((line, logIndex) => {
      if (!line.startsWith(EVENT_PREFIX)) return;
      try {
        const ev = JSON.parse(line.slice(EVENT_PREFIX.length));
        if (ev.standard !== standard) return;
        rows.push({
          receiptId: eo.id,
          logIndex,
          txHash: tx.transaction.hash,
          blockHeight: BigInt(eo.block_height),
          event: ev.event,
          data: ev.data ?? {}
        });
      } catch {
        console.warn(JSON.stringify({ lib: 'events', warn: 'unparseable_event', receipt: eo.id, logIndex }));
      }
    });
  }
  return rows;
};
