import cron from 'node-cron';
import { prismaQuery } from '../lib/prisma.ts';
import { FW_CONTRACT_ID } from '../config/main-config.ts';
import { claim, txOutcome } from '../lib/fw/near.ts';
import { getStatus, submitDeposit } from '../lib/fw/oneClick.ts';

let isRunning = false;
const TERMINAL = new Set(['SUCCESS', 'REFUNDED', 'FAILED']);
// a NEAR tx the RPC still does not know this long after sending was dropped
const UNKNOWN_TX_GIVE_UP_MS = 10 * 60_000;
const RELEASED = 'USDC transfer failed; the claim was released';

/** Applies a claim tx's own receipts. Returns false while the tx is unknown or not yet executed. */
const settleFromChain = async (payoutId: string, txHash: string): Promise<boolean> => {
  const out = await txOutcome(txHash);
  if (!out) return false;
  const paid = out.events.some((e) => e.event === 'paid');
  const error = paid ? null : out.failed ? 'Claim transaction failed' : RELEASED;
  await prismaQuery.payout.update({ where: { id: payoutId }, data: { status: paid ? 'paid' : 'failed', error } });
  console.log(JSON.stringify({ worker: 'PayoutRunner', action: 'settle', payout: payoutId, txHash, paid }));
  return true;
};

/** User-signed claims queued by POST /fw/claims; the watcher relays them and pays USDC storage. */
const relayClaims = async (): Promise<void> => {
  const queued = await prismaQuery.payout.findMany({ where: { status: 'queued', kind: 'depositor' }, take: 5 });
  for (const p of queued) {
    await prismaQuery.payout.update({ where: { id: p.id }, data: { status: 'submitted', nearTxHash: null, error: null } });
    let txHash: string | null = null;
    try {
      const out = await claim(
        {
          caseId: p.caseId,
          baseAddress: p.baseAddress!,
          // the contract hashes the leaf amount into the merkle leaf and recomputes the share itself
          amount: p.leafAmount!,
          proof: p.proof as string[],
          payTo: p.payTo,
          signature: p.signature!,
        },
        async (hash) => {
          txHash = hash;
          await prismaQuery.payout.update({ where: { id: p.id }, data: { nearTxHash: hash } });
        },
      );
      // the claim's own receipts say whether USDC moved; the event indexer is optional
      const settled = out.events.find((e) => e.event === 'paid' || e.event === 'payout_failed');
      if (settled) {
        await prismaQuery.payout.update({
          where: { id: p.id },
          data: { status: settled.event === 'paid' ? 'paid' : 'failed', ...(settled.event === 'paid' ? {} : { error: RELEASED }) },
        });
      }
      console.log(JSON.stringify({ worker: 'PayoutRunner', action: 'claim', payout: p.id, txHash: out.txHash, settled: settled?.event ?? null }));
    } catch (error) {
      const message = (error as Error).message;
      console.error(JSON.stringify({ worker: 'PayoutRunner', action: 'claim', payout: p.id, txHash, error: message }));
      // a timed-out send may still have landed: only the chain can say the claim failed
      const settled = txHash ? await settleFromChain(p.id, txHash).catch(() => false) : false;
      if (!settled && !txHash) await prismaQuery.payout.update({ where: { id: p.id }, data: { status: 'failed', error: message } });
      else if (!settled) await prismaQuery.payout.update({ where: { id: p.id }, data: { error: message } });
    }
  }
};

/** Claims left 'submitted' (timed-out send, crash, or no settle event yet): read their tx until it resolves. */
const reconcileSubmitted = async (): Promise<void> => {
  const stuck = await prismaQuery.payout.findMany({ where: { status: 'submitted', kind: 'depositor' }, take: 10, orderBy: { updatedAt: 'asc' } });
  for (const p of stuck) {
    try {
      if (p.nearTxHash && (await settleFromChain(p.id, p.nearTxHash))) continue;
      // never signed, or dropped by the RPC; a late landing cannot pay twice since the contract marks the leaf claimed
      if (!p.nearTxHash || Date.now() - p.updatedAt.getTime() > UNKNOWN_TX_GIVE_UP_MS) {
        await prismaQuery.payout.update({ where: { id: p.id }, data: { status: 'failed', error: p.error ?? 'Claim transaction not found' } });
      }
    } catch (error) {
      console.error(JSON.stringify({ worker: 'PayoutRunner', action: 'reconcile', payout: p.id, error: (error as Error).message }));
    }
  }
};

/** fw paid the 1Click deposit address on NEAR; tell 1Click, then follow the bridge leg to Base/Solana. */
const trackOneClick = async (): Promise<void> => {
  const legs = await prismaQuery.payout.findMany({ where: { route: '1click', status: 'paid' } });
  for (const p of legs) {
    if (!p.oneClickStatus && p.nearTxHash) {
      await submitDeposit(p.nearTxHash, p.payTo, FW_CONTRACT_ID).catch((e: Error) => console.error('[PayoutRunner] submit', e.message));
    }
    const s = await getStatus(p.payTo);
    await prismaQuery.payout.update({
      where: { id: p.id },
      data: { oneClickStatus: s.status, ...(TERMINAL.has(s.status) ? { status: s.status === 'SUCCESS' ? 'bridged' : 'failed' } : {}) },
    });
  }
};

export const runPayouts = async (): Promise<void> => {
  if (isRunning) return;
  isRunning = true;
  try {
    await relayClaims();
    await reconcileSubmitted();
    await trackOneClick();
  } catch (error) {
    console.error('[PayoutRunner] Error:', error);
  } finally {
    isRunning = false;
  }
};

export const startPayoutRunner = (): void => {
  console.log('[PayoutRunner] Scheduled every 10s');
  cron.schedule('*/10 * * * * *', runPayouts);
};
