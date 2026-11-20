import { serve } from '@hono/node-server';
import { createSolanaRpc } from '@solana/kit';
import { createApp } from './app.ts';
import { RpcChain } from './chain.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';

const config = loadConfig();
const db = openDb(config.dbPath);
const app = createApp({ db, chain: new RpcChain(createSolanaRpc(config.rpcUrl)), config });
serve({ fetch: app.fetch, port: config.port, hostname: process.env.HOST }, info => {
    console.log(`attestation-service listening on :${info.port} (origin ${config.origin})`);
});
