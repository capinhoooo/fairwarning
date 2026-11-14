import { prismaQuery } from '../prisma.ts';
import { MAX_BACKFILL_BLOCKS } from '../../config/main-config.ts';
import { cursorId, finalityHead } from './base.ts';
import type { MpcChain } from './mpcPayload.ts';

type Scanned = { effectiveFromBlock: bigint; maxAnnounceAgeBlocks: number };

/** First block a bond needs read: an Announce defending its first breach may precede the start by maxAnnounceAgeBlocks. */
export const firstNeededBlock = (p: Scanned): bigint => {
  const b = p.effectiveFromBlock - BigInt(p.maxAnnounceAgeBlocks);
  return b < 0n ? 0n : b;
};

/** Registrations are permissionless: never re-read more than MAX_BACKFILL_BLOCKS behind the safe head. */
export const cappedStart = (from: bigint, head: bigint): bigint => {
  const floor = head - MAX_BACKFILL_BLOCKS;
  return from < floor ? floor : from;
};

/** Rewinds the chain cursor so a newly covered bond's history is read. Returns the new value, or null if it was already behind. */
export const backfillCursor = async (p: Scanned & { chain: MpcChain }): Promise<bigint | null> => {
  const head = await finalityHead('Safe', p.chain);
  const to = cappedStart(firstNeededBlock(p), head) - 1n;
  const { count } = await prismaQuery.cursor.updateMany({ where: { id: cursorId(p.chain), value: { gt: to } }, data: { value: to } });
  return count > 0 ? to : null;
};
