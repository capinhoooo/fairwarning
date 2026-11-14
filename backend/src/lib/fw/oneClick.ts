import { APP_FEE_BPS, NEAR_NETWORK, ONECLICK_API_KEY, ONECLICK_API_URL, ONECLICK_REFUND_TO, USDC_CONTRACT_ID } from '../../config/main-config.ts';

// Asset ids from GET /v0/tokens (checked 2026-11-10). Mainnet only: Intents has no testnet.
export const DESTINATIONS = {
  base: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
  sol: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near'
} as const;
export type Destination = keyof typeof DESTINATIONS;

const ORIGIN_ASSET = `nep141:${USDC_CONTRACT_ID}`;
// a quote's deposit address must stay valid while the user signs and the relayer submits
const QUOTE_TTL_MS = 60 * 60 * 1000;

export interface OneClickQuote {
  depositAddress?: string;
  amountIn: string;
  amountOut: string;
  minAmountOut: string;
  timeEstimate: number;
  deadline?: string;
}

const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const res = await fetch(`${ONECLICK_API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(ONECLICK_API_KEY ? { 'X-API-Key': ONECLICK_API_KEY } : {})
    }
  });
  const body = await res.json().catch(() => ({}));
  // 1Click answers 400 "Internal server error" when refundTo is not an existing NEAR account
  if (!res.ok) throw new Error(`1Click ${path} ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body as T;
};

/**
 * USDC on NEAR -> USDC on Base or Solana. The returned depositAddress (64-hex implicit account)
 * becomes the claim's `pay_to`. Confidential quotes need a user session (401), so payouts are public.
 */
export const quotePayout = (amount: string, route: Destination, recipient: string) =>
  request<{ quote: OneClickQuote }>('/v0/quote', {
    method: 'POST',
    body: JSON.stringify({
      dry: false,
      swapType: 'EXACT_INPUT',
      slippageTolerance: 100,
      originAsset: ORIGIN_ASSET,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: DESTINATIONS[route],
      amount,
      refundTo: ONECLICK_REFUND_TO,
      refundType: 'ORIGIN_CHAIN',
      recipient,
      recipientType: 'DESTINATION_CHAIN',
      deadline: new Date(Date.now() + QUOTE_TTL_MS).toISOString(),
      ...(APP_FEE_BPS > 0 ? { appFees: [{ recipient: ONECLICK_REFUND_TO, fee: APP_FEE_BPS }] } : {})
    })
  });

// Native USDC on NEAR mainnet: previews always quote the mainnet route, since Intents has no testnet
const MAINNET_USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

/**
 * A `dry: true` quote: real price and time, no deposit address, nothing can be sent to it.
 * Dry quotes move no funds, so refundTo only has to be an existing mainnet account.
 */
export const previewPayout = (amount: string, route: Destination, recipient: string) =>
  request<{ quote: OneClickQuote }>('/v0/quote', {
    method: 'POST',
    body: JSON.stringify({
      dry: true,
      swapType: 'EXACT_INPUT',
      slippageTolerance: 100,
      originAsset: MAINNET_USDC,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: DESTINATIONS[route],
      amount,
      refundTo: NEAR_NETWORK === 'mainnet' && ONECLICK_REFUND_TO ? ONECLICK_REFUND_TO : 'intents.near',
      refundType: 'ORIGIN_CHAIN',
      recipient,
      recipientType: 'DESTINATION_CHAIN',
      deadline: new Date(Date.now() + QUOTE_TTL_MS).toISOString()
    })
  });

/** Speeds up detection of the NEAR deposit; 1Click also finds it on its own. */
export const submitDeposit = (txHash: string, depositAddress: string, nearSenderAccount: string) =>
  request('/v0/deposit/submit', {
    method: 'POST',
    body: JSON.stringify({ txHash, depositAddress, nearSenderAccount })
  });

export type OneClickStatus =
  | 'KNOWN_DEPOSIT_TX'
  | 'PENDING_DEPOSIT'
  | 'INCOMPLETE_DEPOSIT'
  | 'PROCESSING'
  | 'SUCCESS'
  | 'REFUNDED'
  | 'FAILED';

export const getStatus = (depositAddress: string) =>
  request<{ status: OneClickStatus }>(`/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`);
