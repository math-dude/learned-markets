// Read probes run by default. --write adds ten uniquely signed memo transactions.
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit'
import { loadSigner } from '@learned-markets/attestations'

const url = new URL(process.env.LM_RPC_URL ?? 'http://127.0.0.1:8899')
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  throw new Error('Expected a loopback Surfpool RPC or SSH tunnel.')
async function rpc(method, params = []) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(5000),
  })
  const result = await response.json()
  if (!response.ok || result.error) throw new Error(result.error?.message ?? response.statusText)
  return result.result
}
if (!(await rpc('getVersion'))['surfnet-version']) throw new Error('Expected a Surfpool validator.')
function stats(samples) {
  samples.sort((a, b) => a - b)
  const at = (q) => Math.round(samples[Math.ceil(q * samples.length) - 1])
  return { count: samples.length, p50_ms: at(0.5), p95_ms: at(0.95), max_ms: at(1) }
}
const reads = [],
  slots = []
for (let i = 0; i < 30; i++) {
  const start = performance.now()
  slots.push(await rpc('getSlot', [{ commitment: 'confirmed' }]))
  reads.push(performance.now() - start)
  await delay(75)
}
console.log(JSON.stringify({ confirmed_slot_reads: stats(reads), slots: [slots[0], slots.at(-1)] }))
if (slots.at(-1) <= slots[0]) throw new Error('Slot production stalled during the probe.')
if (process.argv.includes('--write')) {
  const payer = await loadSigner(process.env.LM_PROBE_KEY ?? 'keys/payer.json')
  const writes = []
  for (let i = 0; i < 10; i++) {
    const block = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value
    const tx = await signTransactionMessageWithSigners(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(payer, m),
        (m) =>
          setTransactionMessageLifetimeUsingBlockhash(
            { ...block, lastValidBlockHeight: BigInt(block.lastValidBlockHeight) },
            m,
          ),
        (m) =>
          appendTransactionMessageInstructions(
            [
              {
                programAddress: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
                data: new TextEncoder().encode('lm-health ' + randomUUID()),
              },
            ],
            m,
          ),
      ),
    )
    const expected = getSignatureFromTransaction(tx)
    const start = performance.now()
    const signature = await rpc('sendTransaction', [
      getBase64EncodedWireTransaction(tx),
      { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 0 },
    ])
    if (signature !== expected) throw new Error('Signature mismatch')
    while (true) {
      const status = (await rpc('getSignatureStatuses', [[signature]])).value[0]
      if (status?.err) throw new Error(JSON.stringify(status.err))
      if (['confirmed', 'finalized'].includes(status?.confirmationStatus)) break
      if (performance.now() - start > 12000) throw new Error('Unconfirmed signature ' + signature)
      await delay(100)
    }
    writes.push(performance.now() - start)
  }
  console.log(JSON.stringify({ submitted_to_confirmed: stats(writes) }))
}
