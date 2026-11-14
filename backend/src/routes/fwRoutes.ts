import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { isAddress, verifyMessage, type Hex } from 'viem';
import { prismaQuery } from '../lib/prisma.ts';
import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { handleError, handleNotFoundError, handleForbiddenError, handleServerError } from '../utils/errorHandler.ts';
import { validateRequiredFields } from '../utils/validationUtils.ts';
import { jsonSafe } from '../utils/jsonUtils.ts';
import { baseClient, cursorId, evmClient, evmNetwork, fingerprint, isEvmChain, logsInTx, servedChains } from '../lib/fw/base.ts';
import { addressesOf, normAddress, watchedFromParams, watches, type WatchedParams } from '../lib/fw/watched.ts';
import { expectedPayloadHash, type LogInput, type MpcChain } from '../lib/fw/mpcPayload.ts';
import { currentNearHeight, fwView, getCase, getCommitment, isCovered } from '../lib/fw/near.ts';
import { backfillCursor } from '../lib/fw/cursor.ts';
import { buildRoot, proofFor } from '../lib/fw/merkle.ts';
import { announcedFor, coveringAnnouncement } from '../lib/fw/announcements.ts';
import { DESTINATIONS, previewPayout, quotePayout, type Destination } from '../lib/fw/oneClick.ts';
import { FW_CONTRACT_ID, MPC_CONTRACT_ID, NEAR_NETWORK } from '../config/main-config.ts';

const ok = (reply: FastifyReply, data: unknown) => reply.code(200).send({ success: true, error: null, data: jsonSafe(data) });
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const NEAR_ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const SOL_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const OPEN_CASE = ['Reported', 'DefenceOpen'];
const RECENT_LOGS = 6;
// bounded read for the chips; only logs policed by more than 8 bonds can leave fewer than RECENT_LOGS
const RECENT_ROWS_PER_LOG = 8;
const PAID_OUT = ['paid', 'bridged'];
// every page polls the chain heads; one cached read serves all of them
const HEADS_TTL_MS = 3_000;
type ChainHead = { head: number; safe: number };
let heads: { at: number; data: { base: number; baseSafe: number; near: number; chains: Record<string, ChainHead>; at: number } } | null = null;

const sameHex = (a: string, b: string): boolean => a.toLowerCase().replace(/^0x/, '') === b.toLowerCase().replace(/^0x/, '');
const isDestination = (r: string): r is Destination => Object.hasOwn(DESTINATIONS, r);
const isPrismaCode = (e: unknown, code: string): boolean => (e as { code?: unknown } | null)?.code === code;

type Refusal = { refused: { status: number; message: string; code: string } };

/** A depositor's share in a breached case, proven against the root the case froze at finalize. */
const resolveClaim = async (caseId: number, baseAddress: string): Promise<Refusal | { share: string; leaf: { amount: string; proof: string[] } }> => {
  const [row, onChain] = await Promise.all([prismaQuery.case.findUnique({ where: { caseId }, select: { protocolId: true } }), getCase(caseId)]);
  if (!row || !onChain || onChain.status !== 'Breached' || !onChain.root || BigInt(onChain.pool) <= 0n) {
    return { refused: { status: 409, message: 'Case is not paying out', code: 'NOT_CLAIMABLE' } };
  }
  const frozen = onChain.root;
  // the owner may have posted newer roots since; only the frozen one verifies on chain
  const roots = await prismaQuery.beneficiaryRoot.findMany({ where: { protocolId: row.protocolId }, select: { id: true, root: true } });
  const match = roots.find((r) => sameHex(r.root, frozen.root));
  if (!match) return { refused: { status: 409, message: "The case's depositor root is not indexed", code: 'ROOT_NOT_INDEXED' } };
  const root = await prismaQuery.beneficiaryRoot.findUniqueOrThrow({ where: { id: match.id }, select: { tree: true } });
  const leaf = proofFor(root.tree as never, baseAddress);
  if (!leaf) return { refused: { status: 403, message: 'Address is not in the committed depositor list', code: 'FORBIDDEN' } };
  // the contract divides by the total committed on chain
  return { share: ((BigInt(leaf.amount) * BigInt(onChain.pool)) / BigInt(frozen.total)).toString(), leaf };
};

// other chains with a bonded protocol; a failing RPC drops that chain instead of the whole response
const otherHeads = async (): Promise<Record<string, ChainHead>> => {
  const used = new Set((await prismaQuery.protocol.findMany({ select: { chain: true }, distinct: ['chain'] })).map((p) => p.chain));
  const wanted = servedChains().filter((c) => c !== 'Base' && used.has(c));
  const read = await Promise.allSettled(
    wanted.map(async (c) => {
      const [head, safe] = await Promise.all([evmClient(c).getBlockNumber(), evmClient(c).getBlock({ blockTag: 'safe' })]);
      return [c, { head: Number(head), safe: Number(safe.number) }] as const;
    })
  );
  return Object.fromEntries(read.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : [])));
};

// average seconds per block over the last 1,000 blocks, so notice durations are measured, not assumed
const BLOCK_TIME_TTL_MS = 10 * 60_000;
const BLOCK_TIME_WAIT_MS = 2_000;
const blockTimes = new Map<MpcChain, { at: number; s: number }>();
const measuredBlockTime = async (c: MpcChain): Promise<number | null> => {
  const hit = blockTimes.get(c);
  if (hit && Date.now() - hit.at < BLOCK_TIME_TTL_MS) return hit.s;
  try {
    // a slow RPC must not stall the bond form; it gets the last measurement instead
    const read = (async () => {
      const head = await evmClient(c).getBlock();
      const past = await evmClient(c).getBlock({ blockNumber: head.number - 1000n });
      return Number(head.timestamp - past.timestamp) / 1000;
    })();
    const s = await Promise.race([read, new Promise<never>((_, no) => setTimeout(() => no(new Error('timeout')), BLOCK_TIME_WAIT_MS))]);
    blockTimes.set(c, { at: Date.now(), s });
    return s;
  } catch {
    return hit?.s ?? null;
  }
};

export const fwRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  app.get('/heads', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      if (!heads || Date.now() - heads.at > HEADS_TTL_MS) {
        const [base, safe, near, chains] = await Promise.all([
          baseClient.getBlockNumber(),
          baseClient.getBlock({ blockTag: 'safe' }),
          currentNearHeight(),
          otherHeads(),
        ]);
        const at = Date.now();
        heads = { at, data: { base: Number(base), baseSafe: Number(safe.number), near: Number(near), chains, at } };
      }
      return ok(reply, heads.data);
    } catch (error) {
      return handleError(reply, 502, 'Could not read the chain heads', 'HEADS_UNAVAILABLE', error as Error);
    }
  });

  app.get('/stats', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const [protocols, openCases, payouts] = await Promise.all([
        prismaQuery.protocol.findMany({ select: { bond: true, covered: true, status: true } }),
        prismaQuery.case.count({ where: { status: { in: OPEN_CASE } } }),
        prismaQuery.payout.findMany({ where: { status: { in: PAID_OUT } }, select: { amount: true } }),
      ]);
      const live = protocols.filter((p) => p.status === 'Committed');
      return ok(reply, {
        protocols: protocols.length,
        covered: live.filter((p) => p.covered).length,
        bonded: live.reduce((s, p) => s + BigInt(p.bond), 0n).toString(),
        openCases,
        paidOut: payouts.reduce((s, p) => s + BigInt(p.amount), 0n).toString(),
      });
    } catch (error) {
      return handleServerError(reply, error as Error);
    }
  });

  app.get('/cases', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const cases = await prismaQuery.case.findMany({
        orderBy: { caseId: 'desc' },
        take: 30,
        include: { protocol: { select: { slug: true, name: true } } },
      });
      return ok(reply, cases);
    } catch (error) {
      return handleServerError(reply, error as Error);
    }
  });

  /** After a wallet signs fw.report, the case exists on chain before the MPC answers; this finds its id. */
  // the contract keys reported logs per commitment, so one log can open a case on each bond that polices it
  app.get('/cases/by-log/:commitmentId/:txHash/:logIndex', async (request: FastifyRequest<{ Params: { commitmentId: string; txHash: string; logIndex: string } }>, reply: FastifyReply) => {
    const { txHash } = request.params;
    const commitmentId = Number(request.params.commitmentId);
    const logIndex = Number(request.params.logIndex);
    if (!TX_HASH.test(txHash) || !Number.isInteger(logIndex) || logIndex < 0 || !Number.isInteger(commitmentId) || commitmentId < 0) {
      return handleError(reply, 400, 'Bad commitment id, tx hash or log index', 'INVALID_LOG_REF');
    }
    try {
      const caseId = await fwView<number | null>('case_for_log', { commitment_id: commitmentId, tx_hash: txHash, log_index: logIndex });
      return ok(reply, { caseId });
    } catch (error) {
      return handleServerError(reply, error as Error);
    }
  });

  app.get('/chains', async (_request: FastifyRequest, reply: FastifyReply) => {
    const rows = await Promise.all(
      servedChains().map(async (c) => ({
        chain: c,
        chainId: evmNetwork(c).id,
        name: evmNetwork(c).name,
        explorer: evmNetwork(c).blockExplorers?.default.url ?? null,
        blockTimeS: await measuredBlockTime(c),
      })),
    );
    return ok(reply, rows);
  });

  /** Recent policed admin logs, newest first: real transactions anyone can check on /report without a wallet. */
  app.get('/admin-events', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      // rows are per (bond, log); read a bounded window and keep one chip per log, the first row stored for it
      const rows = await prismaQuery.adminEvent.findMany({
        orderBy: [{ blockNumber: 'desc' }, { logIndex: 'desc' }, { createdAt: 'asc' }],
        take: RECENT_LOGS * RECENT_ROWS_PER_LOG,
        select: { txHash: true, logIndex: true, topic0: true, blockNumber: true, verdict: true, caseId: true, protocol: { select: { slug: true, name: true, chain: true } } },
      });
      const seen = new Set<string>();
      const chips = rows.filter((r) => {
        const key = `${r.txHash}:${r.logIndex}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return ok(reply, chips.slice(0, RECENT_LOGS));
    } catch (error) {
      return handleServerError(reply, error as Error);
    }
  });

  /** The newest indexed announcement and a bond it serves (live ones first): the landing page's notice clock. */
  app.get('/announcements/latest', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const ann = await prismaQuery.announcement.findFirst({
        orderBy: { blockNumber: 'desc' },
        select: { txHash: true, expectedLog: true, blockNumber: true, protocol: { select: { announcerAddress: true } } },
      });
      if (!ann) return ok(reply, null);
      // expectedLog starts with its target (checked when stored); legacy rows only have vaultAddress
      const target = ann.expectedLog.slice(0, 42).toLowerCase();
      const bonds = await prismaQuery.protocol.findMany({
        where: { announcerAddress: ann.protocol.announcerAddress, OR: [{ watchedAddresses: { has: target } }, { vaultAddress: target }] },
        select: { slug: true, name: true, chain: true, noticeBlocks: true, bond: true, status: true, effectiveFromBlock: true },
        orderBy: { effectiveFromBlock: 'desc' },
      });
      // only a bond already policing at the announced block served this notice
      const served = bonds.filter((b) => b.effectiveFromBlock <= ann.blockNumber);
      const pick = served.find((b) => b.status === 'Committed') ?? served[0];
      if (!pick) return ok(reply, null);
      const { effectiveFromBlock: _from, ...bond } = pick;
      return ok(reply, { txHash: ann.txHash, expectedLog: ann.expectedLog, blockNumber: ann.blockNumber, bond });
    } catch (error) {
      return handleServerError(reply, error as Error);
    }
  });

  app.get('/protocols', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const protocols = await prismaQuery.protocol.findMany({
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { announcements: true, cases: true } } },
      });
      return ok(reply, protocols);
    } catch (error) {
      return handleServerError(reply, error as Error);
    }
  });

  app.get('/protocols/:slug', async (request: FastifyRequest<{ Params: { slug: string } }>, reply: FastifyReply) => {
    try {
      const protocol = await prismaQuery.protocol.findUnique({
        where: { slug: request.params.slug },
        include: {
          adminEvents: { orderBy: { blockNumber: 'desc' }, take: 50 },
          cases: { orderBy: { caseId: 'desc' }, take: 20 },
        },
      });
      if (!protocol) return handleNotFoundError(reply, 'Protocol');
      // an announcement belongs to (Announcer, target), whichever bond's watcher stored it
      const announcements = await prismaQuery.announcement.findMany({
        where: { ...announcedFor(protocol), blockNumber: { gte: protocol.effectiveFromBlock - BigInt(protocol.maxAnnounceAgeBlocks) } },
        orderBy: { blockNumber: 'desc' },
        take: 50,
      });
      return ok(reply, { ...protocol, announcements });
    } catch (error) {
      return handleServerError(reply, error as Error);
    }
  });

  /** Report helper: everything a wallet needs to call fw.report (main path) or v1.signer (fallback A). */
  app.post('/report/prepare', async (request: FastifyRequest<{ Body: { txHash: string; chain?: string } }>, reply: FastifyReply) => {
    const valid = await validateRequiredFields(request.body as Record<string, unknown>, ['txHash'], reply);
    if (valid !== true) return;
    const { txHash, chain: asked } = request.body;
    if (!TX_HASH.test(txHash)) return handleError(reply, 400, 'txHash must be a 0x-prefixed 32-byte hash', 'INVALID_TX_HASH');
    if (asked !== undefined && (!isEvmChain(asked) || !servedChains().includes(asked))) {
      return handleError(reply, 400, `This indexer does not watch ${asked}`, 'CHAIN_NOT_SERVED');
    }
    try {
      // breached bonds stay listed so a judge can see the case a log already opened
      const all = await prismaQuery.protocol.findMany({ where: { status: { in: ['Committed', 'Breached'] } } });
      // a tx hash lives on one chain: try the asked chain, else every chain with a bonded protocol
      const candidates = asked ? [asked as MpcChain] : servedChains().filter((c) => all.some((p) => p.chain === c));
      let protocols: typeof all = [];
      let logs: LogInput[] = [];
      for (const c of candidates) {
        const own = all.filter((p) => p.chain === c);
        try {
          logs = await logsInTx(txHash as Hex, own.flatMap(addressesOf), c);
        } catch (error) {
          if ((error as Error).name === 'TransactionReceiptNotFoundError') continue;
          throw error;
        }
        protocols = own;
        if (logs.some((log) => own.some((p) => watches(p, log)))) break;
      }
      // a log is policed by every bond watching its address and topic0 whose start block it reaches, as check_breach does
      const pairs = logs.flatMap((log) =>
        protocols.filter((p) => watches(p, log) && BigInt(log.block_number) >= p.effectiveFromBlock).map((p) => ({ log, p })),
      );
      if (pairs.length === 0) return handleError(reply, 404, 'No policed admin event in this transaction', 'NO_ADMIN_LOG');
      const cursorRow = await prismaQuery.cursor.findUnique({ where: { id: cursorId(pairs[0].p.chain as MpcChain) } });
      const cursorValue = cursorRow?.value;
      const items = await Promise.all(
        pairs.map(async ({ log, p }) => {
          const [covering, opened] = await Promise.all([
            coveringAnnouncement(p, fingerprint(log), BigInt(log.block_number)),
            prismaQuery.case.findFirst({
              where: { protocolId: p.id, txHash: log.tx_hash, logIndex: log.log_index, status: { not: 'Rejected' } },
              orderBy: { caseId: 'desc' },
            }),
          ]);
          const [mpcRequest, deposit] = await Promise.all([
            fwView('mpc_request_for', { log, chain: p.chain, finality: p.finality }),
            fwView<string>('report_deposit', { commitment_id: p.commitmentId })
          ]);
          return {
            commitmentId: p.commitmentId,
            protocol: p.slug,
            protocolName: p.name,
            chain: p.chain,
            finality: p.finality,
            // false once the bond is spent: the contract refuses new reports
            active: p.status === 'Committed',
            log,
            fingerprint: fingerprint(log),
            // the watcher's rule, per bond; 'unknown' while the watcher has not read up to this block
            verdict: covering ? 'announced' : BigInt(log.block_number) <= (cursorValue ?? -1n) ? 'breach' : 'unknown',
            caseId: opened?.caseId ?? null,
            expectedPayloadHash: expectedPayloadHash(log, p.chain as MpcChain, p.finality as 'Safe' | 'Finalized'),
            fallback: { contractId: MPC_CONTRACT_ID, method: 'verify_foreign_transaction', args: { request: mpcRequest }, deposit: '1', gasTgas: 100 },
            // deposit = report bond (refunded unless the report is wrong) + 0.01 NEAR storage fee
            report: { contractId: FW_CONTRACT_ID, method: 'report', args: { commitment_id: p.commitmentId, log }, deposit, gasTgas: 150 },
          };
        }),
      );
      return ok(reply, items);
    } catch (error) {
      return handleError(reply, 502, 'Could not read the transaction', 'BASE_RPC_ERROR', error as Error, { txHash });
    }
  });

  app.get('/cases/:caseId', async (request: FastifyRequest<{ Params: { caseId: string } }>, reply: FastifyReply) => {
    const caseId = Number(request.params.caseId);
    if (!Number.isInteger(caseId) || caseId < 0) return handleError(reply, 400, 'Bad case id', 'INVALID_CASE_ID');
    try {
      const [row, chain] = await Promise.all([
        prismaQuery.case.findUnique({ where: { caseId }, include: { protocol: true, payouts: true } }),
        // a NEAR RPC hiccup must not hide the indexed case; the page shows the row and polls again
        fwView('get_case', { case_id: caseId }).catch((error: Error) => {
          console.log(JSON.stringify({ route: 'cases/:caseId', caseId, event: 'get_case_failed', error: error.message }));
          return null;
        }),
      ]);
      if (!row && !chain) return handleNotFoundError(reply, 'Case');
      return ok(reply, { ...row, chain });
    } catch (error) {
      return handleServerError(reply, error as Error);
    }
  });

  /** Step 1 of a depositor claim: compute the share, get a 1Click deposit address if needed, return the message to sign. */
  app.post(
    '/claims/quote',
    async (
      request: FastifyRequest<{ Body: { caseId: number; baseAddress: string; route: 'near' | Destination; recipient: string; confidential?: boolean } }>,
      reply: FastifyReply,
    ) => {
      const valid = await validateRequiredFields(request.body as Record<string, unknown>, ['caseId', 'baseAddress', 'route', 'recipient'], reply);
      if (valid !== true) return;
      const { caseId, baseAddress, route, recipient, confidential } = request.body;
      if (!Number.isSafeInteger(caseId) || caseId < 0) return handleError(reply, 400, 'Bad case id', 'INVALID_CASE_ID');
      if (!isAddress(baseAddress)) return handleError(reply, 400, 'baseAddress is not an EVM address', 'INVALID_ADDRESS');
      if (route !== 'near' && !isDestination(route)) return handleError(reply, 400, 'route must be near, base or sol', 'INVALID_ROUTE');
      if (route === 'near' && !NEAR_ACCOUNT.test(recipient)) return handleError(reply, 400, 'Invalid NEAR account', 'INVALID_RECIPIENT');
      if (route === 'base' && !isAddress(recipient)) return handleError(reply, 400, 'Invalid Base address', 'INVALID_RECIPIENT');
      if (route === 'sol' && !SOL_ADDRESS.test(recipient)) return handleError(reply, 400, 'Invalid Solana address', 'INVALID_RECIPIENT');
      // 1Click answers 401 for confidential quotes without a user session (checked 2026-11-10)
      if (confidential) return handleError(reply, 400, 'Confidential payouts are not available yet', 'CONFIDENTIAL_UNAVAILABLE');
      try {
        const resolved = await resolveClaim(caseId, baseAddress);
        if ('refused' in resolved) return handleError(reply, resolved.refused.status, resolved.refused.message, resolved.refused.code);
        const { share, leaf } = resolved;
        let payTo = recipient;
        let quote: unknown = null;
        // Intents has no testnet: show the real mainnet quote for this share, but nothing can be signed
        if (route !== 'near' && NEAR_NETWORK !== 'mainnet') {
          const { quote: preview } = await previewPayout(share, route, recipient);
          return ok(reply, { share, amount: leaf.amount, proof: leaf.proof, payTo: null, route, quote: preview, message: null, dryRun: true });
        }
        if (route !== 'near') {
          const q = await quotePayout(share, route, recipient);
          if (!q.quote.depositAddress) return handleError(reply, 502, '1Click returned no deposit address', 'ONECLICK_NO_ADDRESS');
          payTo = q.quote.depositAddress;
          quote = q.quote;
        }
        const message = await fwView<string>('claim_message_for', { case_id: caseId, pay_to: payTo });
        return ok(reply, { share, amount: leaf.amount, proof: leaf.proof, payTo, route, quote, message, dryRun: false });
      } catch (error) {
        return handleError(reply, 502, 'Could not prepare the claim', 'CLAIM_QUOTE_FAILED', error as Error, { caseId });
      }
    },
  );

  /** Dry-run: what a payout of `amount` USDC would arrive as on Base or Solana via 1Click. Moves nothing. */
  app.post(
    '/claims/preview',
    async (request: FastifyRequest<{ Body: { amount: string; route: Destination; recipient: string } }>, reply: FastifyReply) => {
      const valid = await validateRequiredFields(request.body as Record<string, unknown>, ['amount', 'route', 'recipient'], reply);
      if (valid !== true) return;
      const { amount, route, recipient } = request.body;
      if (!isDestination(route)) return handleError(reply, 400, 'route must be base or sol', 'INVALID_ROUTE');
      if (!/^\d{1,15}$/.test(amount) || amount === '0') return handleError(reply, 400, 'amount must be USDC base units', 'INVALID_AMOUNT');
      const okRecipient = route === 'base' ? isAddress(recipient) : SOL_ADDRESS.test(recipient);
      if (!okRecipient) return handleError(reply, 400, `Invalid ${route} address`, 'INVALID_RECIPIENT');
      try {
        const { quote } = await previewPayout(amount, route, recipient);
        return ok(reply, { amountIn: quote.amountIn, amountOut: quote.amountOut, minAmountOut: quote.minAmountOut, timeEstimate: quote.timeEstimate, network: 'mainnet', dry: true });
      } catch (error) {
        return handleError(reply, 502, 'Could not get a 1Click quote', 'ONECLICK_PREVIEW_FAILED', error as Error);
      }
    },
  );

  /** Step 2: the depositor's EVM wallet signed `message`; we check it here, the contract checks it again. */
  app.post(
    '/claims',
    async (
      request: FastifyRequest<{ Body: { caseId: number; baseAddress: string; payTo: string; route: string; signature: string; destinationAddress?: string } }>,
      reply: FastifyReply,
    ) => {
      const valid = await validateRequiredFields(request.body as Record<string, unknown>, ['caseId', 'baseAddress', 'payTo', 'route', 'signature'], reply);
      if (valid !== true) return;
      const { caseId, baseAddress, payTo, route, signature, destinationAddress } = request.body;
      if (!Number.isSafeInteger(caseId) || caseId < 0) return handleError(reply, 400, 'Bad case id', 'INVALID_CASE_ID');
      if (!isAddress(baseAddress) || !NEAR_ACCOUNT.test(payTo)) return handleError(reply, 400, 'Bad address or payTo', 'INVALID_INPUT');
      if (route !== 'near' && !isDestination(route)) return handleError(reply, 400, 'route must be near, base or sol', 'INVALID_ROUTE');
      try {
        const message = await fwView<string>('claim_message_for', { case_id: caseId, pay_to: payTo });
        if (!(await verifyMessage({ address: baseAddress as Hex, message, signature: signature as Hex }))) {
          return handleError(reply, 401, 'Signature does not match the depositor address', 'BAD_SIGNATURE');
        }
        const resolved = await resolveClaim(caseId, baseAddress);
        if ('refused' in resolved) return handleError(reply, resolved.refused.status, resolved.refused.message, resolved.refused.code);
        const { share, leaf } = resolved;
        const data = {
          amount: share,
          leafAmount: leaf.amount,
          payTo,
          route: route === 'near' ? 'near' : '1click',
          destinationAsset: route === 'near' ? null : DESTINATIONS[route as Destination],
          destinationAddress: destinationAddress ?? null,
          signature,
          proof: leaf.proof,
        };
        const key = { caseId, kind: 'depositor', baseAddress: baseAddress.toLowerCase() };
        const taken = () => handleError(reply, 409, 'A claim for this address is already queued or paid', 'CLAIM_EXISTS');
        const existing = await prismaQuery.payout.findUnique({ where: { caseId_kind_baseAddress: key } });
        if (existing) {
          // only a claim that never paid may be re-queued; a failed 1Click leg was already paid on NEAR
          const { count } = await prismaQuery.payout.updateMany({
            where: { id: existing.id, status: 'failed', oneClickStatus: null },
            data: { ...data, status: 'queued', error: null, nearTxHash: null },
          });
          if (count === 0) return taken();
          return ok(reply, { payoutId: existing.id, leafAmount: leaf.amount, share });
        }
        try {
          const payout = await prismaQuery.payout.create({ data: { ...key, ...data } });
          return ok(reply, { payoutId: payout.id, leafAmount: leaf.amount, share });
        } catch (error) {
          if (isPrismaCode(error, 'P2002')) return taken();
          throw error;
        }
      } catch (error) {
        return handleError(reply, 500, 'Could not queue the claim', 'CLAIM_FAILED', error as Error, { caseId });
      }
    },
  );

  app.get('/payouts/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const payout = await prismaQuery.payout.findUnique({ where: { id: request.params.id } });
    if (!payout) return handleNotFoundError(reply, 'Payout');
    return ok(reply, payout);
  });

  /** Owner: register an on-chain commitment in the index. Chain state is the source of truth. */
  app.post<{ Body: { commitmentId: number; slug: string; name: string } }>(
    '/protocols',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const valid = await validateRequiredFields(request.body as Record<string, unknown>, ['commitmentId', 'slug', 'name'], reply);
      if (valid !== true) return;
      const { commitmentId, slug, name } = request.body;
      if (!Number.isSafeInteger(commitmentId) || commitmentId < 0) return handleError(reply, 400, 'Bad commitment id', 'INVALID_COMMITMENT_ID');
      if (!/^[a-z0-9-]{3,40}$/.test(slug)) return handleError(reply, 400, 'slug must be 3-40 chars of a-z, 0-9, -', 'INVALID_SLUG');
      try {
        const c = (await getCommitment(commitmentId)) as {
          owner: string;
          bond: string;
          status: string;
          params: Record<string, unknown> & WatchedParams & { announcer: string };
        } | null;
        if (!c) return handleNotFoundError(reply, 'Commitment');
        if (c.owner !== request.user!.walletAddress) return handleForbiddenError(reply, 'Only the commitment owner can register it');
        const p = c.params;
        const chain = String(p.chain ?? 'Base');
        if (!isEvmChain(chain) || !servedChains().includes(chain)) {
          return handleError(reply, 400, `This indexer does not watch ${chain}`, 'CHAIN_NOT_SERVED');
        }
        let watched: ReturnType<typeof watchedFromParams>;
        let announcerAddress: string;
        try {
          watched = watchedFromParams(p);
          announcerAddress = normAddress(p.announcer);
        } catch (error) {
          // create_commitment validates these; reaching here means the view changed shape
          return handleError(reply, 422, 'The commitment params could not be read', 'BAD_COMMITMENT_PARAMS', error as Error, { commitmentId });
        }
        const covered = await isCovered(commitmentId);
        // created uncovered: if the rewind below fails, caseDriver sees the false -> true flip and retries it
        const protocol = await prismaQuery.protocol.create({
          data: {
            commitmentId,
            slug,
            name,
            chain,
            vaultAddress: watched.watchedAddresses[0],
            watchedAddresses: watched.watchedAddresses,
            watchedTopics: watched.watchedTopics,
            announcerAddress,
            ownerNearAccount: c.owner,
            noticeBlocks: Number(p.notice_blocks),
            maxAnnounceAgeBlocks: Number(p.max_announce_age_blocks),
            effectiveFromBlock: BigInt(p.effective_from_block as number),
            finality: String(p.finality),
            defenceWindow: Number(p.defence_window),
            bond: c.bond,
            status: c.status,
          },
        });
        if (!covered) return ok(reply, protocol);
        try {
          // the cursor may be past this bond's history: rewind, capped, so it is read (upserts are idempotent)
          await backfillCursor({ chain, effectiveFromBlock: protocol.effectiveFromBlock, maxAnnounceAgeBlocks: protocol.maxAnnounceAgeBlocks });
          return ok(reply, await prismaQuery.protocol.update({ where: { id: protocol.id }, data: { covered: true } }));
        } catch (error) {
          console.error(JSON.stringify({ route: 'POST /protocols', event: 'backfill_deferred', protocol: slug, error: (error as Error).message }));
          return ok(reply, protocol);
        }
      } catch (error) {
        if (isPrismaCode(error, 'P2002')) {
          const slugTaken = await prismaQuery.protocol.findUnique({ where: { slug }, select: { commitmentId: true } });
          return slugTaken && slugTaken.commitmentId !== commitmentId
            ? handleError(reply, 409, 'This slug is taken', 'SLUG_TAKEN')
            : handleError(reply, 409, 'This commitment is already registered', 'ALREADY_REGISTERED');
        }
        return handleError(reply, 500, 'Could not register the commitment', 'REGISTER_FAILED', error as Error, { commitmentId });
      }
    },
  );

  /** Owner: build the depositor root; the owner then signs fw.set_root with these values in their wallet. */
  app.post<{ Params: { slug: string }; Body: { snapshotBlock: number; balances: { address: string; amount: string }[] } }>(
    '/protocols/:slug/root',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const { balances, snapshotBlock } = request.body ?? {};
      if (
        !Array.isArray(balances) ||
        balances.length === 0 ||
        balances.length > 10_000 ||
        balances.some((b) => !b || typeof b.address !== 'string' || !isAddress(b.address) || typeof b.amount !== 'string' || !/^\d{1,40}$/.test(b.amount)) ||
        !balances.some((b) => BigInt(b.amount) > 0n)
      ) {
        return handleError(reply, 400, 'balances must be 1-10000 {address, amount} entries, one amount above 0', 'INVALID_BALANCES');
      }
      if (snapshotBlock !== undefined && (!Number.isSafeInteger(snapshotBlock) || snapshotBlock < 0)) {
        return handleError(reply, 400, 'snapshotBlock must be a block number', 'INVALID_SNAPSHOT_BLOCK');
      }
      try {
        const protocol = await prismaQuery.protocol.findUnique({ where: { slug: request.params.slug } });
        if (!protocol) return handleNotFoundError(reply, 'Protocol');
        if (protocol.ownerNearAccount !== request.user!.walletAddress) return handleForbiddenError(reply, 'Owner only');
        // a case freezes the root at finalize; no new roots while one could still be frozen or after the bond is spent
        const open = await prismaQuery.case.count({ where: { protocolId: protocol.id, status: { in: OPEN_CASE } } });
        if (protocol.status !== 'Committed' || open > 0) return handleError(reply, 409, 'The depositor root cannot change now', 'ROOT_LOCKED');
        const r = buildRoot(balances.map((b) => ({ address: b.address, amount: BigInt(b.amount) })));
        // the same balances give the same root: posting them twice is not an error
        await prismaQuery.beneficiaryRoot.upsert({
          where: { protocolId_root: { protocolId: protocol.id, root: r.root } },
          create: { protocolId: protocol.id, root: r.root, total: r.total.toString(), leafCount: r.leafCount, snapshotBlock: BigInt(snapshotBlock ?? 0), tree: r.dump as object },
          update: {},
        });
        return ok(reply, {
          setRootArgs: { commitment_id: protocol.commitmentId, root: { root: r.root, total: r.total.toString(), leaf_count: r.leafCount, snapshot_block: snapshotBlock ?? 0 } },
        });
      } catch (error) {
        return handleError(reply, 500, 'Could not build the depositor root', 'ROOT_FAILED', error as Error, { slug: request.params.slug });
      }
    },
  );

  done();
};
