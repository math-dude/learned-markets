// Run the paper auctioneer and Vite together. Either process exiting stops its sibling.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const port = process.env.LM_WEB_API_PORT || '8000'
const network = process.env.LM_NETWORK || 'surfpool'
if (!['surfpool', 'devnet'].includes(network)) throw new Error('LM_NETWORK must be surfpool or devnet.')
const rpc = process.env.LM_RPC_URL || (network === 'surfpool' ? 'http://127.0.0.1:8899' : 'https://api.devnet.solana.com')
const children = new Set()
let closing = false

function stop(code) {
  if (closing) return
  closing = true
  process.exitCode = code
  for (const child of children) child.kill('SIGTERM')
}

function start(bin, args, cwd, env) {
  const child = spawn(bin, args, { cwd, env, stdio: 'inherit' })
  children.add(child)
  child.once('error', error => { console.error(error.message); stop(1) })
  child.once('exit', (code, signal) => {
    children.delete(child)
    stop(code ?? (signal === 'SIGTERM' ? 0 : 1))
  })
}

process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))
const args = process.argv.slice(2)
const requestedPort = args.indexOf('--port')
const uiPort = requestedPort >= 0 ? args[requestedPort + 1] : '5173'
if (process.env.LM_PAPER_SANDBOX !== '1' && !process.env.LM_ATTESTATION_URL) {
  start(process.execPath, ['apps/attestation-service/src/main.ts'], root, {
    ...process.env, LM_NETWORK: network, LM_RPC_URL: rpc, DB_PATH: process.env.DB_PATH || 'attestation-' + network + '.sqlite', HOST: '127.0.0.1', PORT: '8787',
    SERVICE_ORIGIN: process.env.SERVICE_ORIGIN || 'http://localhost:' + uiPort,
  })
}
start('uv', ['run', '--locked', '--package', 'learned-markets-backend', 'uvicorn',
  'learned_markets_backend.web:app', '--host', '127.0.0.1', '--port', port], root, process.env)
start(process.execPath, [fileURLToPath(new URL('./bin/vite.js', import.meta.resolve('vite/package.json'))), '--strictPort', ...args],
  root + 'apps/web', { ...process.env, VITE_LM_NETWORK: network, LM_WEB_API: 'http://127.0.0.1:' + port })
