// Route + DB integration: POST /fw/claims/quote and /fw/claims against Postgres, NEAR views mocked.
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import Fastify from 'fastify';
import { privateKeyToAccount } from 'viem/accounts';

const FW = 'fw.test.near';
// on-chain cases by id, and how the next relayed claim tx behaves
const chainCases = new Map<number, object>();
const near = {
  claim: async (_c: unknown, onSigned: (h: string) => Promise<void>): Promise<{ txHash: string; events: object[] }> => {
    await onSigned('TxSent');
    throw new Error('timeout');
  },
  outcome: null as null | { failed: boolean; events: { event: string; data: object }[] },
};
// same format as fw `claim_message`
mock.module('../src/lib/fw/near.ts', () => ({
  fwView: async (method: string, args: { case_id: number; pay_to: string; log_index: number; commitment_id: number }) =>
    method === 'claim_message_for'
      ? `Fair Warning claim\ncontract: ${FW}\ncase: ${args.case_id}\npay_to: ${args.pay_to}`
      : method === 'case_for_log'
        ? (args.commitment_id === 2 && args.log_index === 7 ? 0 : null)
        : null,
  getCommitment: async () => null,
  nearProvider: {},
  // mock.module is process-wide in bun test; keep every export other test files import
  isCovered: async () => false,
  reportDeposit: async () => 0n,
  getCase: async (id: number) => chainCases.get(id) ?? null,
  txOutcome: async () => near.outcome,
  nextCaseId: async () => 0,
  currentNearHeight: async () => 0n,
  report: async () => ({ txHash: '' }),
  defend: async () => ({ txHash: '' }),
  finalize: async () => ({ txHash: '' }),
  claimReward: async () => ({ txHash: '' }),
  claim: (c: unknown, onSigned: (h: string) => Promise<void>) => near.claim(c, onSigned),
}));

const { prismaQuery } = await import('../src/lib/prisma.ts');
const { fwRoutes } = await import('../src/routes/fwRoutes.ts');
const { buildRoot } = await import('../src/lib/fw/merkle.ts');
const { runPayouts } = await import('../src/workers/payoutRunner.ts');

const alice = privateKeyToAccount('0x0101010101010101010101010101010101010101010101010101010101010101');
const bob = privateKeyToAccount('0x0202020202020202020202020202020202020202020202020202020202020202');
const app = Fastify();
app.register(fwRoutes, { prefix: '/fw' });
let protocolId = '';
let frozenRoot = '';
const onChainCase = (status: string, pool: string, root: string | null, total = '100') => ({
  commitment_id: 0, status, pool, reward: '0', reward_paid: false, root: root ? { root, total, leaf_count: 2, snapshot_block: 900 } : null,
});

beforeAll(async () => {
  await prismaQuery.payout.deleteMany();
  await prismaQuery.case.deleteMany();
  await prismaQuery.beneficiaryRoot.deleteMany();
  await prismaQuery.protocol.deleteMany();
  const p = await prismaQuery.protocol.create({
    data: {
      commitmentId: 0, slug: 'demo-vault', name: 'Demo Vault', vaultAddress: '0x1111111111111111111111111111111111111111',
      announcerAddress: '0x2222222222222222222222222222222222222222', ownerNearAccount: 'protocol.test.near', noticeBlocks: 30,
      maxAnnounceAgeBlocks: 500, effectiveFromBlock: 100n, finality: 'Safe', defenceWindow: 300, bond: '0', status: 'Breached',
    },
  });
  protocolId = p.id;
  const r = buildRoot([{ address: alice.address, amount: 60n }, { address: bob.address, amount: 40n }]);
  frozenRoot = r.root;
  chainCases.set(0, onChainCase('Breached', '450000000', r.root, '100'));
  await prismaQuery.beneficiaryRoot.create({
    data: { protocolId: p.id, root: r.root, total: '100', leafCount: 2, snapshotBlock: 900n, tree: r.dump as object },
  });
  await prismaQuery.case.create({
    data: { caseId: 0, protocolId: p.id, txHash: '0x01', logIndex: 7, reporter: 'reporter.test.near', status: 'Breached', reward: '50000000', pool: '450000000' },
  });
});
afterAll(() => app.close());

describe('claim flow', () => {
  test('quote returns share, proof and the exact message the contract checks', async () => {
    const res = await app.inject({ method: 'POST', url: '/fw/claims/quote', payload: { caseId: 0, baseAddress: alice.address, route: 'near', recipient: 'alice.test.near' } });
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.data.share).toBe('270000000');
    expect(body.data.proof.length).toBe(1);
    expect(body.data.message).toBe(`Fair Warning claim\ncontract: ${FW}\ncase: 0\npay_to: alice.test.near`);
  });

  test('a valid EIP-191 signature queues a payout; a signature for another pay_to is refused', async () => {
    const msg = `Fair Warning claim\ncontract: ${FW}\ncase: 0\npay_to: alice.test.near`;
    const signature = await alice.signMessage({ message: msg });
    const bad = await app.inject({ method: 'POST', url: '/fw/claims', payload: { caseId: 0, baseAddress: alice.address, payTo: 'evil.test.near', route: 'near', signature } });
    expect(bad.statusCode).toBe(401);
    const good = await app.inject({ method: 'POST', url: '/fw/claims', payload: { caseId: 0, baseAddress: alice.address, payTo: 'alice.test.near', route: 'near', signature } });
    expect(good.statusCode).toBe(200);
    const payout = await prismaQuery.payout.findUnique({ where: { id: good.json().data.payoutId } });
    expect(payout?.status).toBe('queued');
    expect(payout?.amount).toBe('270000000');
    // fw.claim hashes the leaf amount, not the share
    expect(payout?.leafAmount).toBe('60');
  });

  test('buildRoot merges duplicate addresses into one leaf', () => {
    const r = buildRoot([
      { address: alice.address, amount: 10n },
      { address: alice.address.toLowerCase(), amount: 5n },
      { address: bob.address, amount: 0n },
    ]);
    expect(r.leafCount).toBe(1);
    expect(r.total).toBe(15n);
  });

  test('an address outside the root cannot claim', async () => {
    const stranger = privateKeyToAccount('0x0303030303030303030303030303030303030303030303030303030303030303');
    const res = await app.inject({ method: 'POST', url: '/fw/claims/quote', payload: { caseId: 0, baseAddress: stranger.address, route: 'near', recipient: 'x.test.near' } });
    expect(res.statusCode).toBe(403);
  });
});

describe('read endpoints for the web app', () => {
  test('stats count only live commitments as bonded and only settled payouts as paid', async () => {
    const res = await app.inject({ method: 'GET', url: '/fw/stats' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ protocols: 1, covered: 0, bonded: '0', openCases: 0, paidOut: '0' });
  });

  test('recent cases carry their vault name', async () => {
    const res = await app.inject({ method: 'GET', url: '/fw/cases' });
    expect(res.json().data[0]).toMatchObject({ caseId: 0, status: 'Breached', protocol: { slug: 'demo-vault', name: 'Demo Vault' } });
  });

  test('a case still loads from the index when the chain view returns nothing', async () => {
    const res = await app.inject({ method: 'GET', url: '/fw/cases/0' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ caseId: 0, chain: null });
  });

  test('chains lists only what this indexer has an RPC for', async () => {
    const res = await app.inject({ method: 'GET', url: '/fw/chains' });
    const data = res.json().data;
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ chain: 'Base', chainId: 8453, name: 'Base', explorer: 'https://basescan.org' });
  });

  test('payout preview rejects bad input before calling 1Click', async () => {
    const preview = (body: object) => app.inject({ method: 'POST', url: '/fw/claims/preview', payload: body });
    const base = { amount: '1000000', route: 'base', recipient: '0x1111111111111111111111111111111111111111' };
    expect((await preview({ ...base, route: 'eth' })).json().error.code).toBe('INVALID_ROUTE');
    expect((await preview({ ...base, amount: '0' })).json().error.code).toBe('INVALID_AMOUNT');
    expect((await preview({ ...base, amount: '1.5' })).json().error.code).toBe('INVALID_AMOUNT');
    expect((await preview({ ...base, recipient: 'alice.near' })).json().error.code).toBe('INVALID_RECIPIENT');
    expect((await preview({ ...base, route: 'sol', recipient: '0x11' })).json().error.code).toBe('INVALID_RECIPIENT');
  });

  test('a report for a chain this indexer does not watch is refused', async () => {
    const res = await app.inject({ method: 'POST', url: '/fw/report/prepare', payload: { txHash: `0x${'ab'.repeat(32)}`, chain: 'Arbitrum' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('CHAIN_NOT_SERVED');
  });

  test('case lookup by log is per commitment, validates input and returns the on-chain case id', async () => {
    const tx = `0x${'ab'.repeat(32)}`;
    expect((await app.inject({ method: 'GET', url: '/fw/cases/by-log/2/0x01/7' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/fw/cases/by-log/x/${tx}/7` })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/fw/cases/by-log/2/${tx}/7` })).json().data).toEqual({ caseId: 0 });
    // the same log on another bond is a different case
    expect((await app.inject({ method: 'GET', url: `/fw/cases/by-log/1/${tx}/7` })).json().data).toEqual({ caseId: null });
    expect((await app.inject({ method: 'GET', url: `/fw/cases/by-log/2/${tx}/8` })).json().data).toEqual({ caseId: null });
  });
});

describe('claims against the root frozen in the case', () => {
  const message = (caseId: number, payTo: string) => `Fair Warning claim\ncontract: ${FW}\ncase: ${caseId}\npay_to: ${payTo}`;
  const quote = (caseId: number) =>
    app.inject({ method: 'POST', url: '/fw/claims/quote', payload: { caseId, baseAddress: alice.address, route: 'near', recipient: 'alice.test.near' } });
  const submit = async (caseId: number, payTo = 'alice.test.near') =>
    app.inject({
      method: 'POST',
      url: '/fw/claims',
      payload: { caseId, baseAddress: alice.address, payTo, route: 'near', signature: await alice.signMessage({ message: message(caseId, payTo) }) },
    });
  const caseRow = (caseId: number) =>
    prismaQuery.case.create({ data: { caseId, protocolId, txHash: `0x0${caseId}`, logIndex: caseId, reporter: 'r.test.near', status: 'Breached', reward: '0', pool: '450000000' } });

  test('a newer root posted after the breach does not change what a depositor is owed', async () => {
    const newer = buildRoot([{ address: alice.address, amount: 1n }, { address: bob.address, amount: 99n }]);
    await prismaQuery.beneficiaryRoot.create({ data: { protocolId, root: newer.root, total: '100', leafCount: 2, snapshotBlock: 950n, tree: newer.dump as object } });
    const res = await quote(0);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.share).toBe('270000000');
  });

  test('a case whose frozen root was never indexed is refused with ROOT_NOT_INDEXED', async () => {
    await caseRow(1);
    chainCases.set(1, onChainCase('Breached', '450000000', `0x${'ee'.repeat(32)}`));
    const res = await quote(1);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ROOT_NOT_INDEXED');
  });

  test('the share uses the total committed on chain, and roots match without regard to case or 0x', async () => {
    await caseRow(4);
    chainCases.set(4, onChainCase('Breached', '450000000', frozenRoot.slice(2).toUpperCase(), '200'));
    expect((await quote(4)).json().data.share).toBe('135000000');
  });

  test('only a Breached case with a positive pool takes claims', async () => {
    await caseRow(2);
    await caseRow(3);
    chainCases.set(2, onChainCase('DefenceOpen', '450000000', frozenRoot));
    chainCases.set(3, onChainCase('Breached', '0', frozenRoot));
    for (const id of [2, 3]) {
      const res = await submit(id);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('NOT_CLAIMABLE');
    }
  });

  test('a failed claim can be queued again with a new destination; a live or bridged one cannot', async () => {
    const first = await prismaQuery.payout.findFirstOrThrow({ where: { caseId: 0, baseAddress: alice.address.toLowerCase() } });
    expect((await submit(0, 'alice2.test.near')).json().error.code).toBe('CLAIM_EXISTS');
    await prismaQuery.payout.update({ where: { id: first.id }, data: { status: 'failed', error: 'boom' } });
    const again = await submit(0, 'alice2.test.near');
    expect(again.statusCode).toBe(200);
    expect(again.json().data.payoutId).toBe(first.id);
    expect(await prismaQuery.payout.findUnique({ where: { id: first.id } })).toMatchObject({ status: 'queued', payTo: 'alice2.test.near', error: null });
    await prismaQuery.payout.update({ where: { id: first.id }, data: { status: 'failed', oneClickStatus: 'REFUNDED' } });
    expect((await submit(0)).json().error.code).toBe('CLAIM_EXISTS');
    await prismaQuery.payout.update({ where: { id: first.id }, data: { status: 'queued', oneClickStatus: null } });
  });

  test('a claim whose send timed out is marked paid when its tx landed, and kept open while unknown', async () => {
    const alicePayout = await prismaQuery.payout.findFirstOrThrow({ where: { caseId: 0, baseAddress: alice.address.toLowerCase() } });
    near.outcome = { failed: false, events: [{ event: 'paid', data: {} }] };
    await runPayouts();
    expect(await prismaQuery.payout.findUnique({ where: { id: alicePayout.id } })).toMatchObject({ status: 'paid', nearTxHash: 'TxSent' });

    const bobPayout = await prismaQuery.payout.create({
      data: { caseId: 0, kind: 'depositor', baseAddress: bob.address.toLowerCase(), amount: '1', leafAmount: '40', payTo: 'bob.test.near', route: 'near', signature: '0x', proof: [] },
    });
    near.outcome = null;
    await runPayouts();
    expect(await prismaQuery.payout.findUnique({ where: { id: bobPayout.id } })).toMatchObject({ status: 'submitted', nearTxHash: 'TxSent' });
  });
});
