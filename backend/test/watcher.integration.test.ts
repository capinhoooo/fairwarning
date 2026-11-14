import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { encodeAbiParameters, pad, type Hex, type Log } from 'viem';
import type { LogInput } from '../src/lib/fw/mpcPayload.ts';

// a fake chain for watchBaseLogs: safe head plus every log it holds; `during` runs inside the tick
const evm = { head: 0n, logs: [] as LogInput[], reads: [] as bigint[], topics: [] as Hex[][], during: null as null | (() => Promise<void>) };
const realBase = await import('../src/lib/fw/base.ts');
mock.module('../src/lib/fw/base.ts', () => ({
  ...realBase,
  finalityHead: async () => evm.head,
  // applies the topic0 filter the way eth_getLogs does, so a topic left out of the request is never seen
  getWatchedLogs: async (addresses: Hex[], from: bigint, to: bigint, _chain?: string, topic0s: Hex[] = []) => {
    evm.reads.push(from);
    evm.topics.push(topic0s);
    if (evm.during) await evm.during();
    const want = new Set(addresses.map((a) => a.toLowerCase()));
    return evm.logs
      .filter((l) => want.has(l.address) && (topic0s.length === 0 || topic0s.includes(l.topics[0])) && BigInt(l.block_number) >= from && BigInt(l.block_number) <= to)
      .map((l) => ({ ...l, transactionHash: l.tx_hash, logIndex: l.log_index, transactionIndex: l.transaction_index, blockHash: l.block_hash, blockNumber: BigInt(l.block_number) }) as unknown as Log);
  },
}));

const { prismaQuery } = await import('../src/lib/prisma.ts');
const { TOPICS, fingerprint, cursorId } = await import('../src/lib/fw/base.ts');
const { classify, saveAnnouncement, watchBaseLogs } = await import('../src/workers/baseLogWatcher.ts');
const CURSOR = cursorId('Base');

// One Announcer contract serving two vaults, the setup the web app defaults to.
const ANNOUNCER = '0x00000000000000000000000000000000000000aa' as Hex;
const VAULT_A = '0x00000000000000000000000000000000000000a1' as Hex;
const VAULT_B = '0x00000000000000000000000000000000000000b1' as Hex;
const VAULT_C = '0x00000000000000000000000000000000000000c1' as Hex;
const NOTICE = 300;

// each test upgrades to its own implementation, so announcements never cover another test's change
const upgradeLog = (vault: Hex, block: number, seed: string): LogInput => ({
  tx_hash: `0x${seed.repeat(64)}` as Hex,
  log_index: 0,
  transaction_index: 0,
  block_hash: `0x${'e'.repeat(64)}`,
  block_number: block,
  address: vault,
  data: '0x',
  topics: [TOPICS.Upgraded, pad(`0x${seed.repeat(40)}` as Hex)],
});
const announceLog = (vault: Hex, upgrade: LogInput, block: number, seed: string): LogInput => {
  const expected = `${upgrade.address}${upgrade.topics.map((t) => t.slice(2)).join('')}` as Hex;
  return {
    tx_hash: `0x${seed.repeat(64)}` as Hex,
    log_index: 1,
    transaction_index: 0,
    block_hash: `0x${'f'.repeat(64)}`,
    block_number: block,
    address: ANNOUNCER,
    data: encodeAbiParameters([{ type: 'bytes' }], [expected]),
    topics: [TOPICS.Announce, fingerprint(upgrade), pad(vault)],
  };
};

const roleLog = (vault: Hex, block: number, seed: string): LogInput => ({
  ...upgradeLog(vault, block, seed),
  topics: [TOPICS.RoleGranted, pad('0x01'), pad(`0x${seed.repeat(40)}` as Hex), pad(`0x${seed.repeat(40)}` as Hex)],
});

type Extra = { effectiveFromBlock?: bigint; maxAnnounceAgeBlocks?: number; covered?: boolean; watchedAddresses?: string[]; watchedTopics?: string[] };
const protocol = (commitmentId: number, slug: string, vault: Hex, extra: Extra = {}) =>
  prismaQuery.protocol.create({
    data: {
      commitmentId,
      slug,
      name: slug,
      vaultAddress: vault,
      announcerAddress: ANNOUNCER,
      ownerNearAccount: 'owner.testnet',
      noticeBlocks: NOTICE,
      maxAnnounceAgeBlocks: 10_000,
      effectiveFromBlock: 0n,
      finality: 'Safe',
      defenceWindow: 300,
      ...extra,
    },
  });

let a: Awaited<ReturnType<typeof protocol>>, b: Awaited<ReturnType<typeof protocol>>;
beforeAll(async () => {
  await prismaQuery.payout.deleteMany();
  await prismaQuery.case.deleteMany();
  await prismaQuery.adminEvent.deleteMany();
  await prismaQuery.announcement.deleteMany();
  await prismaQuery.beneficiaryRoot.deleteMany();
  await prismaQuery.protocol.deleteMany();
  a = await protocol(100, 'shared-a', VAULT_A);
  b = await protocol(101, 'shared-b', VAULT_B);
});
afterAll(async () => {
  await prismaQuery.adminEvent.deleteMany();
  await prismaQuery.announcement.deleteMany();
  await prismaQuery.protocol.deleteMany();
  await prismaQuery.cursor.deleteMany({ where: { id: CURSOR } });
});

describe('a shared Announcer', () => {
  test("announcing for vault B is not dropped because vault A shares the Announcer", async () => {
    const up = upgradeLog(VAULT_B, 5_000, '1');
    await saveAnnouncement([a, b], announceLog(VAULT_B, up, 5_000 - NOTICE - 10, '2'));
    await classify(b, up);
    const ev = await prismaQuery.adminEvent.findFirst({ where: { protocolId: b.id } });
    expect(ev?.verdict).toBe('announced');
  });

  test('an announcement for vault A does not cover the same change on vault B', async () => {
    const upA = upgradeLog(VAULT_A, 6_000, '3');
    await saveAnnouncement([a, b], announceLog(VAULT_A, upA, 6_000 - NOTICE - 10, '4'));
    // the same new implementation, but on vault B
    const upB = { ...upgradeLog(VAULT_B, 6_000, '3'), tx_hash: `0x${'5'.repeat(64)}` as Hex };
    await classify(b, upB);
    const ev = await prismaQuery.adminEvent.findUnique({ where: { protocolId_txHash_logIndex: { protocolId: b.id, txHash: upB.tx_hash, logIndex: 0 } } });
    expect(ev?.verdict).toBe('breach');
  });

  test('a second bond on the same vault sees an announcement first stored under the older bond', async () => {
    const older = await protocol(102, 'same-vault-old', VAULT_A);
    const newer = await protocol(103, 'same-vault-new', VAULT_A);
    const up = upgradeLog(VAULT_A, 8_000, '8');
    await saveAnnouncement([older, newer], announceLog(VAULT_A, up, 8_000 - NOTICE - 10, '9'));
    await classify(newer, up);
    expect((await prismaQuery.adminEvent.findUnique({ where: { protocolId_txHash_logIndex: { protocolId: newer.id, txHash: up.tx_hash, logIndex: 0 } } }))?.verdict).toBe('announced');
  });

  test('a re-scan corrects a breach verdict once the announcement is indexed', async () => {
    const up = upgradeLog(VAULT_A, 7_000, '6');
    const key = { protocolId_txHash_logIndex: { protocolId: a.id, txHash: up.tx_hash, logIndex: 0 } };
    await classify(a, up);
    expect((await prismaQuery.adminEvent.findUnique({ where: key }))?.verdict).toBe('breach');
    await saveAnnouncement([a, b], announceLog(VAULT_A, up, 7_000 - NOTICE - 10, '7'));
    await classify(a, up);
    expect((await prismaQuery.adminEvent.findUnique({ where: key }))?.verdict).toBe('announced');
  });

  test('an announcement stored under a bond watching [A, C] covers a bond watching only C', async () => {
    const wide = await protocol(104, 'wide', VAULT_A, { watchedAddresses: [VAULT_A, VAULT_C] });
    const narrow = await protocol(105, 'narrow', VAULT_C, { watchedAddresses: [VAULT_C] });
    const up = upgradeLog(VAULT_C, 8_500, 'c');
    await saveAnnouncement([wide, narrow], announceLog(VAULT_C, up, 8_500 - NOTICE - 10, 'd'));
    expect((await prismaQuery.announcement.findFirst({ where: { txHash: `0x${'d'.repeat(64)}` } }))?.protocolId).toBe(wide.id);
    await classify(narrow, up);
    const ev = await prismaQuery.adminEvent.findUnique({ where: { protocolId_txHash_logIndex: { protocolId: narrow.id, txHash: up.tx_hash, logIndex: 0 } } });
    expect(ev?.verdict).toBe('announced');
  });
});

describe('malformed Announce logs', () => {
  test('an Announce without three topics, or with undecodable data, is skipped without throwing', async () => {
    const up = upgradeLog(VAULT_B, 9_000, 'a');
    const good = announceLog(VAULT_B, up, 8_000, 'b');
    await saveAnnouncement([a, b], { ...good, topics: good.topics.slice(0, 2) });
    await saveAnnouncement([a, b], { ...good, data: '0x1234' });
    expect(await prismaQuery.announcement.count({ where: { txHash: good.tx_hash } })).toBe(0);
  });

  test('an Announce fw.defend would refuse is not stored: actionHash or target not matching expectedLog', async () => {
    const up = upgradeLog(VAULT_B, 9_000, 'a');
    const good = announceLog(VAULT_B, up, 8_000, 'b');
    await saveAnnouncement([a, b], { ...good, topics: [good.topics[0], pad('0x1234'), good.topics[2]] });
    // expectedLog is vault A's upgrade, announced for vault B
    await saveAnnouncement([a, b], announceLog(VAULT_B, upgradeLog(VAULT_A, 9_000, 'a'), 8_000, 'b'));
    expect(await prismaQuery.announcement.count({ where: { txHash: good.tx_hash } })).toBe(0);
    await saveAnnouncement([a, b], good);
    expect(await prismaQuery.announcement.count({ where: { txHash: good.tx_hash } })).toBe(1);
  });
});

describe('watchBaseLogs', () => {
  const cursor = async () => (await prismaQuery.cursor.findUnique({ where: { id: CURSOR } }))?.value ?? null;
  // these tests have one bond per log unless they say otherwise
  const verdictOf = async (log: LogInput) =>
    (await prismaQuery.adminEvent.findFirst({ where: { txHash: log.tx_hash, logIndex: log.log_index } }))?.verdict ?? null;
  const rowsOf = (log: LogInput) => prismaQuery.adminEvent.findMany({ where: { txHash: log.tx_hash, logIndex: log.log_index } });

  beforeEach(async () => {
    await prismaQuery.adminEvent.deleteMany();
    await prismaQuery.announcement.deleteMany();
    await prismaQuery.protocol.deleteMany();
    await prismaQuery.cursor.deleteMany({ where: { id: CURSOR } });
    Object.assign(evm, { head: 0n, logs: [], reads: [], topics: [], during: null });
  });

  test('an uncovered bond is not watched', async () => {
    await protocol(110, 'uncovered', VAULT_A, { covered: false });
    evm.head = 100n;
    await watchBaseLogs();
    expect(evm.reads).toHaveLength(0);
    expect(await cursor()).toBeNull();
  });

  test('the first scan starts maxAnnounceAge before the bond, so an Announce sent before its start still defends', async () => {
    await protocol(111, 'pre-start', VAULT_A, { effectiveFromBlock: 5_000n, maxAnnounceAgeBlocks: 1_000, covered: true });
    const up = upgradeLog(VAULT_A, 5_500, 'c');
    evm.logs = [announceLog(VAULT_A, up, 4_500, 'd'), up];
    evm.head = 5_600n;
    await watchBaseLogs();
    expect(evm.reads[0]).toBe(4_000n);
    expect(await verdictOf(up)).toBe('announced');
    expect(await cursor()).toBe(5_600n);
  });

  test('a log that keeps failing is retried, then skipped; the logs around it are still classified', async () => {
    await protocol(112, 'poison', VAULT_A, { covered: true });
    // Postgres refuses NUL in text, so this log's write always throws
    const poison = { ...upgradeLog(VAULT_A, 10, 'e'), tx_hash: `0x${'e'.repeat(63)}\u0000` as Hex };
    const good = upgradeLog(VAULT_A, 12, 'f');
    evm.logs = [poison, good];
    evm.head = 50n;
    await watchBaseLogs();
    expect(await verdictOf(good)).toBe('breach');
    expect(await cursor()).toBe(9n);
    await watchBaseLogs();
    expect(await cursor()).toBe(9n);
    await watchBaseLogs();
    expect(await cursor()).toBe(50n);
  });

  test('a rewind made during a tick is not overwritten by that tick', async () => {
    await protocol(113, 'race', VAULT_A, { covered: true });
    await prismaQuery.cursor.create({ data: { id: CURSOR, value: 100n } });
    evm.head = 300n;
    evm.during = async () => {
      evm.during = null;
      await prismaQuery.cursor.update({ where: { id: CURSOR }, data: { value: 20n } });
    };
    await watchBaseLogs();
    expect(await cursor()).toBe(20n);
    evm.reads = [];
    await watchBaseLogs();
    expect(evm.reads[0]).toBe(21n);
    expect(await cursor()).toBe(300n);
  });

  test('a log is never classified for an uncovered bond on its vault', async () => {
    await protocol(114, 'old-uncovered', VAULT_A, { covered: false });
    const live = await protocol(115, 'new-covered', VAULT_A, { effectiveFromBlock: 5n, covered: true });
    const up = upgradeLog(VAULT_A, 20, '0');
    evm.logs = [up];
    evm.head = 30n;
    await watchBaseLogs();
    expect((await rowsOf(up)).map((r) => r.protocolId)).toEqual([live.id]);
  });

  test('two covered bonds on one vault each get their own AdminEvent for the same log', async () => {
    const one = await protocol(116, 'bond-one', VAULT_A, { covered: true });
    const two = await protocol(117, 'bond-two', VAULT_A, { effectiveFromBlock: 10n, covered: true });
    // a third bond started after the log: the contract refuses it "before coverage start"
    await protocol(118, 'bond-late', VAULT_A, { effectiveFromBlock: 25n, covered: true });
    const up = upgradeLog(VAULT_A, 20, '1');
    evm.logs = [up];
    evm.head = 30n;
    await watchBaseLogs();
    const rows = await rowsOf(up);
    expect(rows.map((r) => r.protocolId).sort()).toEqual([one.id, two.id].sort());
    expect(rows.every((r) => r.verdict === 'breach')).toBe(true);
  });

  test('a bond not watching RoleGranted gets no row for it, and the topic is not requested', async () => {
    const vault = VAULT_A.toLowerCase();
    const p = await protocol(119, 'upgrades-only', VAULT_A, { covered: true, watchedAddresses: [vault], watchedTopics: [TOPICS.Upgraded] });
    const role = roleLog(VAULT_A, 12, '2');
    const up = upgradeLog(VAULT_A, 14, '3');
    evm.logs = [role, up];
    evm.head = 30n;
    await watchBaseLogs();
    expect(await rowsOf(role)).toHaveLength(0);
    expect((await rowsOf(up)).map((r) => r.protocolId)).toEqual([p.id]);
    expect(evm.topics[0]).toContain(TOPICS.Upgraded);
    expect(evm.topics[0]).toContain(TOPICS.Announce);
    expect(evm.topics[0]).not.toContain(TOPICS.RoleGranted);
    // classify applies the same rule when called directly
    await classify(p, role);
    expect(await rowsOf(role)).toHaveLength(0);
  });

  test('a log from watched[1] is classified, and an Announce for watched[1] defends it', async () => {
    const p = await protocol(120, 'two-addresses', VAULT_A, { covered: true, watchedAddresses: [VAULT_A, VAULT_C], watchedTopics: [TOPICS.Upgraded] });
    const breach = upgradeLog(VAULT_C, 2_000, '4');
    const announced = { ...upgradeLog(VAULT_C, 2_100, '5'), log_index: 2 };
    evm.logs = [announceLog(VAULT_C, announced, 2_100 - NOTICE - 10, '6'), breach, announced];
    evm.head = 2_200n;
    await watchBaseLogs();
    expect((await rowsOf(breach)).map((r) => [r.protocolId, r.verdict])).toEqual([[p.id, 'breach']]);
    expect((await rowsOf(announced)).map((r) => [r.protocolId, r.verdict])).toEqual([[p.id, 'announced']]);
  });
});
