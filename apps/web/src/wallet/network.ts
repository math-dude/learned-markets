import {
  getBase64EncodedWireTransaction, getBase64Encoder, getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction, getTransactionDecoder, assertIsFullySignedTransaction, type Transaction,
} from '@solana/kit'
import { gateRequest } from './access'

const PROGRAM = 'nuX7BMKKWz9WG6EDRn5dXnSZArRW8uLkyKC5iTenqQz'

// Privy signs locally. The participant service submits the exact prepared message.
export async function submitWalletTransaction(encoded: string, wallet: string, sign: (tx: Uint8Array) => Promise<Uint8Array>, onSigned?: () => void) {
  const network = import.meta.env.VITE_LM_NETWORK || 'surfpool'
  const gate = await gateRequest<{ network: string; genesisHash: string }>('network')
  if (gate.network !== network || !['devnet', 'surfpool'].includes(network)) throw new Error('Gate network mismatch.')
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
  const receipt = await gateRequest<{ signature: string; commitment: string }>('wallet-transactions', {
    transactionBase64: getBase64EncodedWireTransaction(signed),
  })
  if (receipt.signature !== signature || receipt.commitment !== 'confirmed') throw new Error('Confirmation mismatch.')
  return signature
}
