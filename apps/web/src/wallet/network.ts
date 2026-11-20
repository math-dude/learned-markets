import {
  createSolanaRpc, getBase64EncodedWireTransaction, getBase64Encoder, getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction, getTransactionDecoder, assertIsFullySignedTransaction, type Transaction,
} from '@solana/kit'
import { gateRequest } from './access'

const PROGRAM = 'nuX7BMKKWz9WG6EDRn5dXnSZArRW8uLkyKC5iTenqQz'
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'

// Privy signs only. The same RPC used here for cluster verification receives the signed bytes.
export async function submitWalletTransaction(encoded: string, wallet: string, sign: (tx: Uint8Array) => Promise<Uint8Array>, onSigned?: () => void) {
  const network = import.meta.env.VITE_LM_NETWORK || 'surfpool'
  const gate = await gateRequest<{ network: string; genesisHash: string }>('network')
  if (gate.network !== network || !['devnet', 'surfpool'].includes(network)) throw new Error('Gate network mismatch.')
  const url = network === 'surfpool'
    ? new URL(import.meta.env.VITE_SURFPOOL_RPC_URL || 'http://127.0.0.1:8899')
    : new URL(import.meta.env.VITE_SOLANA_DEVNET_RPC || 'https://api.devnet.solana.com')
  if (network === 'surfpool' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error('Surfpool requires a loopback RPC. Use a local tunnel for a remote Surfpool.')
  if (network === 'surfpool') {
    const response = await fetch(url, {
      method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getVersion' }),
    })
    const info = await response.json()
    if (!response.ok || typeof info.result?.['surfnet-version'] !== 'string')
      throw new Error('The local RPC did not identify itself as Surfpool.')
  }
  const rpc = createSolanaRpc(url.href)
  const genesis = await rpc.getGenesisHash().send()
  if (genesis !== gate.genesisHash || (network === 'devnet' && genesis !== DEVNET_GENESIS))
    throw new Error('Wallet RPC and attestation gate identify different Solana clusters.')
  const bytes = new Uint8Array(getBase64Encoder().encode(encoded))
  const decoder = getTransactionDecoder()
  const prepared = decoder.decode(bytes)
  const msg = getCompiledTransactionMessageDecoder().decode(prepared.messageBytes)
  if (!('instructions' in msg) || msg.staticAccounts[0] !== wallet || msg.instructions.length !== 1 ||
      msg.staticAccounts[msg.instructions[0].programAddressIndex] !== PROGRAM)
    throw new Error('Transaction does not match the wallet and participant program.')
  const signed: Transaction = decoder.decode(await sign(bytes))
  if (signed.messageBytes.length !== prepared.messageBytes.length ||
      !signed.messageBytes.every((byte, i) => byte === prepared.messageBytes[i]))
    throw new Error('Wallet returned a different transaction message.')
  assertIsFullySignedTransaction(signed)
  const signature = getSignatureFromTransaction(signed)
  onSigned?.()
  const rpcSignature = await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), {
    encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 0n,
  }).send()
  if (rpcSignature !== signature) throw new Error('RPC signature mismatch.')
  for (let i = 0; i < 45; i++) {
    const status = (await rpc.getSignatureStatuses([signature]).send()).value[0]
    if (status?.err) throw new Error('Solana rejected transaction ' + signature)
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return signature
    await new Promise(resolve => setTimeout(resolve, 600))
  }
  throw new Error('Confirmation is pending for ' + signature + '. Check the transaction before signing again.')
}
