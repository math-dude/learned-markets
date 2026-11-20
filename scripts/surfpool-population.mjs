// Bounded, repeatable activity from dedicated signed test wallets on Surfpool.
import assert from 'node:assert/strict'
import { open, readFile, unlink } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { loadSigner } from '@learned-markets/attestations'
import {
  getBase64Encoder,
  getTransactionDecoder,
  signTransaction,
  getBase64EncodedWireTransaction,
} from '@solana/kit'
import { demoClient } from './market-demo.ts'

const service = new URL(process.env.SERVICE_URL)
service.pathname = '/'
assert.equal(process.env.LM_NETWORK, 'surfpool')
assert.ok(['localhost', '127.0.0.1'].includes(service.hostname))
assert.equal((await (await fetch(service + 'v1/network')).json()).network, 'surfpool')
const version = await (
  await fetch(process.env.LM_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getVersion' }),
  })
).json()
assert.ok(version.result?.['surfnet-version'])
const continuous = process.argv[2] === '--continuous'
const rounds = continuous ? Infinity : Number(process.argv[2] ?? 12)
assert.ok(continuous || (Number.isInteger(rounds) && rounds > 0 && rounds <= 120))
const lockPath = '/tmp/learned-markets-surfpool-population.lock'
try {
  const pid = Number(await readFile(lockPath, 'utf8'))
  try {
    process.kill(pid, 0)
    throw Error('Population already running as ' + pid)
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
  await unlink(lockPath)
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
const lock = await open(lockPath, 'wx', 0o600)
await lock.writeFile(String(process.pid))
await lock.close()
process.on('exit', () => {
  try {
    execFileSync('unlink', [lockPath])
  } catch {}
})
const payer = await loadSigner('keys/payer.json')
const names = [
  ['Lunar Finch', 'FINCH'],
  ['Velvet Gecko', 'GECKO'],
  ['Night Comet', 'COMET'],
  ['Disco Otter', 'OTTER'],
  ['Solar Moth', 'MOTH'],
  ['Neon Reef', 'REEF'],
]
async function relay(client, prepared) {
  const tx = await signTransaction(
    [client.wallet.keyPair],
    getTransactionDecoder().decode(getBase64Encoder().encode(prepared.transactionBase64)),
  )
  return client.ok('POST', '/v1/wallet-transactions', {
    transactionBase64: getBase64EncodedWireTransaction(tx),
  })
}
async function readState(client) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await client.ok('GET', '/api/chain?wallet=' + client.wallet.address)
    } catch (error) {
      if (attempt === 5) throw error
      await delay(1000 * (attempt + 1))
    }
  }
}
const actors = []
for (let i = 0; i < 12; i++) {
  const client = await demoClient('population-' + String(i).padStart(2, '0'), payer)
  let state = await readState(client)
  if (state.account.cash === null)
    execFileSync('.venv/bin/python', ['scripts/seed-surfpool-balance.py', client.wallet.address], {
      stdio: 'pipe',
      env: process.env,
    })
  const [name, ticker] = names[i % names.length]
  let market = state.markets.find((m) => m.ticker === ticker && m.live)?.address
  if (!market) {
    const uniqueName = state.markets.some((m) => m.ticker === ticker)
      ? name + ' ' + Date.now().toString(36)
      : name
    const prepared = await client.ok('POST', '/api/chain/launch', { name: uniqueName, ticker })
    await relay(client, prepared)
    market = prepared.market
  }
  actors.push({ client, market, ticker })
  console.log(JSON.stringify({ event: 'ready', actor: i, wallet: client.wallet.address, ticker }))
}
let confirmed = 0
let stopping = false
process.on('SIGTERM', () => {
  stopping = true
})
process.on('SIGINT', () => {
  stopping = true
})
for (let round = 0; round < rounds && !stopping; round++) {
  // One actor per market per wave keeps newly initialized positions within the
  // existing transaction packet budget. Every wave waits for actual receipts.
  if (round && round % 30 === 0) {
    for (const actor of actors)
      await actor.client.ok('POST', '/v1/sessions', await actor.client.signedChallenge('session'))
  }
  const wave = actors.slice((round % 2) * 6, (round % 2) * 6 + 6)
  const results = await Promise.allSettled(
    wave.map(async (actor, i) => {
      const { client, ticker } = actor
      let { market } = actor
      let state = await readState(client)
      if (BigInt(state.account.cash ?? '0') < 200000000n) {
        execFileSync(
          '.venv/bin/python',
          ['scripts/seed-surfpool-balance.py', client.wallet.address, '--refill'],
          { stdio: 'pipe', env: process.env },
        )
        state = await readState(client)
        console.log(JSON.stringify({ event: 'test-refill', wallet: client.wallet.address }))
      }
      if (!state.markets.find((m) => m.address === market)?.live) {
        const replacement = state.markets.find((m) => m.ticker === ticker && m.live)
        if (replacement) market = replacement.address
        else {
          const name = names.find((n) => n[1] === ticker)[0] + ' ' + Date.now().toString(36)
          const launch = await client.ok('POST', '/api/chain/launch', { name, ticker })
          await relay(client, launch)
          market = launch.market
          console.log(JSON.stringify({ event: 'launch', ticker, market }))
        }
        actor.market = market
      }
      const before = BigInt(state.account.positions[market] ?? '0')
      const cash = BigInt(state.account.cash ?? '0')
      const side = before > 220000n && ((round + i) % 3 !== 0 || cash < 100000000n) ? 'sell' : 'buy'
      assert.ok(side === 'sell' || cash > 5000000n, 'Actor needs test funding')
      const quantity =
        side === 'sell' ? String(before / 2n) : String(220000 + ((round * 7919 + i * 13513) % 180000))
      const prepared = await client.ok('POST', '/v1/intents/prepare', {
        kind: 'trade',
        target: market,
        trade: { side, points: [{ price: side === 'buy' ? '90000000' : '1', quantity }] },
      })
      await relay(client, prepared)
      await client.ok('POST', '/v1/intents/admit', {
        intent: prepared.intent,
        expectedTarget: market,
        expectedKind: 'trade',
      })
      for (let poll = 0; poll < 80; poll++) {
        await delay(1000)
        const next = await readState(client)
        const receipt = next.account.orders.find((o) => o.intent === prepared.intent)
        if (!receipt || ['queued', 'confirming'].includes(receipt.status)) continue
        if (
          receipt.status === 'unfilled' ||
          (receipt.status === 'closed' && !next.markets.find((m) => m.address === market)?.live)
        ) {
          console.log(JSON.stringify({ event: 'unfilled', round, ticker, reason: receipt.details }))
          return
        }
        assert.equal(receipt.status, 'filled', JSON.stringify(receipt))
        const fill = BigInt(JSON.parse(receipt.details).quantity)
        assert.equal(BigInt(next.account.positions[market]), before + (side === 'buy' ? fill : -fill))
        confirmed++
        console.log(
          JSON.stringify({
            event: 'fill',
            round,
            ticker,
            side,
            quantity: String(fill),
            signature: receipt.signature,
          }),
        )
        return
      }
      throw Error('Settlement timeout for ' + ticker)
    }),
  )
  const failed = results.filter((r) => r.status === 'rejected')
  if (failed.length)
    throw new AggregateError(
      failed.map((r) => r.reason),
      'Population stopped after a failed wave',
    )
}
console.log(JSON.stringify({ event: 'complete', wallets: actors.length, rounds, confirmed }))
