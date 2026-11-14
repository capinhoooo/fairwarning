import { config } from '@/config'

interface ApiResponse<T> {
  success: boolean
  error: { code: string; message: string } | null
  data: T
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message)
  }
}

const request = async <T>(
  path: string,
  init?: RequestInit & { token?: string },
): Promise<T> => {
  const res = await fetch(`${config.fw.apiUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.token ? { Authorization: `Bearer ${init.token}` } : {}),
      ...init?.headers,
    },
  })
  const body = (await res.json().catch(() => null)) as ApiResponse<T> | null
  if (!body?.success)
    throw new ApiError(
      body?.error?.message ?? `Request failed (${res.status})`,
      body?.error?.code ?? 'HTTP_ERROR',
      res.status,
    )
  return body.data
}

const post = <T>(path: string, body: unknown, token?: string) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body), token })

export type Hex = `0x${string}`
export type Finality = 'Safe' | 'Finalized'
export type EvmChain =
  | 'Base'
  | 'Arbitrum'
  | 'Bnb'
  | 'Polygon'
  | 'Avalanche'
  | 'HyperEvm'
  | 'Abstract'
export type CaseStatus =
  | 'Reported'
  | 'DefenceOpen'
  | 'Defended'
  | 'Breached'
  | 'Paid'
  | 'Rejected'
  | 'Moot'

export interface LogInput {
  tx_hash: Hex
  log_index: number
  transaction_index: number
  block_hash: Hex
  block_number: number
  address: Hex
  data: Hex
  topics: Array<Hex>
}

export interface Protocol {
  id: string
  slug: string
  name: string
  commitmentId: number
  chain: EvmChain
  vaultAddress: Hex
  announcerAddress: Hex
  ownerNearAccount: string
  noticeBlocks: number
  maxAnnounceAgeBlocks: number
  effectiveFromBlock: string
  defenceWindow: number
  finality: Finality
  bond: string
  status: 'Committed' | 'Breached' | 'Closed'
  covered: boolean
  createdAt: string
  _count?: { announcements: number; cases: number }
}

export interface ProtocolDetail extends Protocol {
  announcements: Array<Announcement>
  adminEvents: Array<AdminEvent>
  cases: Array<CaseRow>
}

export interface Announcement {
  id: string
  actionHash: Hex
  expectedLog: Hex
  txHash: Hex
  logIndex: number
  blockNumber: string
  createdAt: string
}

export interface AdminEvent {
  id: string
  topic0: Hex
  txHash: Hex
  logIndex: number
  blockNumber: string
  verdict: 'announced' | 'breach'
  announcementId: string | null
  caseId: number | null
  createdAt: string
}

export interface CaseRow {
  caseId: number
  status: CaseStatus
  txHash: Hex
  logIndex: number
  reporter: string
  actionHash: Hex | null
  breachBlock: string | null
  deadline: string | null
  reward: string | null
  pool: string | null
  rewardPaid: boolean
  pendingDefences: number
  defenceTxHash: string | null
  finalizeTxHash: string | null
  createdAt: string
  protocol?: { slug: string; name: string }
}

/** get_case as the contract returns it; the source of truth while the indexer catches up. */
export interface ChainCase {
  commitment_id: number
  reporter: string
  tx_hash: string
  log_index: number
  breach_block: number
  action_hash: string
  status: CaseStatus
  deadline: number
  pending_defences: number
  reward: string
  pool: string
  paid: string
  reserved: string
  claims: number
  reward_paid: boolean
}

export interface CaseDetail extends Partial<CaseRow> {
  protocol?: Protocol
  payouts?: Array<Payout>
  chain: ChainCase | null
}

export interface Payout {
  id: string
  caseId: number
  kind: 'reward' | 'depositor'
  amount: string
  payTo: string
  route: 'near' | '1click'
  destinationAddress: string | null
  status: 'queued' | 'submitted' | 'paid' | 'bridged' | 'failed'
  oneClickStatus: string | null
  nearTxHash: string | null
  error: string | null
  createdAt: string
}

export interface ContractCall {
  contractId: string
  method: string
  args: Record<string, unknown>
  deposit: string
  gasTgas: number
}

export interface PreparedReport {
  commitmentId: number
  protocol: string
  protocolName: string
  chain: EvmChain
  finality: Finality
  /** false once the bond is spent: the contract refuses new reports */
  active: boolean
  log: LogInput
  fingerprint: Hex
  verdict: 'announced' | 'breach' | 'unknown'
  caseId: number | null
  expectedPayloadHash: Hex
  report: ContractCall
  fallback: ContractCall
}

export type ClaimRoute = 'near' | 'base' | 'sol'

export interface ClaimQuote {
  share: string
  amount: string
  proof: Array<string>
  /** null on a dry run */
  payTo: string | null
  route: ClaimRoute
  message: string | null
  /** the 1Click quote for Intents routes */
  quote: {
    amountOut: string
    minAmountOut: string
    timeEstimate: number
  } | null
  /** testnet: a real mainnet quote, nothing to sign */
  dryRun: boolean
}

export interface Heads {
  base: number
  baseSafe: number
  near: number
  /** other watched chains, keyed by chain */
  chains: Partial<Record<EvmChain, { head: number; safe: number }>>
  at: number
}

export interface ChainInfo {
  chain: EvmChain
  chainId: number
  name: string
  explorer: string | null
  /** measured over the last 1,000 blocks */
  blockTimeS: number | null
}

export interface PayoutPreview {
  amountIn: string
  amountOut: string
  minAmountOut: string
  timeEstimate: number
  network: 'mainnet'
  dry: true
}

export interface Stats {
  protocols: number
  covered: number
  bonded: string
  openCases: number
  paidOut: string
}

export interface RootInput {
  snapshotBlock: number
  balances: Array<{ address: string; amount: string }>
}

export const getHeads = () => request<Heads>('/fw/heads')
export const getStats = () => request<Stats>('/fw/stats')
export const getProtocols = () => request<Array<Protocol>>('/fw/protocols')
export const getProtocol = (slug: string) =>
  request<ProtocolDetail>(`/fw/protocols/${encodeURIComponent(slug)}`)
export const getCases = () => request<Array<CaseRow>>('/fw/cases')
export const getCase = (caseId: number) =>
  request<CaseDetail>(`/fw/cases/${caseId}`)
export const getCaseByLog = (
  commitmentId: number,
  txHash: string,
  logIndex: number,
) =>
  request<{ caseId: number | null }>(
    `/fw/cases/by-log/${commitmentId}/${txHash}/${logIndex}`,
  )
export const getPayout = (id: string) =>
  request<Payout>(`/fw/payouts/${encodeURIComponent(id)}`)
export interface RecentAdminEvent {
  txHash: Hex
  logIndex: number
  topic0: Hex
  blockNumber: string
  verdict: 'announced' | 'breach'
  caseId: number | null
  protocol: { slug: string; name: string; chain: EvmChain }
}
export const getAdminEvents = () =>
  request<Array<RecentAdminEvent>>('/fw/admin-events')
export interface LatestAnnouncement {
  txHash: Hex
  expectedLog: Hex
  blockNumber: string
  bond: {
    slug: string
    name: string
    chain: EvmChain
    noticeBlocks: number
    bond: string
    status: string
  }
}
export const getLatestAnnouncement = () =>
  request<LatestAnnouncement | null>('/fw/announcements/latest')
export const getChains = () => request<Array<ChainInfo>>('/fw/chains')
export const prepareReport = (txHash: string, chain?: EvmChain) =>
  post<Array<PreparedReport>>('/fw/report/prepare', { txHash, chain })
export const previewPayout = (body: {
  amount: string
  route: 'base' | 'sol'
  recipient: string
}) => post<PayoutPreview>('/fw/claims/preview', body)
export const quoteClaim = (body: {
  caseId: number
  baseAddress: string
  route: ClaimRoute
  recipient: string
}) => post<ClaimQuote>('/fw/claims/quote', body)
export const submitClaim = (body: {
  caseId: number
  baseAddress: string
  payTo: string
  route: ClaimRoute
  signature: string
  destinationAddress?: string
}) =>
  post<{ payoutId: string; leafAmount: string; share: string }>(
    '/fw/claims',
    body,
  )

// owners sign in with NEP-413, then register their commitment and depositor root
export const getNonce = (accountId: string) =>
  post<{ nonce: string; recipient: string; message: string }>('/auth/nonce', {
    accountId,
  })
export const verifySignIn = (body: {
  accountId: string
  publicKey: string
  signature: string
}) => post<{ token: string; accountId: string }>('/auth/verify', body)
export const registerProtocol = (
  token: string,
  body: { commitmentId: number; slug: string; name: string },
) => post<Protocol>('/fw/protocols', body, token)
export const buildRoot = (token: string, slug: string, body: RootInput) =>
  post<{
    setRootArgs: {
      commitment_id: number
      root: {
        root: Hex
        total: string
        leaf_count: number
        snapshot_block: number
      }
    }
  }>(`/fw/protocols/${encodeURIComponent(slug)}/root`, body, token)
