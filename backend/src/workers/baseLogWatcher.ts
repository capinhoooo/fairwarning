import cron from 'node-cron';
import { decodeAbiParameters, keccak256, type Hex } from 'viem';
import { prismaQuery } from '../lib/prisma.ts';
import { BASE_LOG_CHUNK } from '../config/main-config.ts';
import { addressesOf, topicsOf, watches } from '../lib/fw/watched.ts';
import { TOPICS, cursorId, fingerprint, finalityHead, getWatchedLogs, isEvmChain, readLogsAdaptive, servedChains } from '../lib/fw/base.ts';
import { toLogInput, type LogInput, type MpcChain } from '../lib/fw/mpcPayload.ts';
import type { Protocol } from '../../prisma/generated/client.js';
import { coveringAnnouncement } from '../lib/fw/announcements.ts';
import { cappedStart, firstNeededBlock } from '../lib/fw/cursor.ts';

let isRunning = false;
// Base makes ~5 blocks/s (25 per tick); 20 calls per tick catch up even at a 10-block provider cap
const MAX_CALLS_PER_TICK = 20;
const MAX_LOG_RETRIES = 3;
const chunkStates = new Map<MpcChain, { chunk: bigint }>();
const logFailures = new Map<string, number>();

/** One AdminEvent per (bond, log): every bond whose commitment polices the log can open its own case. */
export const classify = async (p: Protocol, log: LogInput): Promise<void> => {
  const block = BigInt(log.block_number);
  if (block < p.effectiveFromBlock || !watches(p, log)) return;
  const fp = fingerprint(log);
  const ann = await coveringAnnouncement(p, fp, block);
  const verdict = ann ? 'announced' : 'breach';
  await prismaQuery.adminEvent.upsert({
    where: { protocolId_txHash_logIndex: { protocolId: p.id, txHash: log.tx_hash, logIndex: log.log_index } },
    create: {
      protocolId: p.id,
      topic0: log.topics[0],
      txHash: log.tx_hash,
      logIndex: log.log_index,
      blockNumber: block,
      fingerprint: fp,
      log: log as object,
      verdict,
      announcementId: ann?.id,
    },
    // a re-scan (after a cursor rewind) may find an announcement indexed since; the verdict follows it
    update: { verdict, announcementId: ann?.id ?? null },
  });
  console.log(JSON.stringify({ worker: 'BaseLogWatcher', event: 'admin_log', protocol: p.slug, tx: log.tx_hash, verdict }));
};

/** An Announce log belongs to (announcer, target): one Announcer contract can serve many watched addresses. */
export const saveAnnouncement = async (candidates: Protocol[], log: LogInput): Promise<void> => {
  // Announcer addresses are attacker-chosen: a malformed Announce is skipped, never retried
  if (log.topics.length !== 3) return;
  const target = `0x${log.topics[2].slice(26)}`.toLowerCase();
  const p = candidates.find((x) => addressesOf(x).includes(target));
  if (!p) return;
  let expectedLog: Hex;
  try {
    [expectedLog] = decodeAbiParameters([{ type: 'bytes' }], log.data);
  } catch {
    console.log(JSON.stringify({ worker: 'BaseLogWatcher', event: 'announce_undecodable', tx: log.tx_hash, logIndex: log.log_index }));
    return;
  }
  // fw.defend refuses these (check_defence); storing one would mark a real breach as announced and stop its report
  if (keccak256(expectedLog) !== log.topics[1] || expectedLog.length < 42 || expectedLog.slice(0, 42).toLowerCase() !== target) {
    console.log(JSON.stringify({ worker: 'BaseLogWatcher', event: 'announce_inconsistent', tx: log.tx_hash, logIndex: log.log_index }));
    return;
  }
  await prismaQuery.announcement.upsert({
    where: { txHash_logIndex: { txHash: log.tx_hash, logIndex: log.log_index } },
    create: {
      protocolId: p.id,
      actionHash: log.topics[1],
      expectedLog,
      txHash: log.tx_hash,
      logIndex: log.log_index,
      blockNumber: BigInt(log.block_number),
      log: log as object,
    },
    update: {},
  });
};

const watchChain = async (chain: MpcChain, protocols: Protocol[]): Promise<void> => {
  // classify at Safe; caseDriver only reports once the protocol's own finality has passed
  const head = await finalityHead('Safe', chain);
  const id = cursorId(chain);
  const cursor = await prismaQuery.cursor.findUnique({ where: { id } });
  const start = cursor
    ? cursor.value + 1n
    : cappedStart(protocols.reduce((m, p) => (firstNeededBlock(p) < m ? firstNeededBlock(p) : m), head), head);
  if (start > head) return;

  // several bonds may police one address; each is classified on its own
  const byAddress = new Map<string, Protocol[]>();
  const byAnnouncer = new Map<string, Protocol[]>();
  for (const p of protocols) {
    for (const a of addressesOf(p)) byAddress.set(a, [...(byAddress.get(a) ?? []), p]);
    byAnnouncer.set(p.announcerAddress, [...(byAnnouncer.get(p.announcerAddress) ?? []), p]);
  }
  const addresses = [...new Set([...byAddress.keys(), ...byAnnouncer.keys()])] as Hex[];
  const topics = [...new Set([...protocols.flatMap(topicsOf), TOPICS.Announce])] as Hex[];
  if (!chunkStates.has(chain)) chunkStates.set(chain, { chunk: BASE_LOG_CHUNK });
  const { logs: raw, lastRead: end } = await readLogsAdaptive(
    (from, to) => getWatchedLogs(addresses, from, to, chain, topics),
    start,
    head,
    chunkStates.get(chain)!,
    MAX_CALLS_PER_TICK
  );
  if (end < start) return;
  const logs = raw.map(toLogInput).sort((a, b) => a.block_number - b.block_number || a.log_index - b.log_index);

  // the cursor stays below a failed log so it is retried, but only MAX_LOG_RETRIES times: one bad log cannot freeze the chain
  let holdBelow: bigint | null = null;
  for (const log of logs) {
    try {
      if (log.topics[0] === TOPICS.Announce && byAnnouncer.has(log.address)) await saveAnnouncement(byAnnouncer.get(log.address)!, log);
      // classify checks each bond's own topics and start block; upserts make a retry of this log idempotent
      for (const p of byAddress.get(log.address) ?? []) await classify(p, log);
    } catch (error) {
      const key = `${chain}:${log.tx_hash}:${log.log_index}`;
      const attempt = (logFailures.get(key) ?? 0) + 1;
      const skipped = attempt >= MAX_LOG_RETRIES;
      if (skipped) logFailures.delete(key);
      else logFailures.set(key, attempt);
      if (!skipped && holdBelow === null) holdBelow = BigInt(log.block_number);
      console.error(
        JSON.stringify({ worker: 'BaseLogWatcher', event: 'log_failed', chain, tx: log.tx_hash, logIndex: log.log_index, block: log.block_number, attempt, skipped, error: (error as Error).message })
      );
    }
  }
  const advanceTo = holdBelow !== null && holdBelow - 1n < end ? holdBelow - 1n : end;
  if (advanceTo < start) return;
  if (cursor) {
    // compare-and-set: a registration may have rewound the cursor during this tick; its value wins
    const { count } = await prismaQuery.cursor.updateMany({ where: { id, value: cursor.value }, data: { value: advanceTo } });
    if (count === 0) console.log(JSON.stringify({ worker: 'BaseLogWatcher', event: 'cursor_moved_mid_tick', chain }));
  } else {
    await prismaQuery.cursor.create({ data: { id, value: advanceTo } }).catch((error: { code?: string }) => {
      if (error.code !== 'P2002') throw error;
    });
  }
};

export const watchBaseLogs = async (): Promise<void> => {
  if (isRunning) {
    console.log('[BaseLogWatcher] Previous run still active, skipping...');
    return;
  }
  isRunning = true;
  try {
    // an uncovered bond cannot pay out; it joins (with a capped backfill) once caseDriver sees it covered
    const protocols = await prismaQuery.protocol.findMany({ where: { status: 'Committed', covered: true } });
    const served = servedChains();
    for (const chain of served) {
      const own = protocols.filter((p) => isEvmChain(p.chain) && p.chain === chain);
      if (own.length === 0) continue;
      // one slow or failing chain must not stall the others
      await watchChain(chain, own).catch((error) => console.error(`[BaseLogWatcher] ${chain} error:`, error));
    }
  } catch (error) {
    console.error('[BaseLogWatcher] Error:', error);
  } finally {
    isRunning = false;
  }
};

export const startBaseLogWatcher = (): void => {
  console.log('[BaseLogWatcher] Scheduled every 5s');
  cron.schedule('*/5 * * * * *', watchBaseLogs);
  watchBaseLogs();
};
