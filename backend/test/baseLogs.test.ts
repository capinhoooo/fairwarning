// Adaptive eth_getLogs chunking against the provider limits measured on 2026-11-10.
import { describe, expect, test } from 'bun:test';
import { isRangeError, readLogsAdaptive } from '../src/lib/fw/base.ts';

// what sepolia.base.org answers above 200 blocks, and what mainnet.base.org answers when busy
const SEPOLIA_RANGE = { details: 'eth_getLogs is limited to a 200 range', message: 'RPC Request failed.' };
const RATE_LIMIT = { details: 'request limit reached', message: 'RPC Request failed.' };

/** Fake provider: fails above `cap` blocks per call, returns one "log" per block otherwise. */
const provider = (cap: bigint) => {
  const calls: [bigint, bigint][] = [];
  const fetchLogs = async (from: bigint, to: bigint) => {
    calls.push([from, to]);
    if (to - from + 1n > cap) throw SEPOLIA_RANGE;
    const out: bigint[] = [];
    for (let b = from; b <= to; b++) out.push(b);
    return out;
  };
  return { calls, fetchLogs };
};

describe('isRangeError', () => {
  test('recognizes range caps, not rate limits', () => {
    expect(isRangeError(SEPOLIA_RANGE)).toBe(true);
    expect(isRangeError({ message: 'Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.' })).toBe(true);
    expect(isRangeError({ message: 'query returned more than 10000 results' })).toBe(true);
    expect(isRangeError(RATE_LIMIT)).toBe(false);
  });
});

describe('readLogsAdaptive', () => {
  test('shrinks a 1000-block chunk to fit a 200-block cap and reads every block once', async () => {
    const p = provider(200n);
    const state = { chunk: 1000n };
    const { logs, lastRead } = await readLogsAdaptive(p.fetchLogs, 1n, 600n, state, 20);
    expect(state.chunk).toBe(125n); // 1000 -> 500 -> 250 -> 125
    expect(lastRead).toBe(600n);
    expect(logs.length).toBe(600);
    expect(new Set(logs).size).toBe(600);
  });

  test('stops at the call budget and reports how far it got', async () => {
    const p = provider(10n);
    const state = { chunk: 10n };
    const { lastRead } = await readLogsAdaptive(p.fetchLogs, 1n, 1_000n, state, 3);
    expect(lastRead).toBe(30n);
    expect(p.calls.length).toBe(3);
  });

  test('a rate limit is thrown without shrinking the chunk', async () => {
    const state = { chunk: 200n };
    const failing = async () => {
      throw RATE_LIMIT;
    };
    await expect(readLogsAdaptive(failing, 1n, 100n, state, 5)).rejects.toBe(RATE_LIMIT);
    expect(state.chunk).toBe(200n);
  });

  test('nothing to read returns lastRead = from - 1', async () => {
    const p = provider(200n);
    const { logs, lastRead } = await readLogsAdaptive(p.fetchLogs, 50n, 49n, { chunk: 200n }, 5);
    expect(logs.length).toBe(0);
    expect(lastRead).toBe(49n);
  });
});
