import { NearConnector } from '@hot-labs/near-connect'
import { config } from '@/config'

let connector: NearConnector | null = null

// Browser only: NEAR Connect runs wallet code in sandboxed iframes
export const getConnector = (): NearConnector => {
  connector ??= new NearConnector({
    network: config.fw.nearNetwork,
    footerBranding: null,
  })
  return connector
}

const TGAS = 1_000_000_000_000n

export interface Call {
  receiverId: string
  methodName: string
  args: Record<string, unknown>
  gasTgas: number
  deposit?: string
}

const action = (c: Call) => ({
  type: 'FunctionCall' as const,
  params: {
    methodName: c.methodName,
    args: c.args,
    gas: (BigInt(c.gasTgas) * TGAS).toString(),
    deposit: c.deposit ?? '0',
  },
})

interface Outcome {
  transaction: { hash: string }
  status: { SuccessValue?: string; Failure?: unknown } | string
}

/** Signs and sends one function call with the connected wallet; returns the tx hash and the decoded return value. */
export const callContract = async <T = unknown>(
  c: Call,
): Promise<{ hash: string; value: T | null }> => {
  const wallet = await getConnector().wallet()
  const outcome = (await wallet.signAndSendTransaction({
    receiverId: c.receiverId,
    actions: [action(c)],
  })) as unknown as Outcome
  if (typeof outcome.status === 'object' && outcome.status.Failure)
    throw new Error(
      `Transaction failed: ${JSON.stringify(outcome.status.Failure)}`,
    )
  const raw =
    typeof outcome.status === 'object' ? outcome.status.SuccessValue : undefined
  const value = raw ? (JSON.parse(atob(raw)) as T) : null
  return { hash: outcome.transaction.hash, value }
}

/** NEP-413 sign-in: the backend checks the signature and that the key is a full-access key of the account. */
export const signNep413 = async (p: {
  message: string
  recipient: string
  nonceBase64: string
}) => {
  const wallet = await getConnector().wallet()
  const nonce = Uint8Array.from(atob(p.nonceBase64), (ch) => ch.charCodeAt(0))
  return wallet.signMessage({
    message: p.message,
    recipient: p.recipient,
    nonce,
  })
}

/** Several calls, possibly to different contracts, approved in one wallet prompt; returns the tx hashes. */
export const callContracts = async (calls: Array<Call>) => {
  const wallet = await getConnector().wallet()
  const outcomes = (await wallet.signAndSendTransactions({
    transactions: calls.map((c) => ({
      receiverId: c.receiverId,
      actions: [action(c)],
    })),
  })) as unknown as Array<Outcome>
  const failed = outcomes.find(
    (o) => typeof o.status === 'object' && o.status.Failure,
  )
  if (failed) throw new Error(`Transaction ${failed.transaction.hash} failed`)
  return outcomes.map((o) => o.transaction.hash)
}
