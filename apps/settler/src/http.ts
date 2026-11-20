import { createServer, type IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { address, signature, type Address, type Rpc, type SolanaRpcApi } from '@solana/kit';
import { jsonWire } from '@learned-markets/client/settlement-v2';
import { transactionEvents } from './events.ts';
import type { Store } from './store.ts';

class HttpError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.status = status; }
}
async function body(req: IncomingMessage, limit: number) {
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const chunk of req) {
        n += chunk.length;
        if (n > limit) throw new HttpError(413, 'body too large');
        chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400,'invalid JSON'); }
}
export function server(options: { rpc: Rpc<SolanaRpcApi>; store: Store; markets: Address[];
    accept: (intent: Address, contents: string) => Promise<void>; token?: string }) {
    return createServer(async (req, res) => {
        try {
            const url = new URL(req.url ?? '/', 'http://localhost');
            let response: unknown;
            if (req.method === 'GET' && url.pathname === '/events') {
                const market = url.searchParams.get('market') ?? options.markets[0];
                if (!options.markets.some(m => m === market)) throw new HttpError(404,'unknown market');
                response = { market, events: options.store.events(address(market)) };
                res.setHeader('access-control-allow-origin','*');
            } else if (req.method === 'POST' && url.pathname === '/orders') {
                const payload = await body(req, 2048);
                if (!payload || typeof payload.intent !== 'string' || typeof payload.contents_hex !== 'string'
                    || !/^(?:[0-9a-fA-F]{2}){19,259}$/.test(payload.contents_hex)) throw new HttpError(400,'invalid order');
                let intent: Address;
                try { intent = address(payload.intent); } catch { throw new HttpError(400,'invalid intent address'); }
                await options.accept(intent, payload.contents_hex.toLowerCase());
                response = { intent, accepted: true };
            } else if (req.method === 'POST' && url.pathname === '/stream' && options.token) {
                const expected = Buffer.from('Bearer ' + options.token);
                const actual = Buffer.from(req.headers.authorization ?? '');
                if (actual.length !== expected.length || !timingSafeEqual(actual,expected)) throw new HttpError(401,'invalid webhook token');
                const payload = await body(req, 256_000);
                if (!Array.isArray(payload?.signatures) || payload.signatures.length > 2400) throw new HttpError(400,'invalid stream payload');
                for (const text of new Set<string>(payload.signatures)) {
                    const sig = signature(text);
                    const { slot, events } = await transactionEvents(options.rpc, sig, 'confirmed');
                    options.store.ingest(sig,slot,events);
                }
                response = { accepted: true };
            } else throw new HttpError(404,'unknown route');
            res.writeHead(200, {'content-type':'application/json'}).end(jsonWire(response));
        } catch (error) {
            const status = error instanceof HttpError ? error.status : 422;
            res.writeHead(status, {'content-type':'application/json'}).end(JSON.stringify({error:(error as Error).message}));
        }
    });
}
