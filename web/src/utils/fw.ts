import {  toEventSelector } from 'viem'
import * as chains from 'viem/chains'
import type {Chain} from 'viem';
import type { EvmChain } from '@/lib/api/fw'
import { config } from '@/config'

// Base mainnet makes a block about every 0.2 s (measured 2026-11-10); NEAR about every 0.6 s
export const BASE_BLOCK_S = 0.2
export const NEAR_BLOCK_S = 0.6
export const USDC_DECIMALS = 6

export const EVENT_NAMES: Record<string, string> = {
  [toEventSelector('Upgraded(address)')]: 'Upgraded',
  [toEventSelector('OwnershipTransferred(address,address)')]:
    'OwnershipTransferred',
  [toEventSelector('RoleGranted(bytes32,address,address)')]: 'RoleGranted',
  [toEventSelector('Announce(bytes32,address,bytes)')]: 'Announce',
}

export const fmtInt = (n: number | bigint | string) =>
  BigInt(n).toLocaleString('en-US')

const fmtUnits = (raw: string | bigint, decimals: number, maxFrac: number) => {
  const v = BigInt(raw)
  const base = 10n ** BigInt(decimals)
  const whole = v / base
  const frac = (v % base)
    .toString()
    .padStart(decimals, '0')
    .slice(0, maxFrac)
    .replace(/0+$/, '')
  return `${whole.toLocaleString('en-US')}${frac ? `.${frac}` : ''}`
}

export const fmtUsdc = (raw: string | bigint | null | undefined) =>
  raw == null ? '—' : `${fmtUnits(raw, USDC_DECIMALS, 2)} USDC`
export const fmtNear = (yocto: string | bigint | null | undefined) =>
  yocto == null ? '—' : `${fmtUnits(yocto, 24, 3)} NEAR`

/** "12.5" USDC to base units; null when the input is not a positive amount with at most 6 decimals. */
export const usdcToUnits = (input: string): bigint | null => {
  const t = input.trim()
  if (!/^\d+(\.\d{1,6})?$/.test(t)) return null
  const [whole, frac = ''] = t.split('.')
  const v = BigInt(whole) * 10n ** 6n + BigInt(frac.padEnd(6, '0'))
  return v > 0n ? v : null
}

export const nearToYocto = (input: string): bigint | null => {
  const t = input.trim()
  if (!/^\d+(\.\d{1,24})?$/.test(t)) return null
  const [whole, frac = ''] = t.split('.')
  return BigInt(whole) * 10n ** 24n + BigInt(frac.padEnd(24, '0'))
}

export const fmtDuration = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds))
  if (s < 90) return `${s} s`
  if (s < 90 * 60) return `${Math.round(s / 60)} min`
  if (s < 48 * 3600) {
    const h = Math.floor(s / 3600),
      m = Math.round((s % 3600) / 60)
    return m && h < 10 ? `${h} h ${m} min` : `${Math.round(s / 3600)} h`
  }
  return `${Math.round(s / 86400)} d`
}

export const nearBlocksToTime = (blocks: number) =>
  fmtDuration(blocks * NEAR_BLOCK_S)

const TESTNET = config.fw.nearNetwork === 'testnet'

// v1.signer reads these networks: mainnet from v1.signer, testnets from v1.signer-prod.testnet
const NETWORKS: Record<EvmChain, { label: string; net: [Chain, Chain] }> = {
  Base: { label: 'Base', net: [chains.base, chains.baseSepolia] },
  Arbitrum: {
    label: 'Arbitrum',
    net: [chains.arbitrum, chains.arbitrumSepolia],
  },
  Bnb: { label: 'BNB Chain', net: [chains.bsc, chains.bscTestnet] },
  Polygon: { label: 'Polygon', net: [chains.polygon, chains.polygonAmoy] },
  Avalanche: {
    label: 'Avalanche',
    net: [chains.avalanche, chains.avalancheFuji],
  },
  HyperEvm: {
    label: 'HyperEVM',
    net: [chains.hyperEvm, chains.hyperliquidEvmTestnet],
  },
  Abstract: {
    label: 'Abstract',
    net: [chains.abstract, chains.abstractTestnet],
  },
}
export const EVM_CHAINS = Object.keys(NETWORKS) as Array<EvmChain>

export const chainLabel = (c: EvmChain | null | undefined) =>
  NETWORKS[c ?? 'Base'].label

/** Explorer links on the network this deployment reads (testnets when NEAR is testnet). */
export const evmLinks = (c: EvmChain | null | undefined) => {
  const net = NETWORKS[c ?? 'Base'].net[TESTNET ? 1 : 0]
  const root = net.blockExplorers?.default.url ?? ''
  return {
    name: net.blockExplorers?.default.name ?? 'explorer',
    tx: (h: string) => `${root}/tx/${h}`,
    addr: (a: string) => `${root}/address/${a}`,
    block: (b: number | string) => `${root}/block/${b}`,
  }
}

/** Notice length as time, or null when this chain's block time is not known yet. */
export const blocksToTime = (blocks: number, blockS: number | null) =>
  blockS ? fmtDuration(blocks * blockS) : null

export const short = (s: string | null | undefined, head = 6, tail = 4) =>
  !s
    ? '—'
    : s.length <= head + tail + 1
      ? s
      : `${s.slice(0, head)}…${s.slice(-tail)}`

/** NEAR named accounts read whole; only 64-hex implicit accounts and long addresses get cut. */
export const account = (a: string | null | undefined) =>
  !a ? '—' : a.length <= 32 ? a : short(a, 10, 8)

/** The contract returns EVM tx hashes without 0x. */
export const hex0x = (h: string | null | undefined) =>
  !h ? '' : h.startsWith('0x') ? h : `0x${h}`

export const links = {
  nearTx: (h: string) => `${config.fw.nearExplorer}/txns/${h}`,
  nearAccount: (a: string) => `${config.fw.nearExplorer}/address/${a}`,
  intents: (depositAddress: string) =>
    `${config.fw.intentsExplorer}/transactions?search=${depositAddress}`,
}

export const isTxHash = (s: string) => /^0x[0-9a-fA-F]{64}$/.test(s.trim())
export const isEvmAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s.trim())
export const isNearAccount = (s: string) =>
  /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(
    s.trim(),
  )
export const isSolAddress = (s: string) =>
  /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s.trim())

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)

/** Announcer's expectedLog is emitter (20 bytes) ++ topics ++ data; turn it into "Upgraded → 0x5FC8…a2f3". */
export const describeExpectedLog = (hex: string) => {
  const h = hex.replace(/^0x/, '')
  if (h.length < 104) return 'Unknown action'
  const topic0 = `0x${h.slice(40, 104)}`
  const name = EVENT_NAMES[topic0] ?? `topic ${short(topic0, 10, 4)}`
  const words = h.slice(104).match(/.{64}/g) ?? []
  const addr = (w?: string) => (w ? short(`0x${w.slice(24)}`) : '')
  if (name === 'Upgraded') return `Upgraded → ${addr(words[0])}`
  if (name === 'OwnershipTransferred') return `Owner → ${addr(words[1])}`
  if (name === 'RoleGranted') return `Role granted → ${addr(words[1])}`
  return name
}
