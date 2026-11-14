import cron from 'node-cron';
import { prismaQuery } from '../lib/prisma.ts';
import {
  FW_CONTRACT_ID,
  INDEXER_FINALITY_LAG,
  INDEXER_MAX_SPAN,
  INDEXER_START_HEIGHT,
  NEAR_NETWORK
} from '../config/main-config.ts';
import { currentNearHeight } from '../lib/fw/near.ts';
import { fetchTransactions, listTxHashes, parseEvents, type FwEvent } from '../lib/fw/events.ts';

// History only (tx hashes, payouts). Case status comes from get_case in caseDriver: this feed lags
// 250 blocks and would overwrite newer state with older state.
let isRunning = false;
const CURSOR_ID = `near:${NEAR_NETWORK}:${FW_CONTRACT_ID}`;

const handle = async (e: FwEvent): Promise<void> => {
  const d = e.data;
  const caseId = d.case_id as number | undefined;
  switch (e.event) {
    case 'reported': {
      const protocol = await prismaQuery.protocol.findUnique({ where: { commitmentId: d.commitment_id as number } });
      if (!protocol) return;
      const txHash = `0x${d.tx_hash as string}`;
      await prismaQuery.case.upsert({
        where: { caseId: caseId! },
        create: {
          caseId: caseId!,
          protocolId: protocol.id,
          txHash,
          logIndex: d.log_index as number,
          reporter: d.reporter as string,
          status: 'Reported'
        },
        update: {}
      });
      // another bond on the same log has its own row and its own case
      await prismaQuery.adminEvent.updateMany({ where: { protocolId: protocol.id, txHash, logIndex: d.log_index as number }, data: { caseId } });
      return;
    }
    case 'defended':
      await prismaQuery.case.updateMany({ where: { caseId: caseId! }, data: { defenceTxHash: e.txHash } });
      return;
    case 'breached':
      await prismaQuery.case.updateMany({ where: { caseId: caseId! }, data: { finalizeTxHash: e.txHash } });
      return;
    case 'paid':
    case 'payout_failed': {
      const kind = d.kind as string;
      const status = e.event === 'paid' ? 'paid' : 'failed';
      if (kind === 'reward') {
        await prismaQuery.payout.upsert({
          where: { caseId_kind_baseAddress: { caseId: caseId!, kind, baseAddress: '' } },
          create: {
            caseId: caseId!,
            kind,
            baseAddress: '',
            amount: d.amount as string,
            payTo: d.recipient as string,
            route: 'near',
            status,
            nearTxHash: e.txHash
          },
          update: { status, nearTxHash: e.txHash }
        });
        return;
      }
      await prismaQuery.payout.updateMany({
        where: { caseId: caseId!, kind, payTo: d.recipient as string, amount: d.amount as string, status: 'submitted' },
        data: { status, nearTxHash: e.txHash }
      });
      return;
    }
  }
};

const indexNearEvents = async (): Promise<void> => {
  if (isRunning) {
    console.log('[NearEventIndexer] Previous run still active, skipping...');
    return;
  }
  isRunning = true;
  try {
    const cursor = await prismaQuery.cursor.findUnique({ where: { id: CURSOR_ID } });
    const from = cursor ? Number(cursor.value) : INDEXER_START_HEIGHT;
    const safeHead = Number(await currentNearHeight()) - INDEXER_FINALITY_LAG;
    if (from === 0 || safeHead <= from) return;
    const to = Math.min(safeHead, from + INDEXER_MAX_SPAN);

    const txs = await fetchTransactions(await listTxHashes(FW_CONTRACT_ID, from, to));
    const events = txs
      .flatMap((tx) => parseEvents(tx, FW_CONTRACT_ID, 'fair_warning'))
      .sort((a, b) => Number(a.blockHeight - b.blockHeight) || a.logIndex - b.logIndex);
    // handlers are idempotent, so a crash before the cursor moves only replays this window
    for (const e of events) await handle(e);
    await prismaQuery.cursor.upsert({ where: { id: CURSOR_ID }, create: { id: CURSOR_ID, value: BigInt(to) }, update: { value: BigInt(to) } });
    if (events.length > 0) console.log(JSON.stringify({ worker: 'NearEventIndexer', events: events.length, from, to }));
  } catch (error) {
    console.error('[NearEventIndexer] Error:', error);
  } finally {
    isRunning = false;
  }
};

export const startNearEventIndexer = (): void => {
  if (!INDEXER_START_HEIGHT) console.warn('[NearEventIndexer] INDEXER_START_HEIGHT unset; history indexing disabled');
  console.log('[NearEventIndexer] Scheduled every 10s');
  cron.schedule('*/10 * * * * *', indexNearEvents);
  indexNearEvents();
};
