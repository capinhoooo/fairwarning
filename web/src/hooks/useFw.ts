import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type {EvmChain} from '@/lib/api/fw';
import {
  
  getAdminEvents,
  getCase,
  getCases,
  getChains,
  getHeads,
  getLatestAnnouncement,
  getPayout,
  getProtocol,
  getProtocols,
  getStats,
  prepareReport,
  quoteClaim,
  submitClaim
} from '@/lib/api/fw'
import { BASE_BLOCK_S, NEAR_BLOCK_S, chainLabel, evmLinks } from '@/utils/fw'

const LIVE = 4_000 // cases move every few NEAR blocks
const DONE_CASE = ['Defended', 'Paid', 'Rejected', 'Moot']

export const useHeads = () =>
  useQuery({
    queryKey: ['fw', 'heads'],
    queryFn: async () => ({ ...(await getHeads()), seenAt: Date.now() }),
    refetchInterval: 6_000,
    retry: 1,
  })

/**
 * A getter for the live chain heads between polls: Base and NEAR keep producing blocks at a steady rate,
 * so the estimate runs forward from the last read and never steps backwards when the next read lands.
 */
export const useChainClock = () => {
  const { data } = useHeads()
  const ref = useRef({ data, base: 0, near: 0 })
  ref.current.data = data
  const base = useCallback(() => {
    const r = ref.current
    if (!r.data) return null
    const est = Math.floor(
      r.data.base + (Date.now() - r.data.seenAt) / 1000 / BASE_BLOCK_S,
    )
    r.base = Math.max(r.base, est)
    return r.base
  }, [])
  const near = useCallback(() => {
    const r = ref.current
    if (!r.data) return null
    const est = Math.floor(
      r.data.near + (Date.now() - r.data.seenAt) / 1000 / NEAR_BLOCK_S,
    )
    r.near = Math.max(r.near, est)
    return r.near
  }, [])
  // other chains: the last polled head, never backwards
  const evm = useCallback(
    (c: EvmChain) => {
      const r = ref.current
      if (c === 'Base') return base()
      return r.data?.chains[c]?.head ?? null
    },
    [base],
  )
  const safe = useCallback(
    (c: EvmChain) =>
      c === 'Base'
        ? (ref.current.data?.baseSafe ?? null)
        : (ref.current.data?.chains[c]?.safe ?? null),
    [],
  )
  return { base, near, evm, safe, heads: data ?? null }
}

export const useAdminEvents = () =>
  useQuery({
    queryKey: ['fw', 'admin-events'],
    queryFn: getAdminEvents,
    refetchInterval: 30_000,
  })

export const useLatestAnnouncement = () =>
  useQuery({
    queryKey: ['fw', 'announcements', 'latest'],
    queryFn: getLatestAnnouncement,
    refetchInterval: 30_000,
  })

export const useChains = () =>
  useQuery({
    queryKey: ['fw', 'chains'],
    queryFn: getChains,
    staleTime: 10 * 60_000,
  })

/** Label, explorer links and measured block time for one chain. */
export const useChainInfo = (c: EvmChain | null | undefined) => {
  const chain = c ?? 'Base'
  const { data } = useChains()
  const measured = data?.find((x) => x.chain === chain)?.blockTimeS ?? null
  return {
    chain,
    label: chainLabel(chain),
    links: evmLinks(chain),
    blockS: measured ?? (chain === 'Base' ? BASE_BLOCK_S : null),
  }
}

/** Re-renders every `ms` so live numbers stay current in plain JSX. */
export const useNow = (ms = 1000) => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

export const useStats = () =>
  useQuery({
    queryKey: ['fw', 'stats'],
    queryFn: getStats,
    refetchInterval: 15_000,
  })

export const useProtocols = () =>
  useQuery({
    queryKey: ['fw', 'protocols'],
    queryFn: getProtocols,
    refetchInterval: 15_000,
  })

export const useProtocol = (slug: string) =>
  useQuery({
    queryKey: ['fw', 'protocol', slug],
    queryFn: () => getProtocol(slug),
    refetchInterval: LIVE,
  })

export const useCases = () =>
  useQuery({
    queryKey: ['fw', 'cases'],
    queryFn: getCases,
    refetchInterval: LIVE,
  })

export const useCase = (caseId: number | null) =>
  useQuery({
    queryKey: ['fw', 'case', caseId],
    queryFn: () => getCase(caseId!),
    enabled: caseId !== null,
    refetchInterval: (q) => {
      const s = q.state.data?.chain?.status ?? q.state.data?.status
      return s &&
        DONE_CASE.includes(s) &&
        !q.state.data?.payouts?.some((p) =>
          ['queued', 'submitted', 'paid'].includes(p.status),
        )
        ? false
        : LIVE
    },
  })

export const usePayout = (id: string | null) =>
  useQuery({
    queryKey: ['fw', 'payout', id],
    queryFn: () => getPayout(id!),
    enabled: id !== null,
    refetchInterval: (q) =>
      q.state.data && ['bridged', 'failed'].includes(q.state.data.status)
        ? false
        : LIVE,
  })

export const usePrepareReport = () =>
  useMutation({
    mutationFn: (v: { txHash: string; chain?: EvmChain }) =>
      prepareReport(v.txHash, v.chain),
  })
export const useQuoteClaim = () => useMutation({ mutationFn: quoteClaim })
export const useSubmitClaim = () => useMutation({ mutationFn: submitClaim })
