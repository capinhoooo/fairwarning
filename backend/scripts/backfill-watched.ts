// Fills Protocol.watchedAddresses and watchedTopics from get_commitment for rows registered before those columns.
// Dry run by default; writes only with --apply. Usage: bun scripts/backfill-watched.ts [--apply]
import '../dotenv.ts';
import { prismaQuery } from '../src/lib/prisma.ts';
import { getCommitment } from '../src/lib/fw/near.ts';
import { watchedFromParams, type WatchedParams } from '../src/lib/fw/watched.ts';

const apply = process.argv.includes('--apply');
const out = (o: object): void => console.log(JSON.stringify(o));

const main = async (): Promise<number> => {
  const rows = await prismaQuery.protocol.findMany({
    where: { OR: [{ watchedAddresses: { isEmpty: true } }, { watchedTopics: { isEmpty: true } }] },
    orderBy: { commitmentId: 'asc' },
    select: { id: true, commitmentId: true, slug: true, vaultAddress: true },
  });
  out({ mode: apply ? 'apply' : 'dry-run', candidates: rows.length });
  let changed = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const c = (await getCommitment(row.commitmentId)) as { params?: WatchedParams } | null;
      if (!c?.params) throw new Error('commitment not found on chain');
      const next = watchedFromParams(c.params);
      // vaultAddress was watched[0] at registration; a mismatch means the row does not describe this commitment
      if (next.watchedAddresses[0] !== row.vaultAddress) throw new Error(`watched[0] ${next.watchedAddresses[0]} differs from vaultAddress ${row.vaultAddress}`);
      out({ commitmentId: row.commitmentId, slug: row.slug, watchedAddresses: next.watchedAddresses, watchedTopics: next.watchedTopics });
      if (apply) {
        // guarded so a re-run or a concurrent registration is never overwritten
        const { count } = await prismaQuery.protocol.updateMany({
          where: { id: row.id, OR: [{ watchedAddresses: { isEmpty: true } }, { watchedTopics: { isEmpty: true } }] },
          data: next,
        });
        if (count === 1) changed++;
      }
    } catch (error) {
      failed++;
      out({ commitmentId: row.commitmentId, slug: row.slug, error: (error as Error).message });
    }
  }
  out(apply ? { mode: 'apply', updated: changed, failed } : { mode: 'dry-run', wouldUpdate: rows.length - failed, failed });
  return failed > 0 ? 1 : 0;
};

main()
  .then((code) => (process.exitCode = code))
  .catch((error) => {
    console.error(JSON.stringify({ event: 'backfill_failed', error: (error as Error).message }));
    process.exitCode = 1;
  })
  .finally(() => prismaQuery.$disconnect());
