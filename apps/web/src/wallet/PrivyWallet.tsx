import type { ReactNode } from 'react'
import { PrivyProvider, usePrivy } from '@privy-io/react-auth'
import { useSignTransaction, useSignMessage, useWallets } from '@privy-io/react-auth/solana'
import { getBase58Decoder } from '@solana/kit'
import { submitWalletTransaction } from './network'
import { gateRequest, WalletContext } from './access'

export default function PrivyWallet({ children }: { children: ReactNode }) {
  return <PrivyProvider appId={import.meta.env.VITE_PRIVY_APP_ID} config={{
    loginMethods: ['email'], appearance: { walletChainType: 'solana-only', theme: 'dark' },
    embeddedWallets: { solana: { createOnLogin: 'all-users' } },
  }}><Bridge>{children}</Bridge></PrivyProvider>
}

function Bridge({ children }: { children: ReactNode }) {
  const { ready, authenticated, login, logout } = usePrivy()
  const { wallets, ready: walletsReady } = useWallets()
  const wallet = authenticated ? wallets[0] : undefined
  const { signMessage } = useSignMessage()
  const { signTransaction } = useSignTransaction()
  return <WalletContext.Provider value={{
    ready: ready && (!authenticated || walletsReady), address: wallet?.address, login,
    logout: async () => {
      try { await gateRequest('sessions', undefined, 'DELETE') }
      finally { await logout() }
    },
    challenge: async action => {
      if (!wallet) throw new Error('Connect your Solana wallet first.')
      const ch = await gateRequest<{ challengeId: string; message: string }>('challenges', { wallet: wallet.address, action })
      const { signature } = await signMessage({ wallet, message: new TextEncoder().encode(ch.message) })
      return { challengeId: ch.challengeId, signature: getBase58Decoder().decode(signature) }
    },
    send: async (encoded, onSigned) => {
      if (!wallet) throw new Error('Connect your Solana wallet first.')
      return submitWalletTransaction(encoded, wallet.address, async transaction => {
        const signed = await signTransaction({ wallet, transaction })
        return signed.signedTransaction
      }, onSigned)
    },
  }}>{children}</WalletContext.Provider>
}
