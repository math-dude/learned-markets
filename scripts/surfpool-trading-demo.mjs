// Bounded wallet-to-ledger smoke run through the same HTTP APIs as the web client.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import {
  getBase64Encoder,
  getTransactionDecoder,
  signTransaction,
  getBase64EncodedWireTransaction,
} from '@solana/kit'
import { loadSigner } from '@learned-markets/attestations'
import { demoClient } from './market-demo.ts'

const service = process.env.SERVICE_URL
if (
  process.env.LM_NETWORK !== 'surfpool' ||
  !service ||
  !['localhost', '127.0.0.1', '[::1]'].includes(new URL(service).hostname) ||
  (await (await fetch(service + '/v1/network')).json()).network !== 'surfpool'
)
  throw Error('Expected Surfpool')
const endpoint = new URL(process.env.LM_RPC_URL)
const version = await fetch(endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getVersion' }),
})
if (!(await version.json()).result?.['surfnet-version']) throw Error('Expected a Surfpool RPC')
await mkdir('keys/market-demo/surfpool', { recursive: true, mode: 0o700 })
const payer = await loadSigner('keys/payer.json')
const actors = {
  finch: { wallet: 'lunar-finch', name: 'Lunar Finch', ticker: 'FINCH' },
  gecko: { wallet: 'velvet-gecko', name: 'Velvet Gecko', ticker: 'GECKO' },
  comet: { wallet: 'night-comet', name: 'Night Comet', ticker: 'COMET' },
}
const actor = actors[process.argv[2] ?? 'finch']
if (!actor || !Object.hasOwn(actor, 'wallet')) throw Error('Choose finch, gecko, or comet')
const client = await demoClient(actor.wallet, payer)
const state = () => client.ok('GET', '/api/chain?wallet=' + client.wallet.address)
async function relay(tx) {
  const signed = await signTransaction(
    [client.wallet.keyPair],
    getTransactionDecoder().decode(getBase64Encoder().encode(tx.transactionBase64)),
  )
  return client.ok('POST', '/v1/wallet-transactions', {
    transactionBase64: getBase64EncodedWireTransaction(signed),
  })
}
let s = await state()
if (s.account.cash === null)
  execFileSync('.venv/bin/python', ['scripts/seed-surfpool-balance.py', client.wallet.address], {
    stdio: 'inherit',
  })
let market = s.markets.find((m) => m.name === actor.name && m.ticker === actor.ticker)?.address
if (!market) {
  const launch = await client.ok('POST', '/api/chain/launch', { name: actor.name, ticker: actor.ticker })
  console.log('launch', await relay(launch))
  market = launch.market
}
for (const [side, quantity, price] of [
  ['buy', '100000', '90000000'],
  ['sell', '20000', '1'],
]) {
  s = await state()
  const before = BigInt(s.account.positions[market] ?? '0')
  const tx = await client.ok('POST', '/v1/intents/prepare', {
    kind: 'trade',
    target: market,
    trade: { side, points: [{ price, quantity }] },
  })
  console.log(side, 'signed intent', await relay(tx))
  await client.ok('POST', '/v1/intents/admit', {
    intent: tx.intent,
    expectedTarget: market,
    expectedKind: 'trade',
  })
  let receipt
  for (let i = 0; i < 65; i++) {
    await delay(1000)
    s = await state()
    receipt = s.account.orders.find((r) => r.intent === tx.intent)
    if (receipt && !['queued', 'confirming'].includes(receipt.status)) break
  }
  assert.equal(receipt?.status, 'filled', JSON.stringify(receipt))
  const fill = BigInt(JSON.parse(receipt.details).quantity)
  assert.equal(BigInt(s.account.positions[market]), before + (side === 'buy' ? fill : -fill))
  console.log(
    side,
    'confirmed',
    receipt.signature,
    'quantity',
    fill.toString(),
    'position',
    s.account.positions[market],
    'cash',
    s.account.cash,
  )
}
