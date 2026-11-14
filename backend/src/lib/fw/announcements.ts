import { prismaQuery } from '../prisma.ts';
import { addressesOf } from './watched.ts';

type Policed = { announcerAddress: string; noticeBlocks: number; maxAnnounceAgeBlocks: number };

/**
 * Announcements for a protocol's watched targets. Rows are unique per log and stored under the first protocol that saw
 * them, so match on what the contract checks: the same Announcer, and an expectedLog emitted by a watched address.
 */
export const announcedFor = (p: { vaultAddress: string; watchedAddresses: string[]; announcerAddress: string }) => ({
  protocol: { announcerAddress: p.announcerAddress },
  // saveAnnouncement only keeps logs whose expectedLog starts with their target
  OR: addressesOf(p).map((a) => ({ expectedLog: { startsWith: a } })),
});

/**
 * The newest announcement of `actionHash` early enough, and recent enough, to defend an admin log at `block`.
 * actionHash hashes the emitter, so it already pins the target; only the Announcer must match.
 */
export const coveringAnnouncement = (p: Policed, actionHash: string, block: bigint) =>
  prismaQuery.announcement.findFirst({
    where: {
      protocol: { announcerAddress: p.announcerAddress },
      actionHash,
      blockNumber: { lte: block - BigInt(p.noticeBlocks), gte: block - BigInt(p.maxAnnounceAgeBlocks) },
    },
    orderBy: { blockNumber: 'desc' },
  });
