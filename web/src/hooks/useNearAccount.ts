import { useEffect, useState } from 'react'
import { getConnector } from '@/lib/near/wallet'

export const useNearAccount = () => {
  const [accountId, setAccountId] = useState<string | null>(null)
  useEffect(() => {
    const c = getConnector()
    const onIn = (e: { accounts: Array<{ accountId: string }> }) =>
      setAccountId(e.accounts[0]?.accountId ?? null)
    const onOut = () => setAccountId(null)
    c.on('wallet:signIn', onIn)
    c.on('wallet:signOut', onOut)
    c.getConnectedWallet()
      .then((w) => setAccountId(w.accounts[0]?.accountId ?? null))
      .catch(() => setAccountId(null))
    return () => {
      c.off('wallet:signIn', onIn)
      c.off('wallet:signOut', onOut)
    }
  }, [])
  return {
    accountId,
    connect: () => getConnector().connect(),
    disconnect: () => getConnector().disconnect(),
  }
}
