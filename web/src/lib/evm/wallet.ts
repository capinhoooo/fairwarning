import { createWalletClient, custom } from 'viem'
import type { EIP1193Provider } from 'viem'

declare global {
  interface Window {
    ethereum?: EIP1193Provider
  }
}

const client = () => {
  if (!window.ethereum)
    throw new Error(
      'Open this page in a browser with an EVM wallet to prove your Base address',
    )
  return createWalletClient({ transport: custom(window.ethereum) })
}

/** Depositors prove their Base address with personal_sign; no chain switch or transaction needed. */
export const requestEvmAddress = async (): Promise<`0x${string}`> => {
  const [address] = await client().requestAddresses()
  return address
}

export const signWithEvm = (account: `0x${string}`, message: string) =>
  client().signMessage({ account, message })
