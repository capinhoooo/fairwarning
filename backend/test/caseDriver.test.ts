// caseDriver against Postgres with NEAR and Base mocked: retries and coverage sync.
import { afterAll, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import type { ChainCase } from '../src/lib/fw/near.ts';
import type { LogInput } from '../src/lib/fw/mpcPayload.ts';

const UPGRADED = '0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b';
const ROLE_GRANTED = '0x2f8788117e7eff1d82e926ec794901d17c78024a50270940304540a733656f0d';
// the commitment watches Upgraded only, stored without 0x and in upper case to check normalisation
const chain = { next: 0, cases: new Map<number, ChainCase>(), covered: true, height: 1_000n, failReports: new Set<string>(), watched: [UPGRADED.slice(2).toUpperCase()] };
const calls = { report: 0, defend: 0, reward: 0, reported: [] as string[], reportedFor: [] as number[] };

mock.module('../src/lib/fw/near.ts', () => ({
  fwView: async () => null,
  nearProvider: {},
  getCommitment: async () => ({ bond: '500000000', status: 'Committed', params: { report_bond: '500000000000000000000000', watched_topics: chain.watched } }),
  isCovered: async () => chain.covered,
  reportDeposit: async () => 510_000_000_000_000_000_000_000n,
  getCase: async (id: number) => chain.cases.get(id) ?? null,
  txOutcome: async () => null,
  nextCaseId: async () => chain.next,
  currentNearHeight: async () => chain.height,
  report: async (id: number, log: { tx_hash: string }) => {
    if (chain.failReports.has(log.tx_hash)) throw new Error('RPC timeout');
    calls.report++;
    calls.reported.push(log.tx_hash);
    calls.reportedFor.push(id);
    return { txHash: `report-${calls.report}` };
  },
  defend: async () => {
    calls.defend++;
    return { txHash: `defend-${calls.defend}` };
  },
  finalize: async () => ({ txHash: 'finalize' }),
  claimReward: async () => {
    calls.reward++;
    return { txHash: 'reward' };
  },
  claim: async () => ({ txHash: 'claim' })
}));
// mock.module is process-wide: keep the real exports other test files use, override only the RPC read
const realBase = await import('../src/lib/fw/base.ts');
mock.module('../src/lib/fw/base.ts', () => ({ ...realBase, finalityHead: async () => 10_000_000n }));

const { prismaQuery } = await import('../src/lib/prisma.ts');
const { driveCases } = await import('../src/workers/caseDriver.ts');
const { classify } = await import('../src/workers/baseLogWatcher.ts');
const { cursorId } = await import('../src/lib/fw/base.ts');
const CURSOR = cursorId('Base');

const LOG = { tx_hash: '0x' + '01'.repeat(32), log_index: 7, block_number: 5_000 };
const chainCase = (status: ChainCase['status'], pending = 0): ChainCase => ({
  commitment_id: 0, reporter: 'r.test.near', report_bond: '1', tx_hash: '01'.repeat(32), log_index: 7,
  breach_block: 5_000, action_hash: 'ab'.repeat(32), status, deadline: 2_000, pending_defences: pending,
  reward: '0', pool: '0', paid: '0', claims: 0, reward_paid: false, root: null
});
const breach = (tx: string, block: number, topic0 = UPGRADED) =>
  prismaQuery.adminEvent.create({
    data: { protocolId, topic0, txHash: tx, logIndex: 7, blockNumber: BigInt(block), fingerprint: '0x00', log: { ...LOG, tx_hash: tx, block_number: block }, verdict: 'breach' }
  });

const reset = async () => {
  await prismaQuery.payout.deleteMany();
  await prismaQuery.case.deleteMany();
  await prismaQuery.adminEvent.deleteMany();
  await prismaQuery.announcement.deleteMany();
  await prismaQuery.beneficiaryRoot.deleteMany();
  await prismaQuery.protocol.deleteMany();
  await prismaQuery.cursor.deleteMany({ where: { id: CURSOR } });
};

let protocolId = '';
beforeEach(async () => {
  await reset();
  chain.next = 0;
  chain.cases.clear();
  chain.covered = true;
  chain.failReports.clear();
  chain.watched = [UPGRADED.slice(2).toUpperCase()];
  Object.assign(calls, { report: 0, defend: 0, reward: 0, reported: [], reportedFor: [] });
  setSystemTime();
  const p = await prismaQuery.protocol.create({
    data: {
      commitmentId: 0, slug: 'demo', name: 'Demo', vaultAddress: '0x1111111111111111111111111111111111111111',
      announcerAddress: '0x2222222222222222222222222222222222222222', ownerNearAccount: 'p.test.near', noticeBlocks: 30,
      maxAnnounceAgeBlocks: 500, effectiveFromBlock: 100n, finality: 'Safe', defenceWindow: 300
    }
  });
  protocolId = p.id;
});
afterAll(async () => {
  setSystemTime();
  await reset();
});

describe('caseDriver', () => {
  test('syncs coverage from fw.is_covered', async () => {
    chain.covered = true;
    await driveCases();
    expect((await prismaQuery.protocol.findUnique({ where: { id: protocolId } }))?.covered).toBe(true);
    chain.covered = false;
    await driveCases();
    expect((await prismaQuery.protocol.findUnique({ where: { id: protocolId } }))?.covered).toBe(false);
  });

  test('re-reports a breach whose case the MPC rejected, at most 3 times', async () => {
    await prismaQuery.adminEvent.create({
      data: { protocolId, topic0: UPGRADED, txHash: LOG.tx_hash, logIndex: 7, blockNumber: 5_000n, fingerprint: '0x00', log: LOG, verdict: 'breach' }
    });
    await driveCases();
    expect(calls.report).toBe(1);
    // every report times out at the MPC and the case is rejected
    for (let id = 0; id < 4; id++) {
      chain.cases.set(id, chainCase('Rejected'));
      chain.next = id + 1;
      await driveCases();
    }
    expect(calls.report).toBe(3);
  });

  test('a live case stops further reports', async () => {
    await prismaQuery.adminEvent.create({
      data: { protocolId, topic0: UPGRADED, txHash: LOG.tx_hash, logIndex: 7, blockNumber: 5_000n, fingerprint: '0x00', log: LOG, verdict: 'breach' }
    });
    await driveCases();
    chain.cases.set(0, chainCase('DefenceOpen'));
    chain.next = 1;
    await driveCases();
    await driveCases();
    expect(calls.report).toBe(1);
  });

  test('retries a rejected defence after 60 s, never while one is in flight', async () => {
    await prismaQuery.announcement.create({
      data: { protocolId, actionHash: '0x' + 'ab'.repeat(32), expectedLog: '0x', txHash: '0x' + '02'.repeat(32), logIndex: 0, blockNumber: 4_900n, log: { block_number: 4_900 } }
    });
    chain.cases.set(0, chainCase('DefenceOpen'));
    chain.next = 1;
    const t0 = new Date('2026-11-12T00:00:00Z');
    setSystemTime(t0);
    await driveCases();
    expect(calls.defend).toBe(1);

    await driveCases(); // too soon
    expect(calls.defend).toBe(1);

    chain.cases.set(0, chainCase('DefenceOpen', 1)); // MPC still answering
    setSystemTime(new Date(t0.getTime() + 61_000));
    await driveCases();
    expect(calls.defend).toBe(1);

    chain.cases.set(0, chainCase('DefenceOpen', 0)); // MPC rejected it
    await driveCases();
    expect(calls.defend).toBe(2);

    chain.height = 3_000n; // past the deadline: the contract would refuse
    setSystemTime(new Date(t0.getTime() + 200_000));
    await driveCases();
    expect(calls.defend).toBe(2);
    chain.height = 1_000n;
  });
});

describe('caseDriver against attacker-made events', () => {
  const hash = (n: number) => '0x' + n.toString(16).padStart(64, '0');

  test('never reports an admin event the commitment does not watch', async () => {
    await breach(hash(1), 5_000, ROLE_GRANTED);
    await driveCases();
    await driveCases();
    expect(calls.report).toBe(0);
  });

  test('never reports for an uncovered bond', async () => {
    chain.covered = false;
    await breach(hash(2), 5_000);
    await driveCases();
    expect(calls.report).toBe(0);
  });

  test('one failing report does not stop the other reports or the defences in that tick', async () => {
    chain.failReports.add(hash(3));
    await breach(hash(3), 4_000);
    await breach(hash(4), 5_000);
    await prismaQuery.announcement.create({
      data: { protocolId, actionHash: '0x' + 'ab'.repeat(32), expectedLog: '0x', txHash: '0x' + '03'.repeat(32), logIndex: 0, blockNumber: 4_900n, log: { block_number: 4_900 } }
    });
    chain.cases.set(5, chainCase('DefenceOpen'));
    chain.next = 6;
    await driveCases();
    expect(calls.reported).toEqual([hash(4)]);
    expect(calls.defend).toBe(1);
  });

  test('a flood of unreportable events cannot crowd out a real breach', async () => {
    for (let i = 0; i < 21; i++) await breach(hash(100 + i), 1_000 + i, ROLE_GRANTED);
    await breach(hash(200), 3_000);
    await driveCases();
    expect(calls.report).toBe(0);
    await driveCases();
    expect(calls.reported).toEqual([hash(200)]);
  });

  test('a bond that becomes covered rewinds the watcher, at most MAX_BACKFILL_BLOCKS behind the safe head', async () => {
    await prismaQuery.cursor.create({ data: { id: CURSOR, value: 9_999_000n } });
    chain.covered = false;
    await driveCases();
    expect((await prismaQuery.cursor.findUnique({ where: { id: CURSOR } }))?.value).toBe(9_999_000n);
    chain.covered = true;
    await driveCases();
    // head 10,000,000 minus the default 1,000,000 cap, minus one: the next read starts at the cap
    expect((await prismaQuery.cursor.findUnique({ where: { id: CURSOR } }))?.value).toBe(8_999_999n);
  });

  test('claims a reward at most 3 times and never claims a zero one', async () => {
    chain.cases.set(7, { ...chainCase('Breached'), reward: '0' });
    chain.cases.set(8, { ...chainCase('Breached'), reward: '5' });
    chain.next = 9;
    for (let i = 0; i < 5; i++) await driveCases();
    expect(calls.reward).toBe(3);
  });
});

describe('one log policed by two bonds', () => {
  // the beforeEach bond's vault; the watcher's classify writes the rows, as it does live
  const LOG_FULL = {
    ...LOG,
    transaction_index: 0,
    block_hash: '0x' + 'ee'.repeat(32),
    address: '0x1111111111111111111111111111111111111111',
    data: '0x',
    topics: [UPGRADED, '0x' + '33'.repeat(20).padStart(64, '0')]
  } as LogInput;
  const secondBond = () =>
    prismaQuery.protocol.create({
      data: {
        commitmentId: 1, slug: 'demo-2', name: 'Demo 2', vaultAddress: '0x1111111111111111111111111111111111111111',
        announcerAddress: '0x2222222222222222222222222222222222222222', ownerNearAccount: 'q.test.near', noticeBlocks: 30,
        maxAnnounceAgeBlocks: 500, effectiveFromBlock: 200n, finality: 'Safe', defenceWindow: 300
      }
    });
  const classifyForAll = async () => {
    for (const p of await prismaQuery.protocol.findMany()) await classify(p, LOG_FULL);
  };

  test('each bond gets its own AdminEvent and both are auto-reported, each under its own commitment', async () => {
    await secondBond();
    await classifyForAll();
    expect(await prismaQuery.adminEvent.count({ where: { txHash: LOG.tx_hash, logIndex: LOG.log_index } })).toBe(2);
    await driveCases();
    expect(calls.reportedFor.sort()).toEqual([0, 1]);
  });

  test("syncState links a case only to its own bond's row", async () => {
    const other = await secondBond();
    await classifyForAll();
    chain.cases.set(0, { ...chainCase('DefenceOpen'), commitment_id: 1 });
    chain.next = 1;
    await driveCases();
    const rows = await prismaQuery.adminEvent.findMany({ where: { txHash: LOG.tx_hash, logIndex: LOG.log_index } });
    expect(rows.find((r) => r.protocolId === other.id)?.caseId).toBe(0);
    expect(rows.find((r) => r.protocolId === protocolId)?.caseId).toBeNull();
  });
});
