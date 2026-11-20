// Surfpool demo only: approve every pending enrollment, run its issuance, then fund the
// trader once registered (test SOL for fees and a seeded ledger balance).
// Env: LM_NETWORK=surfpool LM_RPC_URL DB_PATH LM_KEYS_DIR SERVICE_URL (participant service).
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'

const run = promisify(execFile)
assert.equal(process.env.LM_NETWORK, 'surfpool', 'auto-approval is for the Surfpool demo only')
const rpc = process.env.LM_RPC_URL ?? 'http://127.0.0.1:8899'
const service = process.env.SERVICE_URL ?? 'http://127.0.0.1:8787'
const statePath = process.env.AUTO_OPERATOR_STATE ?? '.auto-operator.json'
const python = process.env.PYTHON ?? '.venv/bin/python'

const operator = async (...args) =>
  JSON.parse((await run('node', ['apps/attestation-service/src/operator-cli.ts', ...args], { env: process.env, maxBuffer: 1 << 22 })).stdout)

let state = { watching: [], funded: [] }
try {
  state = JSON.parse(await readFile(statePath, 'utf8'))
} catch {}
const save = () => writeFile(statePath, JSON.stringify(state))
const log = (event, extra) => console.log(JSON.stringify({ event, ...extra, at: new Date().toISOString() }))

async function airdrop(wallet, lamports) {
  const r = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'requestAirdrop', params: [wallet, lamports] }),
  })
  const body = await r.json()
  if (body.error) throw Error(body.error.message)
}

for (;;) {
  try {
    const { pending, open } = await operator('list')
    for (const req of pending) {
      const approved = await operator('approve', req.id, '--operator', 'surfpool-auto')
      log('approved', { request: req.id, wallet: req.wallet })
      // Registration needs fees and rent from the trader's own wallet.
      await airdrop(req.wallet, 2_000_000_000).catch((e) => log('airdrop-failed', { wallet: req.wallet, error: e.message }))
      await operator('run', approved.operationId).catch((e) => log('run-retry', { op: approved.operationId, error: e.message }))
      if (!state.watching.includes(req.wallet)) state.watching.push(req.wallet)
      await save()
    }
    for (const op of open) {
      if (op.status === 'failed' || op.step === 'await_registration') continue
      await operator('run', op.id).catch((e) => log('run-retry', { op: op.id, error: e.message }))
    }
    for (const wallet of state.watching) {
      if (state.funded.includes(wallet)) continue
      const report = await (await fetch(service + '/v1/wallets/' + wallet + '/eligibility')).json()
      if (!report.eligible) continue
      await run(python, ['scripts/seed-surfpool-balance.py', wallet], { env: process.env })
      state.funded.push(wallet)
      await save()
      log('funded', { wallet })
    }
  } catch (error) {
    log('loop-error', { error: error.message })
  }
  await delay(1500)
}
