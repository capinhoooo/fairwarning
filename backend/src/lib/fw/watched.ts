import type { Hex } from 'viem';
import { ADMIN_TOPICS } from './base.ts';

const ADDRESS = /^[0-9a-f]{40}$/;
const TOPIC = /^[0-9a-f]{1,64}$/;

// the contract parses hex with or without 0x, in any case; the index stores lowercase 0x
export const normAddress = (s: string): Hex => {
  const h = String(s).toLowerCase().replace(/^0x/, '');
  if (!ADDRESS.test(h)) throw new Error(`bad watched address: ${s}`);
  return `0x${h}`;
};

export const normTopic = (s: string): Hex => {
  const h = String(s).toLowerCase().replace(/^0x/, '');
  if (!TOPIC.test(h)) throw new Error(`bad watched topic: ${s}`);
  return `0x${h.padStart(64, '0')}`;
};

export type WatchedParams = { watched?: unknown; watched_topics?: unknown };

/** params.watched and params.watched_topics of a commitment, normalized; order kept, so [0] is the vault. */
export const watchedFromParams = (p: WatchedParams): { watchedAddresses: Hex[]; watchedTopics: Hex[] } => {
  if (!Array.isArray(p.watched) || p.watched.length === 0) throw new Error('commitment watches no address');
  if (!Array.isArray(p.watched_topics) || p.watched_topics.length === 0) throw new Error('commitment watches no topic');
  return {
    watchedAddresses: [...new Set(p.watched.map(normAddress))],
    watchedTopics: [...new Set(p.watched_topics.map(normTopic))],
  };
};

type Watching = { vaultAddress: string; watchedAddresses: string[]; watchedTopics: string[] };

// rows registered before the watched columns existed keep the old rule: the vault and the fixed admin topics
export const addressesOf = (p: Pick<Watching, 'vaultAddress' | 'watchedAddresses'>): string[] =>
  p.watchedAddresses.length > 0 ? p.watchedAddresses : [p.vaultAddress];
export const topicsOf = (p: Pick<Watching, 'watchedTopics'>): string[] => (p.watchedTopics.length > 0 ? p.watchedTopics : ADMIN_TOPICS);

/** The contract's check_breach address and topic0 rule. */
export const watches = (p: Watching, log: { address: string; topics: readonly string[] }): boolean =>
  log.topics.length > 0 && addressesOf(p).includes(log.address) && topicsOf(p).includes(log.topics[0]);
