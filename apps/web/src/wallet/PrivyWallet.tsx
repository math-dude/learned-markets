import type { ReactNode } from 'react'
import { PrivyProvider, usePrivy } from '@privy-io/react-auth'
import { useSignTransaction, useSignMessage, useWallets } from '@privy-io/react-auth/solana'
import { createSolanaRpc, createSolanaRpcSubscriptions, getBase58Decoder } from '@solana/kit'
import { submitWalletTransaction } from './network'
import { gateRequest, WalletContext } from './access'

async function walletSignature<T>(result: Promise<T>, timeout: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      result,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('The wallet signature timed out. Close any open Privy prompt and try again.')),
          timeout,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

// Privy supports named Solana clusters. Use its test-cluster slot for our
// configured validator and route wallet previews through the same-origin backend.
const signingChain = 'solana:devnet' as const
const previewUrl = new URL('/v1/wallet-preview', window.location.origin)
const previewWs = new URL(previewUrl)
previewWs.protocol = previewUrl.protocol === 'https:' ? 'wss:' : 'ws:'
const signingRpcs = {
  [signingChain]: {
    rpc: createSolanaRpc(previewUrl.href),
    rpcSubscriptions: createSolanaRpcSubscriptions(previewWs.href),
  },
}

export default function PrivyWallet({ children }: { children: ReactNode }) {
  return (
    <PrivyProvider
      appId={import.meta.env.VITE_PRIVY_APP_ID}
      config={{
        solana: { rpcs: signingRpcs },
        loginMethods: ['email'],
        appearance: { walletChainType: 'solana-only', theme: 'dark' },
        embeddedWallets: { solana: { createOnLogin: 'all-users' } },
      }}
    >
      <Bridge>{children}</Bridge>
    </PrivyProvider>
  )
}

function Bridge({ children }: { children: ReactNode }) {
  const { ready, authenticated, login, logout } = usePrivy()
  const { wallets, ready: walletsReady } = useWallets()
  const wallet = authenticated ? wallets[0] : undefined
  const { signMessage } = useSignMessage()
  const { signTransaction } = useSignTransaction()
  return (
    <WalletContext.Provider
      value={{
        ready: ready && (!authenticated || walletsReady),
        address: wallet?.address,
        login,
        logout: async () => {
          try {
            await gateRequest('sessions', undefined, 'DELETE')
          } finally {
            await logout()
          }
        },
        challenge: async (action) => {
          if (!wallet) throw new Error('Connect your Solana wallet first.')
          const ch = await gateRequest<{ challengeId: string; message: string; expiresAt: string }>(
            'challenges',
            { wallet: wallet.address, action },
          )
          const { signature } = await walletSignature(
            signMessage({ wallet, message: new TextEncoder().encode(ch.message) }),
            Math.min(90_000, Date.parse(ch.expiresAt) - Date.now()),
          )
          return { challengeId: ch.challengeId, signature: getBase58Decoder().decode(signature) }
        },
        send: async (encoded, onSigned) => {
          if (!wallet) throw new Error('Connect your Solana wallet first.')
          return submitWalletTransaction(
            encoded,
            wallet.address,
            async (transaction) => {
              const signed = await walletSignature(
                signTransaction({ wallet, transaction, chain: signingChain }),
                90_000,
              )
              return signed.signedTransaction
            },
            onSigned,
          )
        },
      }}
    >
      {children}
    </WalletContext.Provider>
  )
}
