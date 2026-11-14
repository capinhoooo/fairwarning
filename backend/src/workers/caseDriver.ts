import cron from 'node-cron';
import { prismaQuery } from '../lib/prisma.ts';
import { finalityHead, isEvmChain } from '../lib/fw/base.ts';
import { coveringAnnouncement } from '../lib/fw/announcements.ts';
import { backfillCursor } from '../lib/fw/cursor.ts';
import {
  claimReward,
  currentNearHeight,
  defend,
  finalize,
  getCase,
  getCommitment,
  isCovered,
  nextCaseId,
  report,
  reportDeposit
} from '../lib/fw/near.ts';
import type { LogInput, MpcChain } from '../lib/fw/mpcPayload.ts';
import { AUTO_REPORT } from '../config/main-config.ts';

let isRunning = false;
const MAX_ATTEMPTS = 3;
// a defend tx is included before its receipt raises pending_defences; wait past that gap before retrying
const DEFENCE_RETRY_MS = 60_000;
const reportAttempts = new Map<string, number>();
const defenceAttempts = new Map<number, { count: number; at: number }>();
const rewardAttempts = new Map<number, number>();
const LIVE_STATUSES = ['Reported', 'DefenceOpen', 'Breached'];

/** Chain is the source of truth: mirror every live case and every active bond before acting on them. */
const syncState = async (): Promise<void> => {
  const next = await nextCaseId();
  const [live, newest] = await Promise.all([
    prismaQuery.case.findMany({ where: { status: { in: LIVE_STATUSES } }, select: { caseId: true } }),
    prismaQuery.case.findFirst({ orderBy: { caseId: 'desc' }, select: { caseId: true } })
  ]);
  const ids = new Set(live.map((c) => c.caseId));
  for (let id = (newest?.caseId ?? -1) + 1; id < next; id++) ids.add(id);

  for (const caseId of [...ids].sort((a, b) => a - b)) {
    const c = await getCase(caseId);
    if (!c) continue;
    const protocol = await prismaQuery.protocol.findUnique({ where: { commitmentId: c.commitment_id } });
    if (!protocol) continue; // commitment not registered in our index
    const txHash = `0x${c.tx_hash}`;
    const state = {
      status: c.status,
      actionHash: `0x${c.action_hash}`,
      breachBlock: BigInt(c.breach_block),
      deadline: c.deadline > 0 ? BigInt(c.deadline) : null,
      reward: c.reward,
      pool: c.pool,
      rewardPaid: c.reward_paid,
      pendingDefences: c.pending_defences
    };
    await prismaQuery.case.upsert({
      where: { caseId },
      create: { caseId, protocolId: protocol.id, txHash, logIndex: c.log_index, reporter: c.reporter, ...state },
      update: state
    });
    // the case's own bond's row points at its live case; a rejected case only claims it if nothing else has
    await prismaQuery.adminEvent.updateMany({
      where: { protocolId: protocol.id, txHash, logIndex: c.log_index, ...(c.status === 'Rejected' ? { caseId: null } : {}) },
      data: { caseId }
    });
  }

  const active = await prismaQuery.protocol.findMany({ where: { status: 'Committed' } });
  for (const p of active) {
    try {
      const [c, covered] = await Promise.all([
        getCommitment(p.commitmentId) as Promise<{ bond: string; status: string } | null>,
        isCovered(p.commitmentId)
      ]);
      if (!c || (c.bond === p.bond && c.status === p.status && covered === p.covered)) continue;
      // the watcher skipped this bond while uncovered; rewind first so a failed rewind is retried next tick
      if (covered && !p.covered && isEvmChain(p.chain)) {
        const to = await backfillCursor({ chain: p.chain, effectiveFromBlock: p.effectiveFromBlock, maxAnnounceAgeBlocks: p.maxAnnounceAgeBlocks });
        console.log(JSON.stringify({ worker: 'CaseDriver', action: 'backfill', protocol: p.slug, cursor: to?.toString() ?? null }));
      }
      await prismaQuery.protocol.update({ where: { id: p.id }, data: { bond: c.bond, status: c.status, covered } });
    } catch (error) {
      console.error(JSON.stringify({ worker: 'CaseDriver', action: 'sync_protocol', protocol: p.slug, error: (error as Error).message }));
    }
  }
};

const normTopic = (t: string): string => t.toLowerCase().replace(/^0x/, '');

/**
 * Breach logs with no live case: report once the protocol's finality has passed (the MPC rejects earlier).
 * Rows are per (bond, log), so a log policed by two bonds is reported under each commitment.
 */
const autoReport = async (): Promise<void> => {
  const rejected = await prismaQuery.case.findMany({ where: { status: 'Rejected' }, select: { caseId: true } });
  const exhausted = [...reportAttempts].filter(([, n]) => n >= MAX_ATTEMPTS).map(([id]) => id);
  // oldest first, exhausted rows out of the query: attacker-made events cannot crowd out real breaches
  const pending = await prismaQuery.adminEvent.findMany({
    where: {
      verdict: 'breach',
      id: { notIn: exhausted },
      protocol: { status: 'Committed', covered: true },
      OR: [{ caseId: null }, { caseId: { in: rejected.map((r) => r.caseId) } }]
    },
    include: { protocol: true },
    orderBy: { blockNumber: 'asc' },
    take: 20
  });
  const watchedTopics = new Map<number, Set<string> | null>();
  for (const ev of pending) {
    try {
      const cid = ev.protocol.commitmentId;
      if (!watchedTopics.has(cid)) {
        const c = (await getCommitment(cid)) as { params?: { watched_topics?: string[] } } | null;
        watchedTopics.set(cid, c?.params?.watched_topics ? new Set(c.params.watched_topics.map(normTopic)) : null);
      }
      // the contract refuses topics the commitment does not watch; never retry those
      if (!watchedTopics.get(cid)?.has(normTopic(ev.topic0))) {
        reportAttempts.set(ev.id, MAX_ATTEMPTS);
        continue;
      }
      if (ev.blockNumber > (await finalityHead(ev.protocol.finality as 'Safe' | 'Finalized', ev.protocol.chain as MpcChain))) continue;
      const tries = reportAttempts.get(ev.id) ?? 0;
      reportAttempts.set(ev.id, tries + 1);
      const deposit = await reportDeposit(cid);
      const out = await report(cid, ev.log as unknown as LogInput, deposit);
      console.log(JSON.stringify({ worker: 'CaseDriver', action: 'report', adminEvent: ev.id, attempt: tries + 1, result: out }));
    } catch (error) {
      console.error(JSON.stringify({ worker: 'CaseDriver', action: 'report', adminEvent: ev.id, error: (error as Error).message }));
    }
  }
};

/** Honest path: if we hold a valid Announce for the case, prove it; retry if the MPC rejected the last try. */
const autoDefend = async (): Promise<void> => {
  const height = await currentNearHeight();
  const open = await prismaQuery.case.findMany({ where: { status: 'DefenceOpen' }, include: { protocol: true } });
  for (const c of open) {
    if (!c.actionHash || c.breachBlock === null || c.pendingDefences > 0) continue;
    if (c.deadline !== null && height > c.deadline) continue; // contract refuses after the window
    const last = defenceAttempts.get(c.caseId);
    if (last && (last.count >= MAX_ATTEMPTS || Date.now() - last.at < DEFENCE_RETRY_MS)) continue;
    const ann = await coveringAnnouncement(c.protocol, c.actionHash, c.breachBlock);
    if (!ann) continue;
    if (BigInt((ann.log as unknown as LogInput).block_number) > (await finalityHead(c.protocol.finality as 'Safe' | 'Finalized', c.protocol.chain as MpcChain))) continue;
    defenceAttempts.set(c.caseId, { count: (last?.count ?? 0) + 1, at: Date.now() });
    try {
      const { txHash } = await defend(c.caseId, ann.log as unknown as LogInput);
      await prismaQuery.case.update({ where: { caseId: c.caseId }, data: { defenceTxHash: txHash } });
      console.log(JSON.stringify({ worker: 'CaseDriver', action: 'defend', caseId: c.caseId, attempt: (last?.count ?? 0) + 1, txHash }));
    } catch (error) {
      console.error('[CaseDriver] defend', c.caseId, (error as Error).message);
    }
  }
};

/** Anyone may finalize after the window; we do it so the demo never waits on a human. */
const autoFinalize = async (): Promise<void> => {
  const height = await currentNearHeight();
  const due = await prismaQuery.case.findMany({ where: { status: 'DefenceOpen', deadline: { lt: height } } });
  for (const c of due) await finalize(c.caseId).catch((e: Error) => console.error('[CaseDriver] finalize', c.caseId, e.message));
  const exhausted = [...rewardAttempts].filter(([, n]) => n >= MAX_ATTEMPTS).map(([id]) => id);
  const breached = await prismaQuery.case.findMany({ where: { status: 'Breached', rewardPaid: false, caseId: { notIn: exhausted } } });
  for (const c of breached) {
    // a zero reward (reward_bps 0 or an empty bond) only burns the watcher's storage deposit
    if (!c.reward || c.reward === '0') continue;
    rewardAttempts.set(c.caseId, (rewardAttempts.get(c.caseId) ?? 0) + 1);
    await claimReward(c.caseId).catch((e: Error) => console.error('[CaseDriver] reward', c.caseId, e.message));
  }
};

export const driveCases = async (): Promise<void> => {
  if (isRunning) {
    console.log('[CaseDriver] Previous run still active, skipping...');
    return;
  }
  isRunning = true;
  try {
    await syncState();
    if (AUTO_REPORT) await autoReport();
    await autoDefend();
    await autoFinalize();
  } catch (error) {
    console.error('[CaseDriver] Error:', error);
  } finally {
    isRunning = false;
  }
};

export const startCaseDriver = (): void => {
  console.log('[CaseDriver] Scheduled every 10s');
  cron.schedule('*/10 * * * * *', driveCases);
};
