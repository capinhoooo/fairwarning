// POST /fw/protocols and /fw/protocols/:slug/root against Postgres with NEAR and the EVM head mocked.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';

const OWNER = 'owner.test.near';
const UPGRADED = '0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b';
const commitments = new Map<number, object>();
const uncovered = new Set<number>();
// max announce age 400: a bond starting at 500 needs blocks from 100 on
const commitment = (effectiveFrom: number, chain = 'Base') => ({
  owner: OWNER,
  bond: '1000000',
  status: 'Committed',
  params: {
    chain,
    watched: [`0x${'c1'.repeat(20)}`],
    watched_topics: [UPGRADED],
    announcer: `0x${'c2'.repeat(20)}`,
    notice_blocks: 300,
    max_announce_age_blocks: 400,
    effective_from_block: effectiveFrom,
    finality: 'Safe',
    defence_window: 300,
  },
});

mock.module('../src/lib/fw/near.ts', () => ({
  fwView: async () => null,
  getCommitment: async (id: number) => commitments.get(id) ?? null,
  nearProvider: {},
  isCovered: async (id: number) => !uncovered.has(id),
  reportDeposit: async () => 0n,
  getCase: async () => null,
  txOutcome: async () => null,
  nextCaseId: async () => 0,
  currentNearHeight: async () => 0n,
  report: async () => ({ txHash: '' }),
  defend: async () => ({ txHash: '' }),
  finalize: async () => ({ txHash: '' }),
  claimReward: async () => ({ txHash: '' }),
  claim: async () => ({ txHash: '' }),
}));
const evm = { head: 2_000n };
const realBase = await import('../src/lib/fw/base.ts');
mock.module('../src/lib/fw/base.ts', () => ({ ...realBase, finalityHead: async () => evm.head }));

const { prismaQuery } = await import('../src/lib/prisma.ts');
const { fwRoutes } = await import('../src/routes/fwRoutes.ts');
const { cursorId } = await import('../src/lib/fw/base.ts');
const { JWT_SECRET } = await import('../src/config/main-config.ts');

const BASE = cursorId('Base');
const ARBITRUM = cursorId('Arbitrum');
const IDS = [900, 901, 902, 903, 904, 905, 906, 907, 908, 909, 910, 911];
const app = Fastify();
app.register(fwRoutes, { prefix: '/fw' });

const wipe = async () => {
  const ours = { protocol: { commitmentId: { in: IDS } } };
  await prismaQuery.adminEvent.deleteMany({ where: ours });
  await prismaQuery.case.deleteMany({ where: ours });
  await prismaQuery.beneficiaryRoot.deleteMany({ where: ours });
  await prismaQuery.protocol.deleteMany({ where: { commitmentId: { in: IDS } } });
  await prismaQuery.cursor.deleteMany({ where: { id: { in: [BASE, ARBITRUM] } } });
};

let ownerToken = '';
let strangerToken = '';
beforeAll(async () => {
  const owner = await prismaQuery.user.upsert({ where: { walletAddress: OWNER }, create: { walletAddress: OWNER }, update: {} });
  const stranger = await prismaQuery.user.upsert({ where: { walletAddress: 'stranger.test.near' }, create: { walletAddress: 'stranger.test.near' }, update: {} });
  ownerToken = jwt.sign({ userId: owner.id }, JWT_SECRET);
  strangerToken = jwt.sign({ userId: stranger.id }, JWT_SECRET);
});
beforeEach(async () => {
  commitments.clear();
  uncovered.clear();
  evm.head = 2_000n;
  await wipe();
});
afterAll(async () => {
  await wipe();
  await prismaQuery.user.deleteMany({ where: { walletAddress: { in: [OWNER, 'stranger.test.near'] } } });
  await app.close();
});

const setCursor = (id: string, value: bigint) => prismaQuery.cursor.create({ data: { id, value } });
const cursor = async (id = BASE) => (await prismaQuery.cursor.findUnique({ where: { id } }))?.value ?? null;
const register = (commitmentId: number, token = ownerToken, slug = `reg-${commitmentId}`) =>
  app.inject({
    method: 'POST',
    url: '/fw/protocols',
    headers: { authorization: `Bearer ${token}` },
    payload: { commitmentId, slug, name: 'Registered' },
  });

describe('registering a commitment rewinds the chain cursor', () => {
  test('a cursor past the first needed block goes back to start - maxAnnounceAge - 1', async () => {
    commitments.set(900, commitment(500));
    await setCursor(BASE, 1_000n);
    expect((await register(900)).statusCode).toBe(200);
    expect(await cursor()).toBe(99n);
  });

  test('a cursor exactly on the first needed block goes back one', async () => {
    commitments.set(901, commitment(500));
    await setCursor(BASE, 100n);
    expect((await register(901)).statusCode).toBe(200);
    expect(await cursor()).toBe(99n);
  });

  test('a cursor that has not reached the first needed block is left alone', async () => {
    commitments.set(902, commitment(500));
    await setCursor(BASE, 50n);
    expect((await register(902)).statusCode).toBe(200);
    expect(await cursor()).toBe(50n);
  });

  test('a chain never watched gets no cursor; the watcher computes its own start', async () => {
    commitments.set(903, commitment(500));
    expect((await register(903)).statusCode).toBe(200);
    expect(await cursor()).toBeNull();
  });

  test("only the commitment's own chain cursor moves", async () => {
    commitments.set(904, commitment(500));
    await setCursor(BASE, 1_000n);
    await setCursor(ARBITRUM, 1_000n);
    expect((await register(904)).statusCode).toBe(200);
    expect(await cursor(BASE)).toBe(99n);
    expect(await cursor(ARBITRUM)).toBe(1_000n);
  });

  test('a non-owner is refused and the cursor does not move', async () => {
    commitments.set(905, commitment(500));
    await setCursor(BASE, 1_000n);
    const res = await register(905, strangerToken);
    expect(res.statusCode).toBe(403);
    expect(await cursor()).toBe(1_000n);
    expect(await prismaQuery.protocol.findUnique({ where: { commitmentId: 905 } })).toBeNull();
  });

  test('a chain this indexer does not serve is refused before any rewind', async () => {
    commitments.set(906, commitment(500, 'Arbitrum'));
    await setCursor(ARBITRUM, 1_000n);
    const res = await register(906);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('CHAIN_NOT_SERVED');
    expect(await cursor(ARBITRUM)).toBe(1_000n);
  });

  test('the rewind is clamped at block 0', async () => {
    commitments.set(907, commitment(200));
    await setCursor(BASE, 1_000n);
    expect((await register(907)).statusCode).toBe(200);
    expect(await cursor()).toBe(-1n);
  });

  test('the rewind never goes more than MAX_BACKFILL_BLOCKS behind the safe head', async () => {
    commitments.set(908, commitment(500));
    evm.head = 2_000_000n;
    await setCursor(BASE, 1_999_000n);
    expect((await register(908)).statusCode).toBe(200);
    expect(await cursor()).toBe(999_999n);
  });

  test('an uncovered commitment is indexed without a rewind and stays unwatched', async () => {
    commitments.set(909, commitment(500));
    uncovered.add(909);
    await setCursor(BASE, 1_000n);
    const res = await register(909);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.covered).toBe(false);
    expect(await cursor()).toBe(1_000n);
  });

  test('a covered commitment is stored covered so the watcher picks it up', async () => {
    commitments.set(910, commitment(500));
    expect((await register(910)).json().data.covered).toBe(true);
  });

  test('a taken slug and a second registration answer 409, not 500', async () => {
    commitments.set(910, commitment(500));
    commitments.set(911, commitment(500));
    expect((await register(910)).statusCode).toBe(200);
    const slug = await register(911, ownerToken, 'reg-910');
    expect(slug.statusCode).toBe(409);
    expect(slug.json().error.code).toBe('SLUG_TAKEN');
    const twice = await register(910, ownerToken, 'reg-910-again');
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error.code).toBe('ALREADY_REGISTERED');
  });
});

describe('what a commitment watches', () => {
  test('registration stores every watched address and topic, normalized; vaultAddress is watched[0]', async () => {
    const c = commitment(500);
    // the contract parses hex with or without 0x, in any case
    c.params.watched = [`0x${'C1'.repeat(20)}`, 'd1'.repeat(20), `0x${'c1'.repeat(20)}`];
    c.params.watched_topics = [UPGRADED.slice(2).toUpperCase(), '0x1234'];
    commitments.set(900, c);
    const res = await register(900);
    expect(res.statusCode).toBe(200);
    const p = res.json().data;
    expect(p.vaultAddress).toBe(`0x${'c1'.repeat(20)}`);
    expect(p.watchedAddresses).toEqual([`0x${'c1'.repeat(20)}`, `0x${'d1'.repeat(20)}`]);
    expect(p.watchedTopics).toEqual([UPGRADED, `0x${'1234'.padStart(64, '0')}`]);
    expect(p.announcerAddress).toBe(`0x${'c2'.repeat(20)}`);
  });

  test('params that are not hex are refused with 422 and nothing is stored', async () => {
    const c = commitment(500);
    c.params.watched = ['not-an-address'];
    commitments.set(901, c);
    const res = await register(901);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('BAD_COMMITMENT_PARAMS');
    expect(await prismaQuery.protocol.findUnique({ where: { commitmentId: 901 } })).toBeNull();
  });
});

describe('recent admin events', () => {
  test('a log policed by two bonds is one chip', async () => {
    commitments.set(900, commitment(500));
    commitments.set(901, commitment(500));
    const one = (await register(900)).json().data;
    const two = (await register(901)).json().data;
    // far above any other test's block, so it is the newest chip
    const row = { topic0: UPGRADED, txHash: `0x${'ab'.repeat(32)}`, logIndex: 3, blockNumber: 10_000_000_000n, fingerprint: '0x00', log: {}, verdict: 'breach' };
    await prismaQuery.adminEvent.create({ data: { ...row, protocolId: two.id, createdAt: new Date('2026-11-12T00:00:02Z') } });
    await prismaQuery.adminEvent.create({ data: { ...row, protocolId: one.id, createdAt: new Date('2026-11-12T00:00:01Z') } });
    const res = await app.inject({ method: 'GET', url: '/fw/admin-events' });
    expect(res.statusCode).toBe(200);
    const chips = (res.json().data as { txHash: string; protocol: { slug: string } }[]).filter((c) => c.txHash === row.txHash);
    expect(chips).toHaveLength(1);
    expect(chips[0].protocol.slug).toBe('reg-900');
  });
});

describe('posting a depositor root', () => {
  const post = (slug: string, body: object = { snapshotBlock: 900, balances: [{ address: `0x${'d1'.repeat(20)}`, amount: '60' }] }) =>
    app.inject({ method: 'POST', url: `/fw/protocols/${slug}/root`, headers: { authorization: `Bearer ${ownerToken}` }, payload: body });

  test('is allowed while the bond is live with no open case, and the same root twice is fine', async () => {
    commitments.set(900, commitment(500));
    await register(900);
    expect((await post('reg-900')).statusCode).toBe(200);
    expect((await post('reg-900')).statusCode).toBe(200);
  });

  test('is refused while a case is open or once the bond is spent', async () => {
    commitments.set(901, commitment(500));
    const p = (await register(901)).json().data;
    await prismaQuery.case.create({ data: { caseId: 9_001, protocolId: p.id, txHash: '0x01', logIndex: 0, reporter: 'r.test.near', status: 'DefenceOpen' } });
    const open = await post('reg-901');
    expect(open.statusCode).toBe(409);
    expect(open.json().error.code).toBe('ROOT_LOCKED');
    await prismaQuery.case.update({ where: { caseId: 9_001 }, data: { status: 'Breached' } });
    await prismaQuery.protocol.update({ where: { id: p.id }, data: { status: 'Breached' } });
    expect((await post('reg-901')).json().error.code).toBe('ROOT_LOCKED');
  });

  test('bad input is a 400, never a 500', async () => {
    commitments.set(902, commitment(500));
    await register(902);
    expect((await post('reg-902', { balances: [null] })).statusCode).toBe(400);
    expect((await post('reg-902', { balances: [{ address: `0x${'d1'.repeat(20)}`, amount: '0' }] })).statusCode).toBe(400);
    expect((await post('reg-902', { snapshotBlock: 1.5, balances: [{ address: `0x${'d1'.repeat(20)}`, amount: '1' }] })).statusCode).toBe(400);
  });
});
